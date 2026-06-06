// ── Drift Detector — Baseline Resolver ────────────────────────────
// Phase D / P1. Three-tier baseline fallback per drift-detector.md §4:
//
//   Tier 1 — spec:               strategy_spec.drift.<metric>.range
//   Tier 2 — qo_pinned:          WFO archive JSON at baseline_qo_run
//   Tier 3 — computed_historical: rolling audit_fills window (90d default)
//
// Returns null when no baseline can be constructed (insufficient
// history or no archive configured). Callers treat null as
// "drift monitoring not yet active" for the slow-tier check.
//
// The pin flow (operator re-pins via GUI) stores the new archive URL
// in the strategy's drift spec. This module only reads; the pin write
// goes through the strategy config store.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type {
  DriftSpec,
  MetricSpec,
  SpecRange,
  BaselineRange,
  BaselineSource,
} from "../../src/types/drift.js";

// ── Re-exported constants ──────────────────────────────────────────

/** Minimum days of live history required for computed_historical baseline. */
export const COMPUTED_HISTORICAL_MIN_DAYS = 90;

// ── QO archive shape ───────────────────────────────────────────────

/** OOS metric panel extracted from a WFO fold. */
interface OosMetrics {
  net_pnl?: number;
  hit_rate?: number;
  sortino?: number;
  max_dd?: number;
}

/** One fold inside a wfo_results_*.json file. */
interface WfoFold {
  fold_id?: number;
  oos?: OosMetrics;
}

/** Parsed top-level structure of a wfo_results_*.json file. */
interface WfoResultsJson {
  schema_version?: number;
  strategy?: string;
  lineage_id?: string;
  folds?: WfoFold[];
}

// Map drift metric names to the QO OOS panel keys they correspond to.
// Only metrics the QO backtest actually produces are listed.
const METRIC_TO_OOS_KEY: Partial<Record<string, keyof OosMetrics>> = {
  realized_pnl: "net_pnl",
  hit_rate: "hit_rate",
};

// ── Statistical helpers (local — slow-tier owns the CI wrappers) ───

function sampleMean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleStdDev(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = sampleMean(values);
  const variance = values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Build a [mean-σ, mean+σ] interval from a set of per-fold scalars. */
function buildRangeFromSamples(values: number[]): SpecRange | null {
  if (values.length < 2) return null;
  const m = sampleMean(values);
  const s = sampleStdDev(values);
  if (!isFinite(m) || !isFinite(s)) return null;
  return [m - s, m + s];
}

// ── DB helper ─────────────────────────────────────────────────────

interface DailyPnlRow {
  pnl: number;
}

/** Daily P&L values from audit_fills over the given rolling window. */
async function queryDailyPnl(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT COALESCE(SUM(pnl), 0) AS pnl
         FROM audit_fills
        WHERE strategy_id = ?
          AND fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'
        GROUP BY DATE_TRUNC('day', fill_ts)`,
      strategyId,
      (err: Error | null, rows: unknown) => {
        if (err) reject(err);
        else resolve(((rows as DailyPnlRow[]) ?? []).map((r) => r.pnl));
      },
    );
  });
}

interface HitRateRow {
  total: number;
  profitable: number;
}

/** Hit-rate numerator/denominator from audit_fills over the rolling window. */
async function queryHitRateValues(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS profitable
         FROM audit_fills
        WHERE strategy_id = ?
          AND fill_type   = 'closing'
          AND fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'`,
      strategyId,
      (err: Error | null, rows: unknown) => {
        if (err) reject(err);
        else {
          const row = (rows as HitRateRow[])?.[0];
          if (!row || row.total === 0) resolve(null);
          else resolve(row.profitable / row.total);
        }
      },
    );
  });
}

interface SlippageRow {
  slippage: number;
}

/** Per-fill slippage values over the rolling window. */
async function querySlippageValues(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT slippage
         FROM audit_fills
        WHERE strategy_id = ?
          AND fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'`,
      strategyId,
      (err: Error | null, rows: unknown) => {
        if (err) reject(err);
        else resolve(((rows as SlippageRow[]) ?? []).map((r) => r.slippage));
      },
    );
  });
}

interface LatencyRow {
  latency_ms: number;
}

