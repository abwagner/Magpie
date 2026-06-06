// ── Strategy Drift Detector — Module Entrypoint ───────────────────
// Phase D / P1. Owns the fast/slow tier wiring.
// Design: docs/tdd/drift-detector.md
//
// Fast tier  — per-fill hard-bound checks (fire on threshold crossing,
//              no statistics). Triggered via the fill observer.
// Slow tier  — 60s timer + distributional CI checks with alert budget.
//
// Both tiers are implemented in separate modules (fast-tier.ts and
// slow-tier.ts — separate tickets per QF-328 scope). This entrypoint
// wires them together and exposes the public start/stop surface.
//
// Alert budget query helper: budgetExceeded() implements the
// per-(strategy_id, metric, fired_date_utc) suppression rule from
// drift-detector.md §3.3. The drift_alerts DDL lives in
// server/db/init.ts (added by this ticket).

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type { DriftAlert } from "../../src/types/drift.js";

// ── Types ──────────────────────────────────────────────────────────

export interface DriftDetectorDeps {
  db: Database;
  logger: Logger;
}

export interface DriftDetectorHandle {
  /** Persist a fired drift alert (both tiers call this). */
  recordAlert(alert: DriftAlert): Promise<void>;
  /**
   * Returns true when the alert budget for (strategy_id, metric) on
   * today's UTC date has been exhausted (i.e., at least one alert for
   * this pair has already fired today). Per drift-detector.md §3.3:
   * at most one alert per (strategy_id, metric) per UTC day.
   */
  budgetExceeded(strategyId: string, metric: string, todayUtc: string): Promise<boolean>;
  stop(): void;
}

// ── Per-day alert budget query ─────────────────────────────────────

/**
 * Check whether the alert budget for a (strategy_id, metric) pair is
 * already exhausted on the given UTC date.
 *
 * @param db         - DuckDB connection
 * @param strategyId - strategy identifier
 * @param metric     - metric name (e.g. "realized_pnl", "hit_rate")
 * @param todayUtc   - ISO 8601 date string in UTC ("YYYY-MM-DD")
 * @returns true if at least one alert has already fired for this pair
 *          today (i.e., further alerts should be suppressed).
 */
export async function queryAlertBudgetExceeded(
  db: Database,
  strategyId: string,
  metric: string,
  todayUtc: string,
): Promise<boolean> {
  const count = await new Promise<number>((resolve, reject) => {
    db.all(
      `SELECT COUNT(*) AS cnt
         FROM drift_alerts
        WHERE strategy_id = ?
          AND metric      = ?
          AND fired_date_utc = ?`,
      strategyId,
      metric,
      todayUtc,
      (err: Error | null, rows: unknown) => {
        if (err) reject(err);
        else {
          const typed = rows as Array<{ cnt: number }>;
          resolve(typed[0]?.cnt ?? 0);
        }
      },
    );
  });
  return count > 0;
}

// ── Module factory ─────────────────────────────────────────────────

/**
 * Start the drift detector. Returns a handle with helpers used by
 * both tiers. The fast-tier and slow-tier are wired in separately
 * (fast-tier.ts / slow-tier.ts — not in scope for this ticket).
 */
export function startDriftDetector(deps: DriftDetectorDeps): DriftDetectorHandle {
  const { db, logger } = deps;

  logger.info("drift-detector.started");

  return {
    async recordAlert(alert: DriftAlert): Promise<void> {
      const id = (await import("ulid")).ulid();
      const firedAt = new Date().toISOString();
      // fired_date_utc: YYYY-MM-DD portion of the UTC timestamp.
      const firedDateUtc = firedAt.slice(0, 10);

      await new Promise<void>((resolve, reject) => {
        db.run(
          `INSERT INTO drift_alerts
             (id, alert_type, strategy_id, portfolio_id, metric,
              observed_json, spec_range_json, baseline_source,
              sample_size, fired_at, fired_date_utc, correlation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          alert.alert_type,
          alert.strategy_id,
          alert.portfolio_id,
          alert.metric,
          JSON.stringify(alert.observed),
          JSON.stringify(alert.spec_range),
          alert.baseline_source,
          alert.sample_size,
          firedAt,
          firedDateUtc,
          alert.correlation_id,
          (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      logger.info("drift-detector.alert.recorded", {
        alert_type: alert.alert_type,
        strategy_id: alert.strategy_id,
        metric: alert.metric,
        fired_at: firedAt,
      });
    },

    async budgetExceeded(strategyId: string, metric: string, todayUtc: string): Promise<boolean> {
      return queryAlertBudgetExceeded(db, strategyId, metric, todayUtc);
    },

    stop(): void {
      // Fast/slow tier stop hooks will be registered here once those
      // modules land. Nothing to tear down at this skeleton stage.
      logger.info("drift-detector.stopped");
    },
  };
}
