// ── Freshness Monitor (QF-295) ────────────────────────────────────
//
// Periodic cron tick (~5 min) that walks computeFreshness() and fires
// ingest.stale.<source> / ingest.recovered.<source> alerts via the
// alert router.
//
// Per-source dedup: only fires ingest.stale when a source transitions
// from fresh → stale/missing. Suppresses re-fires while continuously
// stale. Fires ingest.recovered when a source transitions back to fresh
// after having been stale/missing.
//
// Cold start: the in-memory state map starts empty. The first tick fires
// ingest.stale for every source currently stale/missing (desired — the
// operator wants to know on cold start).
//
// Contract: docs/data/data-plane.md §5, docs/tdd/alerts.md §7.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type { AlertRouter } from "../alerts/router.js";
import type { DataPlaneConfig } from "./freshness.js";
import type { FreshnessStatus } from "../../src/types/catalog.js";
import { computeFreshness } from "./freshness.js";

// ── Types ─────────────────────────────────────────────────────────

export interface FreshnessMonitorDeps {
  db: Database;
  config: DataPlaneConfig;
  alertRouter: AlertRouter;
  logger: Logger;
  /** Override Date.now() for testing. */
  nowMs?: () => number;
}

export interface FreshnessMonitor {
  /** Run one evaluation pass. Exposed for testing and for the scheduler. */
  tick(): Promise<void>;
  /** Start the periodic setInterval. Returns a stop function. */
  start(intervalMs?: number): () => void;
}

// ── Stale-state map entry ─────────────────────────────────────────

type AlertedStatus = "stale" | "missing";

interface SourceState {
  /** Last alerted status — null means the source was fresh last tick. */
  alerted: AlertedStatus | null;
}

// ── Default interval ──────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Factory ───────────────────────────────────────────────────────

export function createFreshnessMonitor(deps: FreshnessMonitorDeps): FreshnessMonitor {
  const { db, config, alertRouter, logger } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());

  // Keyed by source slug. Absent = never seen (treated as fresh prior).
  const stateMap = new Map<string, SourceState>();

  async function tick(): Promise<void> {
    const sources = await computeFreshness(db, config, nowMs());

    for (const row of sources) {
      const { source, status, age_hours, expected_cadence_hours, last_success_at, data_through } =
        row;

      const prior = stateMap.get(source) ?? { alerted: null };

      if (status === "fresh") {
        if (prior.alerted !== null) {
          // Recovered — was stale/missing, now fresh.
          stateMap.set(source, { alerted: null });
          await alertRouter.record({
            type: `ingest.recovered.${source}`,
            level: "info",
            message: `${source} ingest recovered (age ${age_hours !== null ? age_hours.toFixed(1) : "?"} h, cadence ${expected_cadence_hours ?? "?"}h)`,
            payload: {
              source,
              age_hours: age_hours ?? null,
              expected_cadence_hours: expected_cadence_hours ?? null,
              last_success_at: last_success_at ?? null,
              data_through: data_through ?? null,
            },
          });
        }
        // else: was fresh, still fresh — no event.
        continue;
      }

      // status is "stale" or "missing".
      const alertedStatus: AlertedStatus = status;

      if (prior.alerted !== null) {
        // Already alerted (stale or missing) — suppress re-fire.
        // Update to latest severity but do not emit again.
        stateMap.set(source, { alerted: alertedStatus });
        continue;
      }

      // Transition: fresh (or unseen) → stale/missing. Fire.
      stateMap.set(source, { alerted: alertedStatus });

      const ageHoursRounded = age_hours !== null ? parseFloat(age_hours.toFixed(1)) : null;
      const message =
        `${source} ingest is ${ageHoursRounded !== null ? `${ageHoursRounded} hours ` : ""}stale` +
        ` (cadence ${expected_cadence_hours ?? "?"}h)`;

      await alertRouter.record({
        type: `ingest.stale.${source}`,
        level: "warning",
        message,
        payload: {
          source,
          age_hours: ageHoursRounded,
          expected_cadence_hours: expected_cadence_hours ?? null,
          last_success_at: last_success_at ?? null,
          data_through: data_through ?? null,
        },
      });
    }

    // Sources removed from config: drop from state map so no events fire.
    const liveSourceSet = new Set(sources.map((r) => r.source));
    for (const key of stateMap.keys()) {
      if (!liveSourceSet.has(key)) {
        stateMap.delete(key);
      }
    }
  }

  function start(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
    logger.info("freshness monitor started", { interval_ms: intervalMs });

    // Fire once immediately on boot, then on cadence.
    void tick().catch((e: unknown) => {
      logger.warn("freshness monitor tick error", { error: String(e) });
    });

    const handle = setInterval(() => {
      void tick().catch((e: unknown) => {
        logger.warn("freshness monitor tick error", { error: String(e) });
      });
    }, intervalMs);

    return () => {
      clearInterval(handle);
      logger.info("freshness monitor stopped");
    };
  }

  return { tick, start };
}
