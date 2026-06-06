// ── Drift Detector — Slow Tier ────────────────────────────────────
// Phase D / P1. 60s scheduled handler + distributional CI checks.
// Design: docs/tdd/drift-detector.md §2.2 + §3.
//
// Scheduled at configurable intervals (default 60s; per-strategy
// override via DriftSpec.tick_seconds). For each strategy it:
//
//   1. Computes 5 distributional metrics over the rolling window.
//   2. Runs the §3 three-gate statistical machinery:
//      §3.1 — n_min gate: skip metric until enough observations.
//      §3.2 — CI overlap check vs spec range.
//      §3.3 — per-(strategy, metric)-per-day alert budget.
//   3. On hard-drift trip: records alert + revokes open envelopes
//      for halt-eligible metrics (drift-detector.md §5.2).
//
// Metrics (drift-detector.md §2.2):
//   realized_pnl        — per-strategy daily P&L distribution
//   hit_rate            — profitable closing fills / total closing fills
//   slippage            — mean fill-price slippage across fills
//   signal_fill_latency — mean fill_ts - intent created_at (ms)
//   realized_vol        — std-dev of daily P&L over the window

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type {
  DriftAlert,
  DriftSpec,
  MetricSpec,
  SpecRange,
  BaselineSource,
} from "../../src/types/drift.js";
import { N_MIN_DEFAULTS } from "../../src/types/drift.js";
import type { EnvelopeRevoker } from "./envelope-revoker.js";
import type { PendingIntentsStore } from "./pending-intents.js";
import type { DriftDetectorHandle } from "./drift-detector.js";
import { resolveBaseline } from "./baseline-resolver.js";

// ── Public types ───────────────────────────────────────────────────

/** Minimal strategy descriptor the slow tier needs. */
export interface SlowTierStrategy {
  id: string;
  portfolio_id: string;
  drift: DriftSpec;
  /** Broker name used to look up the per-broker EnvelopeRevoker. */
  broker: string;
}

export interface SlowTierDeps {
  db: Database;
  logger: Logger;
  detector: DriftDetectorHandle;
  pendingIntents: PendingIntentsStore;
  /** Per-broker revokers keyed by broker name (mirrors halt-handler.ts). */
  revokers: Map<string, EnvelopeRevoker>;
  strategies: () => SlowTierStrategy[];
  // Test seams.
  /** Defaults to () => new Date().toISOString() */
  now?: () => string;
  /** Defaults to () => Date.now() */
  nowMs?: () => number;
}

