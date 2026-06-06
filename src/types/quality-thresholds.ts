// Settings · Models · Quality thresholds — frontend mirror of
// server/risk/quality_thresholds.ts. Server is authoritative; keep in
// sync when adding new fields.

export type ModelHealth = "healthy" | "degraded" | "failed";

export interface MetricThresholds {
  degraded_above?: number;
  failed_above?: number;
  degraded_below?: number;
  failed_below?: number;
}

export interface ModelThresholds {
  metrics: Record<string, MetricThresholds>;
}

export interface QualityThresholdsConfig {
  version: 1;
  defaults: ModelThresholds;
  models: Record<string, ModelThresholds>;
}