/** Signal-fill latency in ms per fill over the rolling window. */
async function queryLatencyValues(
  db: Database,
  strategyId: string,
  windowDays: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT EXTRACT(EPOCH FROM (f.fill_ts - i.created_at)) * 1000 AS latency_ms
         FROM audit_fills f
         JOIN audit_intents i ON i.intent_id = f.intent_id
        WHERE f.strategy_id = ?
          AND f.fill_ts >= CURRENT_TIMESTAMP - INTERVAL '${windowDays} days'`,
      strategyId,
      (err: Error | null, rows: unknown) => {
        if (err) reject(err);
        else resolve(((rows as LatencyRow[]) ?? []).map((r) => r.latency_ms));
      },
    );
  });
}

// ── Tier 2: QO archive reader ─────────────────────────────────────

/**
 * Count calendar days of live fill history for the strategy.
 * Used to check whether the 90-day computed-historical window is satisfied.
 */
async function queryLiveDayCount(db: Database, strategyId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT COUNT(DISTINCT DATE_TRUNC('day', fill_ts)) AS day_count
         FROM audit_fills
        WHERE strategy_id = ?`,
      strategyId,
      (err: Error | null, rows: unknown) => {
        if (err) reject(err);
        else {
          const row = (rows as Array<{ day_count: number | bigint }>)?.[0];
          resolve(Number(row?.day_count ?? 0));
        }
      },
    );
  });
}

/**
 * Fetch the WFO results JSON from a local file:// or s3:// URI.
 * Returns null on any fetch or parse error (treated as tier miss).
 */
