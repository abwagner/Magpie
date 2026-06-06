// ── Alert Router (QF-61) ──────────────────────────────────────────
//
// Receives alert events, matches them against rules loaded from
// `config/alerts.yaml`, and fans them out to channels (log, internal
// WS, Slack webhook). The system has emitted `alert` WS messages and
// structured logs for a while; what was missing was the routing
// layer that fans them out to operator channels. This is that layer.
//
// Scope of v1:
//   - Rule matching on `type_prefix` and `level`.
//   - Channels: log, internal (WS push via the existing pushAlert
//     helper), slack (webhook).
//   - Recent-alerts ring buffer for the Settings screen.
//   - Producer wiring is via `router.record(event)` — callers in the
//     order plane / portfolio engine / risk store will call this
//     once the alert sources are migrated. Until then, the screen
//     surface + the `POST /api/alerts/test` endpoint give operators
//     end-to-end visibility.
//
// Deferred: mute rules (TTL'd suppressions), email + Discord
// channels, alert-deduplication windows.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import yaml from "yaml";
import type { Logger } from "../logger.js";
import { postToSlack } from "./channels/slack.js";

export type AlertLevel = "info" | "warning" | "critical";
export type AlertChannel = "log" | "internal" | "slack";

export interface AlertEvent {
  ts: string;
  type: string;
  level: AlertLevel;
  message: string;
  payload?: Record<string, unknown>;
}

export interface AlertRule {
  id: string;
  /** Description shown in the UI. */
  description?: string;
  match: {
    /** Match events whose type starts with this string. Empty = match all. */
    type_prefix?: string;
    /** Match events whose level is in this set. Empty = match all levels. */
    levels?: AlertLevel[];
  };
  channels: AlertChannel[];
}

export interface AlertsConfig {
  version: 1;
  rules: AlertRule[];
}

const EMPTY: AlertsConfig = { version: 1, rules: [] };
const RECENT_RING = 200;
const LEVEL_RANK: Record<AlertLevel, number> = { info: 0, warning: 1, critical: 2 };

class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "AlertsValidationError";
  }
}

function validRule(input: unknown, idx: number): AlertRule {
  if (!input || typeof input !== "object") {
    throw new ValidationError(`rules[${idx}]: expected an object`);
  }
  const o = input as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim() === "") {
    throw new ValidationError(`rules[${idx}]: id is required`);
  }
  const m = o.match;
  if (!m || typeof m !== "object") {
    throw new ValidationError(`rules[${idx}]: match is required`);
  }
  const matchObj = m as Record<string, unknown>;
  const match: AlertRule["match"] = {};
  if (matchObj.type_prefix !== undefined) {
    if (typeof matchObj.type_prefix !== "string") {
      throw new ValidationError(`rules[${idx}].match.type_prefix: must be a string`);
    }
    match.type_prefix = matchObj.type_prefix;
  }
  if (matchObj.levels !== undefined) {
    if (!Array.isArray(matchObj.levels)) {
      throw new ValidationError(`rules[${idx}].match.levels: must be an array`);
    }
    for (const lvl of matchObj.levels) {
      if (lvl !== "info" && lvl !== "warning" && lvl !== "critical") {
        throw new ValidationError(`rules[${idx}].match.levels: must contain info|warning|critical`);
      }
    }
    match.levels = matchObj.levels as AlertLevel[];
  }
  if (!Array.isArray(o.channels) || o.channels.length === 0) {
    throw new ValidationError(`rules[${idx}].channels: non-empty array required`);
  }
  for (const c of o.channels) {
    if (c !== "log" && c !== "internal" && c !== "slack") {
      throw new ValidationError(
        `rules[${idx}].channels: must contain log|internal|slack, got ${String(c)}`,
      );
    }
  }
  const out: AlertRule = {
    id: o.id.trim(),
    match,
    channels: o.channels as AlertChannel[],
  };
  if (typeof o.description === "string") out.description = o.description;
  return out;
}

function normalize(raw: unknown): AlertsConfig {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Partial<AlertsConfig>;
  if (r.version !== undefined && r.version !== 1) {
    throw new ValidationError(`unsupported version ${String(r.version)}`);
  }
  const rules = Array.isArray(r.rules) ? r.rules.map((rule, i) => validRule(rule, i)) : [];
  return { version: 1, rules };
}

function matchesRule(event: AlertEvent, rule: AlertRule): boolean {
  if (rule.match.type_prefix && !event.type.startsWith(rule.match.type_prefix)) {
    return false;
  }
  if (rule.match.levels && rule.match.levels.length > 0) {
    if (!rule.match.levels.includes(event.level)) return false;
  }
  return true;
}

export interface AlertRouterOpts {
  yamlPath: string;
  logger: Logger;
  /** Optional internal sink — usually `stateWs?.pushAlert.bind(stateWs)`. */
  internalSink?: (alert: {
    type: string;
    message: string;
    level?: "info" | "warning" | "critical";
    ts?: string;
    payload?: Record<string, unknown>;
  }) => void;
  /** Slack webhook URL; resolved at call time so .env edits surface
   *  without restart. Pass `() => process.env.SLACK_WEBHOOK_URL`. */
  slackWebhookUrl?: () => string | undefined;
}

