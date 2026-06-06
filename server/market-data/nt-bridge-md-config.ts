// ── nt-bridge-md config loader ─────────────────────────────────────
// Reads the `nt_bridge` block of config/market-data.json. The schema
// is intentionally narrow — operator typos shouldn't silently disable
// a broker they meant to enable. Mirrors the QF-242 brokers-config.ts
// pattern for the order side.
//
// Defined in: docs/tdd/broker-integration.md §6 — this is the runtime
// config block that gates the conditional nt-bridge-md adapter wiring
// in server/index.ts.
//
// QF-255 (M13-07).

import type { Logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────

export type NtBridgeMdMode = "observe" | "first" | "only";

export type NtBridgeMdBroker = "schwab" | "ibkr";

export interface NtBridgeMdTimeouts {
  quote_ms?: number;
  expirations_ms?: number;
  chain_ms?: number;
  historical_chain_ms?: number;
  candles_ms?: number;
}

export interface NtBridgeMdConfig {
  enabled: boolean;
  brokers: readonly NtBridgeMdBroker[];
  mode: NtBridgeMdMode;
  timeouts?: NtBridgeMdTimeouts;
  heartbeat_stale_ms?: number;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: NtBridgeMdConfig = Object.freeze({
  enabled: false,
  brokers: Object.freeze([] as readonly NtBridgeMdBroker[]),
  mode: "observe",
}) as NtBridgeMdConfig;

const KNOWN_MODES: ReadonlySet<NtBridgeMdMode> = new Set<NtBridgeMdMode>([
  "observe",
  "first",
  "only",
]);

const KNOWN_BROKERS: ReadonlySet<NtBridgeMdBroker> = new Set<NtBridgeMdBroker>(["schwab", "ibkr"]);

const KNOWN_TIMEOUT_FIELDS: ReadonlySet<keyof NtBridgeMdTimeouts> = new Set<
  keyof NtBridgeMdTimeouts
>(["quote_ms", "expirations_ms", "chain_ms", "historical_chain_ms", "candles_ms"]);

const KNOWN_TOP_FIELDS = new Set(["enabled", "brokers", "mode", "timeouts", "heartbeat_stale_ms"]);

// ── Loader ────────────────────────────────────────────────────────

export class NtBridgeMdConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NtBridgeMdConfigError";
  }
}

/**
 * Parse the `nt_bridge` sub-block of a parsed `config/market-data.json`.
 *
 * Missing block or `enabled=false` → defaults (no nt-bridge-md adapter
 * constructed at boot). Malformed block → throw — we'd rather refuse to
 * start than guess what the operator meant to enable.
 *
 * Validation is strict: unknown top-level fields throw (typo-guard);
 * unknown brokers throw; unknown modes throw; unknown timeout fields
 * throw. Forward-compat would be wrong here because adding a typo'd
 * broker silently disables the operator's intended wiring.
 */
export function parseNtBridgeMdConfig(raw: unknown, logger: Logger): NtBridgeMdConfig {
  if (raw === undefined || raw === null) {
    logger.info("market-data.json: nt_bridge block missing; using defaults (disabled)");
    return DEFAULT_CONFIG;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new NtBridgeMdConfigError("market-data.json: nt_bridge must be an object");
  }
  const obj = raw as Record<string, unknown>;

  // Typo guard on top-level field set.
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_FIELDS.has(key)) {
      throw new NtBridgeMdConfigError(`market-data.json: nt_bridge: unknown field "${key}"`);
    }
  }

  const enabled = parseBoolean(obj.enabled, "nt_bridge.enabled", false);
  const brokers = parseBrokers(obj.brokers);
  const mode = parseMode(obj.mode);
  const timeouts = parseTimeouts(obj.timeouts);
  const heartbeat_stale_ms =
    obj.heartbeat_stale_ms === undefined
      ? undefined
      : parsePositiveNumber(obj.heartbeat_stale_ms, "nt_bridge.heartbeat_stale_ms");

  if (enabled && brokers.length === 0) {
    throw new NtBridgeMdConfigError(
      "market-data.json: nt_bridge.enabled=true but brokers list is empty",
    );
  }

  const out: NtBridgeMdConfig = {
    enabled,
    brokers,
    mode,
    ...(timeouts ? { timeouts } : {}),
    ...(heartbeat_stale_ms !== undefined ? { heartbeat_stale_ms } : {}),
  };
  return out;
}

function parseBoolean(v: unknown, name: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") {
    throw new NtBridgeMdConfigError(`market-data.json: ${name} must be a boolean`);
  }
  return v;
}

function parseBrokers(v: unknown): readonly NtBridgeMdBroker[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new NtBridgeMdConfigError("market-data.json: nt_bridge.brokers must be an array");
  }
  const seen = new Set<NtBridgeMdBroker>();
  for (const item of v) {
    if (typeof item !== "string" || !KNOWN_BROKERS.has(item as NtBridgeMdBroker)) {
      throw new NtBridgeMdConfigError(
        `market-data.json: nt_bridge.brokers entry must be one of ${[...KNOWN_BROKERS].join(", ")} (got ${JSON.stringify(item)})`,
      );
    }
    seen.add(item as NtBridgeMdBroker);
  }
  return [...seen];
}

function parseMode(v: unknown): NtBridgeMdMode {
  if (v === undefined) return "observe";
  if (typeof v !== "string" || !KNOWN_MODES.has(v as NtBridgeMdMode)) {
    throw new NtBridgeMdConfigError(
      `market-data.json: nt_bridge.mode must be one of ${[...KNOWN_MODES].join(", ")} (got ${JSON.stringify(v)})`,
    );
  }
  return v as NtBridgeMdMode;
}

function parseTimeouts(v: unknown): NtBridgeMdTimeouts | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new NtBridgeMdConfigError("market-data.json: nt_bridge.timeouts must be an object");
  }
  const obj = v as Record<string, unknown>;
  const out: NtBridgeMdTimeouts = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!KNOWN_TIMEOUT_FIELDS.has(key as keyof NtBridgeMdTimeouts)) {
      throw new NtBridgeMdConfigError(
        `market-data.json: nt_bridge.timeouts: unknown field "${key}"`,
      );
    }
    out[key as keyof NtBridgeMdTimeouts] = parsePositiveNumber(val, `nt_bridge.timeouts.${key}`);
  }
  return out;
}

function parsePositiveNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new NtBridgeMdConfigError(`market-data.json: ${name} must be a positive number`);
  }
  return v;
}