export interface SlowTierHandle {
  /** Immediately run one evaluation cycle (useful for testing). */
  tick(): Promise<void>;
  stop(): void;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_WINDOW_DAYS = 90;

/** Metric names in canonical order. */
export const SLOW_TIER_METRICS = [
  "realized_pnl",
  "hit_rate",
  "slippage",
  "signal_fill_latency",
  "realized_vol",
] as const;

export type SlowTierMetric = (typeof SLOW_TIER_METRICS)[number];

// ── Statistical helpers ────────────────────────────────────────────

/**
 * 95% CI half-width for a sample mean: 1.96 * σ / √n.
 * Returns NaN when n < 2 (σ is undefined).
 */
export function ciHalfWidth(stdDev: number, n: number): number {
  if (n < 2) return NaN;
  return 1.96 * (stdDev / Math.sqrt(n));
}

/**
 * Sample mean of an array. Returns NaN on empty input.
 */
export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Sample standard deviation (ddof=1). Returns NaN when n < 2.
 */
export function stdDev(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Confidence interval from sample. */
export interface CI {
  ci_lower: number;
  ci_upper: number;
}

/** Build a CI around the sample mean. */
export function meanCI(values: number[]): CI | null {
  const n = values.length;
  const m = mean(values);
  const s = stdDev(values);
  const hw = ciHalfWidth(s, n);
  if (!isFinite(m) || !isFinite(hw)) return null;
  return { ci_lower: m - hw, ci_upper: m + hw };
}

// ── CI overlap check (§3.2) ───────────────────────────────────────

/**
 * Returns true when the CI is **fully outside** the spec range,
 * which is the hard-drift-trip condition (§3.2).
 *
 * One-sided metrics: only the bad-direction tail is checked.
 *   - { floor }: too-low is bad — CI upper < floor → trip.
 *   - { ceiling }: too-high is bad — CI lower > ceiling → trip.
 *   - [lo, hi] interval: trip when CI lower > hi OR CI upper < lo.
 */
export function ciOutsideSpecRange(ci: CI, specRange: SpecRange): boolean {
  if (Array.isArray(specRange)) {
    const [lo, hi] = specRange as [number, number];
    // CI fully below the range or fully above — no overlap.
    return ci.ci_upper < lo || ci.ci_lower > hi;
  }
  if ("floor" in specRange) {
    // Too low is bad. CI upper below the floor → the entire CI is
    // below the acceptable range.
    return ci.ci_upper < specRange.floor;
  }
  if ("ceiling" in specRange) {
    // Too high is bad. CI lower above the ceiling → entirely above.
    return ci.ci_lower > specRange.ceiling;
  }
  return false;
}

// ── DB query helpers ──────────────────────────────────────────────

function dbAll<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

// ── Metric queries ─────────────────────────────────────────────────

interface DailyPnlRow {
  pnl: number;
}

/** Daily P&L values over the rolling window. */
async function queryDailyPnl(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<number[]> {
  const rows = await dbAll<DailyPnlRow>(
    db,
    `SELECT COALESCE(SUM(pnl), 0) AS pnl
       FROM audit_fills
      WHERE strategy_id = ?
        AND fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'
      GROUP BY DATE_TRUNC('day', fill_ts)`,
    [strategyId],
  );
  return rows.map((r) => r.pnl);
}

interface HitRateRow {
  total: number;
  profitable: number;
}

/**
 * Hit rate: returns [n_closing_fills, hit_rate_value].
 * hit_rate = profitable closing fills / total closing fills.
 * Returns null when there are no closing fills.
 */
async function queryHitRate(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<{ n: number; rate: number } | null> {
  const rows = await dbAll<HitRateRow>(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS profitable
       FROM audit_fills
      WHERE strategy_id = ?
        AND fill_type   = 'closing'
        AND fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'`,
    [strategyId],
  );
  const row = rows[0];
  if (!row || row.total === 0) return null;
  return { n: row.total, rate: row.profitable / row.total };
}

interface SlippageRow {
  slippage: number;
}

/** Mean fill-price slippage values for each fill in the window. */
async function querySlippage(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<number[]> {
  const rows = await dbAll<SlippageRow>(
    db,
    `SELECT slippage
       FROM audit_fills
      WHERE strategy_id = ?
        AND fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'`,
    [strategyId],
  );
  return rows.map((r) => r.slippage);
}

interface LatencyRow {
  latency_ms: number;
}

/** Signal-fill latency in ms for each fill. */
async function querySignalFillLatency(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<number[]> {
  const rows = await dbAll<LatencyRow>(
    db,
    `SELECT EXTRACT(EPOCH FROM (f.fill_ts - i.created_at)) * 1000 AS latency_ms
       FROM audit_fills f
       JOIN audit_intents i ON i.intent_id = f.intent_id
      WHERE f.strategy_id = ?
        AND f.fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'`,
    [strategyId],
  );
  return rows.map((r) => r.latency_ms);
}

// ── Metric computation ─────────────────────────────────────────────

interface MetricObservation {
  metric: SlowTierMetric;
  n: number;
  ci: CI;
}

async function computeMetrics(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<MetricObservation[]> {
  const observations: MetricObservation[] = [];

  // realized_pnl: CI on daily P&L mean.
  const pnlValues = await queryDailyPnl(db, strategyId, windowDays);
  const pnlCi = meanCI(pnlValues);
  if (pnlCi) {
    observations.push({ metric: "realized_pnl", n: pnlValues.length, ci: pnlCi });
  }

  // hit_rate: CI on the hit-rate proportion (treated as a scalar
  // measure — the CI is on the observed rate, not a proportion CI).
  const hrResult = await queryHitRate(db, strategyId, windowDays);
  if (hrResult) {
    // For a proportion p over n observations the SE = sqrt(p(1-p)/n).
    const { n, rate } = hrResult;
    const se = Math.sqrt((rate * (1 - rate)) / n);
    const hw = 1.96 * se;
    const ci: CI = { ci_lower: rate - hw, ci_upper: rate + hw };
    observations.push({ metric: "hit_rate", n, ci });
  }

  // slippage: CI on mean slippage.
  const slippageValues = await querySlippage(db, strategyId, windowDays);
  const slippageCi = meanCI(slippageValues);
  if (slippageCi) {
    observations.push({
      metric: "slippage",
      n: slippageValues.length,
      ci: slippageCi,
    });
  }

  // signal_fill_latency: CI on mean latency.
  const latencyValues = await querySignalFillLatency(db, strategyId, windowDays);
  const latencyCi = meanCI(latencyValues);
  if (latencyCi) {
    observations.push({
      metric: "signal_fill_latency",
      n: latencyValues.length,
      ci: latencyCi,
    });
  }

  // realized_vol: std-dev of daily P&L (not a CI on the mean but on
  // the vol estimate itself — n is the number of daily returns used).
  if (pnlValues.length >= 2) {
    const vol = stdDev(pnlValues);
    const n = pnlValues.length;
    // CI on the std-dev via the sample-SD SE approximation: SE(σ) ≈ σ / √(2(n-1)).
    const seVol = vol / Math.sqrt(2 * (n - 1));
    const hw = 1.96 * seVol;
    const ci: CI = { ci_lower: vol - hw, ci_upper: vol + hw };
    observations.push({ metric: "realized_vol", n, ci });
  }

  return observations;
}

// ── Per-metric spec resolution ─────────────────────────────────────

function resolveMetricSpec(driftSpec: DriftSpec, metric: SlowTierMetric): MetricSpec | undefined {
  return driftSpec[metric] as MetricSpec | undefined;
}

function resolveNMin(metricSpec: MetricSpec | undefined, metric: SlowTierMetric): number {
  return metricSpec?.n_min ?? N_MIN_DEFAULTS[metric] ?? 20;
}

// ── Envelope revocation on hard-drift trip ─────────────────────────

async function revokeStrategyEnvelopes(
  strategy: SlowTierStrategy,
  pendingIntents: PendingIntentsStore,
  revokers: Map<string, EnvelopeRevoker>,
  logger: Logger,
  nowTs: string,
): Promise<void> {
  const envelopes = pendingIntents.getActiveForStrategy(strategy.id);
  if (envelopes.length === 0) return;

  logger.warn("slow-tier.hard-drift.revoking-envelopes", {
    strategy_id: strategy.id,
    envelope_count: envelopes.length,
  });

  const revoker = revokers.get(strategy.broker);
  if (!revoker) {
    logger.warn("slow-tier.hard-drift.no-revoker", {
      strategy_id: strategy.id,
      broker: strategy.broker,
    });
    return;
  }

  await Promise.all(
    envelopes.map(async (env) => {
      const result = await revoker.revokeEnvelope(env.envelope_id, "drift_hard_trip");
      if (result.status === "revoked" || result.status === "envelope_unknown") {
        pendingIntents.markEnvelopeRevoked(env.envelope_id, nowTs);
        logger.info("slow-tier.envelope-revoked", {
          strategy_id: strategy.id,
          envelope_id: env.envelope_id,
          status: result.status,
        });
      } else {
        logger.error("slow-tier.envelope-revoke-failed", {
          strategy_id: strategy.id,
          envelope_id: env.envelope_id,
          attempts: result.attempts,
        });
      }
    }),
  );
}

// ── Single strategy evaluation ─────────────────────────────────────

async function evaluateStrategy(
  strategy: SlowTierStrategy,
  deps: SlowTierDeps,
  todayUtc: string,
  nowTs: string,
): Promise<void> {
  const { db, logger, detector, pendingIntents, revokers } = deps;
  const driftSpec = strategy.drift;
  const windowDays = driftSpec.window_days ?? DEFAULT_WINDOW_DAYS;

  let observations: MetricObservation[];
  try {
    observations = await computeMetrics(db, strategy.id, windowDays);
  } catch (err) {
    logger.error("slow-tier.compute-metrics-failed", {
      strategy_id: strategy.id,
      error: String(err),
    });
    return;
  }

  for (const obs of observations) {
    const metricSpec = resolveMetricSpec(driftSpec, obs.metric);
    const nMin = resolveNMin(metricSpec, obs.metric);

    // §3.1 — n_min gate.
    if (obs.n < nMin) {
      logger.debug("slow-tier.metric.warming-up", {
        strategy_id: strategy.id,
        metric: obs.metric,
        n: obs.n,
        n_min: nMin,
      });
      continue;
    }

    // Baseline resolution: three-tier fallback (drift-detector.md §4).
    const baselineResult = await resolveBaseline(
      strategy.id,
      obs.metric,
      driftSpec,
      metricSpec,
      { db, logger },
      { windowDays },
    );
    if (!baselineResult) {
      logger.debug("slow-tier.metric.no-baseline", {
        strategy_id: strategy.id,
        metric: obs.metric,
      });
      continue;
    }
    const specRange: SpecRange = baselineResult.range;

    // §3.2 — CI overlap check.
    const tripped = ciOutsideSpecRange(obs.ci, specRange);
    if (!tripped) continue;

    // §3.3 — alert budget check before firing.
    const budgetExhausted = await detector.budgetExceeded(strategy.id, obs.metric, todayUtc);
    if (budgetExhausted) {
      logger.debug("slow-tier.metric.budget-exhausted", {
        strategy_id: strategy.id,
        metric: obs.metric,
        today_utc: todayUtc,
      });
      continue;
    }

    const baselineSource: BaselineSource = baselineResult.source;

    const alert: DriftAlert = {
      alert_type: "drift_slow_distribution",
      strategy_id: strategy.id,
      portfolio_id: strategy.portfolio_id,
      metric: obs.metric,
      observed: obs.ci,
      spec_range: specRange,
      baseline_source: baselineSource,
      sample_size: obs.n,
      asof: nowTs,
      correlation_id: (await import("ulid")).ulid(),
    };

    await detector.recordAlert(alert);

    logger.warn("slow-tier.drift-trip", {
      strategy_id: strategy.id,
      portfolio_id: strategy.portfolio_id,
      metric: obs.metric,
      ci_lower: obs.ci.ci_lower,
      ci_upper: obs.ci.ci_upper,
      n: obs.n,
    });

    // Hard-drift trip: revoke envelopes if metric is halt-eligible.
    if (metricSpec?.halt_eligible === true) {
      await revokeStrategyEnvelopes(strategy, pendingIntents, revokers, logger, nowTs);
    }
  }
}

// ── Module factory ─────────────────────────────────────────────────

/**
 * Start the slow-tier drift evaluator. Returns a handle with a
 * `tick()` method for manual/test invocation and a `stop()` method
 * to cancel the scheduled timer.
 */
export function startSlowTier(deps: SlowTierDeps): SlowTierHandle {
  const { logger, strategies } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    const nowTs = now();
    const todayUtc = nowTs.slice(0, 10);
    const allStrategies = strategies();

    for (const strategy of allStrategies) {
      await evaluateStrategy(strategy, deps, todayUtc, nowTs);
    }
  }

  function scheduleNext(): void {
    // Use the minimum tick interval across all strategies (or the
    // default) — individual strategies filter within the tick.
    const allStrategies = strategies();
    const tickMs =
      allStrategies.length > 0
        ? Math.min(
            ...allStrategies.map((s) => (s.drift.tick_seconds ?? 60) * 1000),
            DEFAULT_TICK_MS,
          )
        : DEFAULT_TICK_MS;

    timer = setTimeout(() => {
      tick()
        .catch((err) => {
          logger.error("slow-tier.tick-error", { error: String(err) });
        })
        .finally(() => {
          if (timer !== null) scheduleNext();
        });
    }, tickMs);
  }

  scheduleNext();
  logger.info("slow-tier.started");

  return {
    tick,
    stop() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info("slow-tier.stopped");
    },
  };
}