export interface AlertRouter {
  load(): Promise<void>;
  get(): AlertsConfig;
  replace(rules: AlertRule[]): Promise<AlertsConfig>;
  /** Wire the internal-channel sink after construction (stateWs lives
   *  downstream in the boot order). */
  setInternalSink(
    sink: (alert: {
      type: string;
      message: string;
      level?: "info" | "warning" | "critical";
      ts?: string;
      payload?: Record<string, unknown>;
    }) => void,
  ): void;
  /**
   * Record an alert + dispatch to matching channels. Producers (order
   * plane, risk engine, etc.) call this; results are also visible via
   * `recent()` and the WS broadcast (when internal sink is wired).
   */
  record(event: Omit<AlertEvent, "ts"> & { ts?: string }): Promise<AlertEvent>;
  recent(limit?: number): AlertEvent[];
}

export function createAlertRouter(opts: AlertRouterOpts): AlertRouter {
  const { yamlPath, logger, slackWebhookUrl } = opts;
  let internalSink:
    | ((alert: {
        type: string;
        message: string;
        level?: "info" | "warning" | "critical";
        ts?: string;
        payload?: Record<string, unknown>;
      }) => void)
    | undefined = opts.internalSink;
  let cfg: AlertsConfig = EMPTY;
  const ring: AlertEvent[] = [];

  async function persist(): Promise<void> {
    await fs.mkdir(dirname(yamlPath), { recursive: true });
    const content = yaml.stringify(cfg, { sortMapEntries: false });
    const tmp = `${yamlPath}.tmp`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, yamlPath);
  }

  async function dispatch(event: AlertEvent, channels: AlertChannel[]): Promise<void> {
    // De-dupe channels (a rule shouldn't fire the same channel twice
    // even if it lists it twice). De-duplication across multiple
    // matching rules is intentional: each rule is independent.
    const seen = new Set<AlertChannel>();
    for (const channel of channels) {
      if (seen.has(channel)) continue;
      seen.add(channel);
      switch (channel) {
        case "log":
          // Map alert level → logger level. Critical → error so it
          // surfaces in the standard ops view.
          if (event.level === "critical") {
            logger.error("alert", { event });
          } else if (event.level === "warning") {
            logger.warn("alert", { event });
          } else {
            logger.info("alert", { event });
          }
          break;
        case "internal":
          // QF-228 — pass the full event so the GUI can render
          // payload-driven banners (quote_unavailable etc.).
          internalSink?.({
            type: event.type,
            message: event.message,
            level: event.level,
            ts: event.ts,
            ...(event.payload ? { payload: event.payload } : {}),
          });
          break;
        case "slack": {
          const url = slackWebhookUrl?.();
          if (!url) {
            logger.warn("alert: slack channel selected but SLACK_WEBHOOK_URL not set", {
              event_type: event.type,
            });
            break;
          }
          try {
            await postToSlack(url, event);
          } catch (e) {
            logger.warn("alert: slack post failed", {
              error: e instanceof Error ? e.message : String(e),
              event_type: event.type,
            });
          }
          break;
        }
      }
    }
  }

  return {
    setInternalSink(sink): void {
      internalSink = sink;
    },

    async load(): Promise<void> {
      try {
        const raw = await fs.readFile(yamlPath, "utf8");
        cfg = normalize(yaml.parse(raw));
        logger.info("alerts config loaded", { path: yamlPath, rules: cfg.rules.length });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw err;
        cfg = EMPTY;
        logger.info("alerts config missing — starting empty", { path: yamlPath });
      }
    },

    get(): AlertsConfig {
      return cfg;
    },

    async replace(rules: AlertRule[]): Promise<AlertsConfig> {
      // Re-normalise via the unknown-input path so the same validation
      // covers PUTs as covers YAML loads.
      cfg = normalize({ version: 1, rules });
      await persist();
      logger.info("alerts rules updated", { rules: cfg.rules.length });
      return cfg;
    },

    async record(input): Promise<AlertEvent> {
      const event: AlertEvent = {
        ts: input.ts ?? new Date().toISOString(),
        type: input.type,
        level: input.level,
        message: input.message,
        ...(input.payload ? { payload: input.payload } : {}),
      };
      // Append to ring (oldest first, newest last — drop oldest when full).
      if (ring.length >= RECENT_RING) ring.shift();
      ring.push(event);

      // Union channels across all matching rules. If nothing matches,
      // still log at the appropriate level so the alert isn't silent.
      const matched = cfg.rules.filter((r) => matchesRule(event, r));
      if (matched.length === 0) {
        await dispatch(event, ["log"]);
        return event;
      }
      const channels: AlertChannel[] = matched.flatMap((r) => r.channels);
      await dispatch(event, channels);
      return event;
    },

    recent(limit = 50): AlertEvent[] {
      const safe = Math.max(1, Math.min(RECENT_RING, Math.floor(limit)));
      return ring.slice(-safe).reverse();
    },
  };
}

// Useful for callers that want the rank-comparison without re-importing.
export function levelAtLeast(level: AlertLevel, threshold: AlertLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}
