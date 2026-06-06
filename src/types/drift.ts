// ── Strategy Drift Shared Types ────────────────────────────────────
// Shared types for the strategy drift detector.
// Design: docs/tdd/drift-detector.md §5.1 (DriftAlert payload),
// §3 (statistical machinery), §4 (baseline sources).

// ── Alert payload ──────────────────────────────────────────────────

// Observed value: either a scalar (fast-tier) or a CI (slow-tier).
export type ObservedValue = number | { ci_lower: number; ci_upper: number };

// Spec range: a two-sided interval, a one-sided floor, or a ceiling.
export type SpecRange = [number, number] | { floor: number } | { ceiling: number };

export type BaselineSource = "spec" | "qo_pinned" | "computed_historical";

export type DriftAlertType = "drift_fast_floor" | "drift_slow_distribution";

export interface DriftAlert {
  alert_type: DriftAlertType;
  strategy_id: string;
  portfolio_id: string;
  metric: string;
  observed: ObservedValue;
  spec_range: SpecRange;
  baseline_source: BaselineSource;
  sample_size: number;
  asof: string; // ISO 8601
  correlation_id: string;
}

// ── Drift spec (per-strategy configuration) ────────────────────────

// Per-metric overrides inside a strategy's drift section.
export interface MetricSpec {
  // Spec range the metric is compared against. When omitted the
  // baseline resolver falls back to qo_pinned → computed_historical.
  range?: SpecRange;
  // Minimum sample size before the metric is evaluated (§3.1).
  n_min?: number;
  // When true, a hard-drift trip on this metric triggers envelope
  // revocation (reason=drift_hard_trip) in addition to alerting.
  // Per drift-detector.md §5.2, auto-halt is not triggered — only
  // open envelopes for the strategy are revoked.
  halt_eligible?: boolean;
}

export interface DriftSpec {
  // Fast-tier hard bounds.
  daily_loss_floor?: number; // dollars or % of allocated equity
  max_notional?: number;
  max_positions?: number;
  max_seconds_between_fills?: number;

  // Slow-tier per-metric overrides.
  realized_pnl?: MetricSpec;
  hit_rate?: MetricSpec;
  slippage?: MetricSpec;
  signal_fill_latency?: MetricSpec;
  realized_vol?: MetricSpec;

  // Slow-tier global settings.
  tick_seconds?: number; // defaults to 60
  baseline_qo_run?: string; // s3://... MinIO path for pinned QO archive

  // Shared.
  window_days?: number; // rolling-window length; defaults to 90
}

// ── Baseline range ─────────────────────────────────────────────────

// Resolved spec range after baseline resolution (§4).
export interface BaselineRange {
  range: SpecRange;
  source: BaselineSource;
  // For computed_historical: number of days used to derive the range.
  computed_window_days?: number;
}

// ── n_min defaults (§3.1) ──────────────────────────────────────────

export const N_MIN_DEFAULTS: Record<string, number> = {
  realized_pnl: 20,
  hit_rate: 30,
  slippage: 30,
  signal_fill_latency: 20,
  realized_vol: 30,
};
