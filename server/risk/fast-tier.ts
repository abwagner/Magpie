// ── Drift Detector — Fast Tier ──────────────────────────────────────
// Phase D / P1. Per-fill hard-bound checks.
// Design: docs/tdd/drift-detector.md §2.1
//
// Triggered on every fill (via the same observer registered in
// server/order/plane.ts that mutates portfolio state). For each fill
// it runs four hard-bound checks against per-strategy in-memory state:
//
//   1. daily_loss_floor      — today's per-strategy realized P&L < floor.
//   2. max_notional          — per-strategy open notional > envelope.
//   3. max_positions         — per-strategy open position count > cap.
//   4. max_seconds_between_fills — seconds since last fill > cadence floor.
//
// All checks are threshold crossings — no statistics. Cross the bound,
// fire the alert (subject to the per-day alert budget).
//
// Reads bounds from DriftSpec per strategy. Emits drift_fast_floor
// DriftAlert via detector.recordAlert. Respects the per-day budget:
// at most one alert per (strategy_id, metric) per UTC day.

import type { Logger } from "../logger.js";
import type { DriftAlert, DriftSpec } from "../../src/types/drift.js";
import type { DriftDetectorHandle } from "./drift-detector.js";

// ── Public types ───────────────────────────────────────────────────

/** Per-strategy bounds spec consumed by the fast tier. */
export interface FastTierStrategy {
  id: string;
  portfolio_id: string;
  drift: DriftSpec;
}

/**
 * Enriched fill payload the fast tier receives on each broker fill.
 * Callers (e.g. the Order Plane's onFill hook) must supply the
 * strategy-level context that the bare Fill type does not carry.
 */
export interface FastTierFill {
  /** ISO 8601 timestamp of the fill. */
  fill_ts: string;
  strategy_id: string;
  portfolio_id: string;
  /**
   * Realized P&L contribution of this fill (positive = profit).
   * For closing fills the caller computes this from the entry cost basis.
   * For opening fills the caller should pass 0 (no realized P&L yet).
   */
  realized_pnl: number;
  /** Absolute notional of all open positions for this strategy AFTER this fill. */
  open_notional: number;
  /** Count of open positions for this strategy AFTER this fill. */
  open_position_count: number;
}

export interface FastTierDeps {
  logger: Logger;
  detector: DriftDetectorHandle;
  strategies: () => FastTierStrategy[];
  // Test seams.
  /** Defaults to () => new Date().toISOString() */
  now?: () => string;
}

export interface FastTierHandle {
  /** Process a fill event and run all hard-bound checks. */
  onFill(fill: FastTierFill): Promise<void>;
  /**
   * Reset the daily per-strategy P&L accumulators.
   * Call at midnight UTC / session reset. Also resets last-fill timestamps
   * so the cadence floor doesn't fire on the first fill of a new day.
   */
  resetDaily(): void;
}

// ── Per-strategy state ─────────────────────────────────────────────

interface StrategyState {
  /** Accumulated realized P&L since the last resetDaily() call. */
  dailyPnl: number;
  /** Unix ms of the most-recent fill (or null if no fill today). */
  lastFillMs: number | null;
}

// ── Alert firing helper ────────────────────────────────────────────

/** Fast-tier metric names. */
export type FastTierMetric =
  | "daily_loss_floor"
  | "max_notional"
  | "max_positions"
  | "max_seconds_between_fills";

async function maybeFireAlert(
  metric: FastTierMetric,
  strategy: FastTierStrategy,
  observed: number,
  specBound: number,
  todayUtc: string,
  nowTs: string,
  detector: DriftDetectorHandle,
  logger: Logger,
): Promise<void> {
  const budgetExhausted = await detector.budgetExceeded(strategy.id, metric, todayUtc);
  if (budgetExhausted) {
    logger.debug("fast-tier.budget-exhausted", {
      strategy_id: strategy.id,
      metric,
      today_utc: todayUtc,
    });
    return;
  }

  const specRange = metric === "daily_loss_floor" ? { floor: specBound } : { ceiling: specBound };

  const alert: DriftAlert = {
    alert_type: "drift_fast_floor",
    strategy_id: strategy.id,
    portfolio_id: strategy.portfolio_id,
    metric,
    observed,
    spec_range: specRange,
    baseline_source: "spec",
    sample_size: 1,
    asof: nowTs,
    correlation_id: (await import("ulid")).ulid(),
  };

  await detector.recordAlert(alert);

  logger.warn("fast-tier.bound-tripped", {
    strategy_id: strategy.id,
    portfolio_id: strategy.portfolio_id,
    metric,
    observed,
    bound: specBound,
  });
}