async function fetchWfoJson(archiveUrl: string, logger: Logger): Promise<WfoResultsJson | null> {
  try {
    if (archiveUrl.startsWith("file://") || archiveUrl.startsWith("/")) {
      // Local file — read synchronously (resolver runs in async context).
      const path = archiveUrl.startsWith("file://")
        ? archiveUrl.slice("file://".length)
        : archiveUrl;
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as WfoResultsJson;
    }
    if (archiveUrl.startsWith("s3://")) {
      // MinIO / S3 — use DuckDB httpfs so S3 credentials flow through
      // the same initS3() path used everywhere else in the codebase.
      const { withDb } = await import("../orchestrator/storage.js");
      const escapedUrl = archiveUrl.replace(/'/g, "''");
      const rows = await withDb<Array<Record<string, unknown>>>(
        async (db) => {
          return new Promise((resolve, reject) => {
            db.all(
              `SELECT * FROM read_json_auto('${escapedUrl}')`,
              (err: Error | null, rows: unknown) => {
                if (err) reject(err);
                else resolve((rows as Array<Record<string, unknown>>) ?? []);
              },
            );
          });
        },
        { needsS3: true },
      );
      // read_json_auto of a single JSON object returns one row with
      // the top-level keys as columns. Reconstruct the object.
      if (rows.length === 0) return null;
      return rows[0] as unknown as WfoResultsJson;
    }
    logger.warn("baseline-resolver.unsupported-archive-url", { url: archiveUrl });
    return null;
  } catch (err) {
    logger.warn("baseline-resolver.archive-fetch-failed", {
      url: archiveUrl,
      error: String(err),
    });
    return null;
  }
}

/**
 * Extract per-fold OOS values for the given metric from the WFO result.
 * Returns an empty array when the archive doesn't contain the metric.
 */
function extractFoldValues(wfo: WfoResultsJson, metric: string): number[] {
  const oosKey = METRIC_TO_OOS_KEY[metric];
  if (!oosKey) return [];
  const folds: WfoFold[] = Array.isArray(wfo.folds) ? wfo.folds : [];
  const values: number[] = [];
  for (const fold of folds) {
    const v = fold.oos?.[oosKey];
    if (typeof v === "number" && isFinite(v)) values.push(v);
  }
  return values;
}

// ── Public surface ─────────────────────────────────────────────────

export interface BaselineResolverDeps {
  db: Database;
  logger: Logger;
}

export interface BaselineResolverOpts {
  /** Rolling window used for computed-historical fallback (default 90). */
  windowDays?: number;
}

/**
 * Resolve the spec range for `(strategyId, metric)` via the three-tier
 * fallback (drift-detector.md §4).
 *
 * Returns a BaselineRange on success, or null when:
 *   - No baseline can be constructed (no qo_pinned config + < 90d live fills).
 *
 * Slow-tier callers treat null as "drift monitoring disabled for this metric"
 * and surface the "drift monitoring not yet active" banner.
 */
export async function resolveBaseline(
  strategyId: string,
  metric: string,
  driftSpec: DriftSpec,
  metricSpec: MetricSpec | undefined,
  deps: BaselineResolverDeps,
  opts: BaselineResolverOpts = {},
): Promise<BaselineRange | null> {
  const { db, logger } = deps;
  const windowDays = opts.windowDays ?? COMPUTED_HISTORICAL_MIN_DAYS;

  // ── Tier 1: explicit spec range ────────────────────────────────
  if (metricSpec?.range !== undefined) {
    return { range: metricSpec.range, source: "spec" };
  }

  // ── Tier 2: pinned QO backtest archive ─────────────────────────
  if (driftSpec.baseline_qo_run) {
    const wfo = await fetchWfoJson(driftSpec.baseline_qo_run, logger);
    if (wfo) {
      const values = extractFoldValues(wfo, metric);
      const range = buildRangeFromSamples(values);
      if (range !== null) {
        logger.debug("baseline-resolver.qo-pinned", {
          strategy_id: strategyId,
          metric,
          n_folds: values.length,
        });
        return { range, source: "qo_pinned" };
      }
      logger.debug("baseline-resolver.qo-pinned-no-metric", {
        strategy_id: strategyId,
        metric,
        archive_url: driftSpec.baseline_qo_run,
      });
    }
    // Archive fetch failed or metric not in archive — fall through to tier 3.
  }

  // ── Tier 3: computed from historical fills ─────────────────────
  let computedRange: SpecRange | null = null;
  let source: BaselineSource = "computed_historical";

  try {
    computedRange = await computeHistoricalRange(strategyId, metric, db, windowDays);
  } catch (err) {
    logger.error("baseline-resolver.computed-historical-failed", {
      strategy_id: strategyId,
      metric,
      error: String(err),
    });
    return null;
  }

  if (computedRange === null) {
    // Insufficient history — check whether we have enough live days.
    const liveDays = await queryLiveDayCount(db, strategyId).catch(() => 0);
    if (liveDays < COMPUTED_HISTORICAL_MIN_DAYS) {
      logger.debug("baseline-resolver.insufficient-history", {
        strategy_id: strategyId,
        metric,
        live_days: liveDays,
        required_days: COMPUTED_HISTORICAL_MIN_DAYS,
      });
      return null;
    }
    // Enough days but metric has no data — still treat as no-baseline.
    return null;
  }

  return {
    range: computedRange,
    source,
    computed_window_days: windowDays,
  };
}

// ── Computed-historical range by metric ────────────────────────────

/**
 * Compute the distributional range for `metric` from `audit_fills`
 * over the rolling window. Returns null when there are not enough
 * observations to form a stable range (requires at least 2 values).
 */
async function computeHistoricalRange(
  strategyId: string,
  metric: string,
  db: Database,
  windowDays: number,
): Promise<SpecRange | null> {
  switch (metric) {
    case "realized_pnl": {
      const values = await queryDailyPnl(db, strategyId, windowDays);
      return buildRangeFromSamples(values);
    }
    case "hit_rate": {
      // Hit rate is a scalar point estimate (not a per-observation series).
      // Use a ±20% band around the observed rate as the computed range.
      const rate = await queryHitRateValues(db, strategyId, windowDays);
      if (rate === null || !isFinite(rate)) return null;
      const band = 0.2 * rate;
      const range: SpecRange = [Math.max(0, rate - band), rate + band];
      return range;
    }
    case "slippage": {
      const values = await querySlippageValues(db, strategyId, windowDays);
      return buildRangeFromSamples(values);
    }
    case "signal_fill_latency": {
      const values = await queryLatencyValues(db, strategyId, windowDays);
      return buildRangeFromSamples(values);
    }
    case "realized_vol": {
      // Realized vol is the std-dev of daily P&L. Use a ±50% band around
      // the observed vol as the computed range.
      const dailyPnl = await queryDailyPnl(db, strategyId, windowDays);
      if (dailyPnl.length < 2) return null;
      const vol = sampleStdDev(dailyPnl);
      if (!isFinite(vol) || vol <= 0) return null;
      const range: SpecRange = [vol * 0.5, vol * 1.5];
      return range;
    }
    default:
      return null;
  }
}

// ── Ban-list check helper ──────────────────────────────────────────

/**
 * Whether a strategy has insufficient live history to activate
 * computed-historical baseline. Used by slow-tier to surface the
 * "drift monitoring not yet active" banner (drift-detector.md §4).
 */
export async function hasInsufficientHistory(strategyId: string, db: Database): Promise<boolean> {
  const liveDays = await queryLiveDayCount(db, strategyId).catch(() => 0);
  return liveDays < COMPUTED_HISTORICAL_MIN_DAYS;
}