// ── Module factory ─────────────────────────────────────────────────

/**
 * Create the fast-tier drift evaluator. Returns a handle with an
 * `onFill()` method to drive on each broker fill and a `resetDaily()`
 * method to clear per-day accumulators at midnight UTC.
 */
export function createFastTier(deps: FastTierDeps): FastTierHandle {
  const { logger, detector, strategies } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  // Per-strategy mutable state (keyed by strategy_id).
  const state = new Map<string, StrategyState>();

  function getOrInitState(strategyId: string): StrategyState {
    let s = state.get(strategyId);
    if (!s) {
      s = { dailyPnl: 0, lastFillMs: null };
      state.set(strategyId, s);
    }
    return s;
  }

  logger.info("fast-tier.started");

  return {
    async onFill(fill: FastTierFill): Promise<void> {
      const nowTs = now();
      const todayUtc = nowTs.slice(0, 10);

      // Resolve the strategy spec.
      const strategyList = strategies();
      const strategy = strategyList.find((s) => s.id === fill.strategy_id);
      if (!strategy) {
        logger.debug("fast-tier.unknown-strategy", { strategy_id: fill.strategy_id });
        return;
      }

      const driftSpec: DriftSpec = strategy.drift;
      const s = getOrInitState(fill.strategy_id);

      // Update accumulated daily P&L.
      s.dailyPnl += fill.realized_pnl;

      // ── Check 1: daily_loss_floor ──────────────────────────────
      if (driftSpec.daily_loss_floor !== undefined) {
        const floor = driftSpec.daily_loss_floor;
        if (s.dailyPnl < floor) {
          await maybeFireAlert(
            "daily_loss_floor",
            strategy,
            s.dailyPnl,
            floor,
            todayUtc,
            nowTs,
            detector,
            logger,
          );
        }
      }

      // ── Check 2: max_notional ──────────────────────────────────
      if (driftSpec.max_notional !== undefined) {
        const ceiling = driftSpec.max_notional;
        if (fill.open_notional > ceiling) {
          await maybeFireAlert(
            "max_notional",
            strategy,
            fill.open_notional,
            ceiling,
            todayUtc,
            nowTs,
            detector,
            logger,
          );
        }
      }

      // ── Check 3: max_positions ─────────────────────────────────
      if (driftSpec.max_positions !== undefined) {
        const ceiling = driftSpec.max_positions;
        if (fill.open_position_count > ceiling) {
          await maybeFireAlert(
            "max_positions",
            strategy,
            fill.open_position_count,
            ceiling,
            todayUtc,
            nowTs,
            detector,
            logger,
          );
        }
      }

      // ── Check 4: max_seconds_between_fills ────────────────────
      if (driftSpec.max_seconds_between_fills !== undefined && s.lastFillMs !== null) {
        const fillMs = Date.parse(fill.fill_ts);
        if (Number.isFinite(fillMs)) {
          const elapsedSeconds = (fillMs - s.lastFillMs) / 1_000;
          const maxSeconds = driftSpec.max_seconds_between_fills;
          if (elapsedSeconds > maxSeconds) {
            await maybeFireAlert(
              "max_seconds_between_fills",
              strategy,
              elapsedSeconds,
              maxSeconds,
              todayUtc,
              nowTs,
              detector,
              logger,
            );
          }
        }
      }

      // Update last-fill timestamp after all checks.
      const fillMs = Date.parse(fill.fill_ts);
      if (Number.isFinite(fillMs)) {
        s.lastFillMs = fillMs;
      }
    },

    resetDaily(): void {
      for (const [, s] of state) {
        s.dailyPnl = 0;
        s.lastFillMs = null;
      }
      logger.info("fast-tier.daily-reset");
    },
  };
}
