// ── Model Quality Thresholds (YAML-backed) ────────────────────────
//
// Per-model thresholds that flip a signal model's status badge from
// healthy → degraded → failed. The Signals workspace's Quality chart
// shows raw `model_quality` metrics today; this store sets the
// cutoffs and provides a single pure classification function the rest
// of the system can call.
//
// YAML shape (config/quality_thresholds.yaml):
//
//   version: 1
//   defaults:
//     metrics:
//       sample_count:
//         degraded_below: 30
//         failed_below: 10
//   models:
//     vol-forecast-spy-1d:
//       metrics:
//         rmse:
//           degraded_above: 0.05
//           failed_above: 0.10
//         accuracy:
//           degraded_below: 0.55
//           failed_below: 0.50
//
// Each metric can have either side of the pair (or both):
//   - `degraded_above` / `failed_above` — higher values are worse
//     (e.g., rmse, latency, error rate).
//   - `degraded_below` / `failed_below` — lower values are worse
//     (e.g., accuracy, sample_count).
//
// Classification returns the WORST status across all metrics the
// model emits. Missing metrics are ignored; missing thresholds for a
// metric leave that metric at healthy.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import yaml from "yaml";
import type { Logger } from "../logger.js";

export type ModelHealth = "healthy" | "degraded" | "failed";

export interface MetricThresholds {
  /** Value where the metric flips from healthy → degraded (higher = worse). */
  degraded_above?: number;
  /** Value where the metric flips from degraded → failed (higher = worse). */
  failed_above?: number;
  /** Value where the metric flips from healthy → degraded (lower = worse). */
  degraded_below?: number;
  /** Value where the metric flips from degraded → failed (lower = worse). */
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

const EMPTY: QualityThresholdsConfig = {
  version: 1,
  defaults: { metrics: {} },
  models: {},
};

// ── Validation ─────────────────────────────────────────────────────

class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "QualityThresholdsValidationError";
  }
}

function validateMetric(name: string, input: unknown): MetricThresholds {
  if (!input || typeof input !== "object") {
    throw new ValidationError(`metric ${name}: expected an object`);
  }
  const out: MetricThresholds = {};
  const obj = input as Record<string, unknown>;
  for (const key of ["degraded_above", "failed_above", "degraded_below", "failed_below"] as const) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new ValidationError(`metric ${name}.${key}: must be a finite number`);
    }
    out[key] = v;
  }

  // Sanity checks: degraded/failed pairs must be ordered correctly.
  // higher-is-worse — failed must be ≥ degraded.
  if (out.failed_above !== undefined && out.degraded_above !== undefined) {
    if (out.failed_above < out.degraded_above) {
      throw new ValidationError(
        `metric ${name}: failed_above (${out.failed_above}) must be ≥ degraded_above (${out.degraded_above})`,
      );
    }
  }
  // lower-is-worse — failed must be ≤ degraded.
  if (out.failed_below !== undefined && out.degraded_below !== undefined) {
    if (out.failed_below > out.degraded_below) {
      throw new ValidationError(
        `metric ${name}: failed_below (${out.failed_below}) must be ≤ degraded_below (${out.degraded_below})`,
      );
    }
  }

  return out;
}

function validateModel(input: unknown): ModelThresholds {
  if (!input || typeof input !== "object") return { metrics: {} };
  const obj = input as { metrics?: unknown };
  if (obj.metrics === undefined) return { metrics: {} };
  if (typeof obj.metrics !== "object" || obj.metrics === null) {
    throw new ValidationError("metrics: expected an object");
  }
  const metrics: Record<string, MetricThresholds> = {};
  for (const [name, m] of Object.entries(obj.metrics as Record<string, unknown>)) {
    metrics[name] = validateMetric(name, m);
  }
  return { metrics };
}

function normalize(raw: unknown): QualityThresholdsConfig {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Partial<QualityThresholdsConfig>;
  if (r.version !== undefined && r.version !== 1) {
    throw new ValidationError(`unsupported version ${String(r.version)}`);
  }
  const defaults = validateModel(r.defaults ?? { metrics: {} });
  const models: Record<string, ModelThresholds> = {};
  for (const [id, m] of Object.entries(r.models ?? {})) {
    models[id] = validateModel(m);
  }
  return { version: 1, defaults, models };
}

// ── Classification ─────────────────────────────────────────────────

/**
 * Worst-case status across one metric value vs. its thresholds.
 * Missing thresholds = healthy.
 */
function classifyMetric(value: number, t: MetricThresholds): ModelHealth {
  // Check failed bounds first (worst status wins).
  if (t.failed_above !== undefined && value > t.failed_above) return "failed";
  if (t.failed_below !== undefined && value < t.failed_below) return "failed";
  if (t.degraded_above !== undefined && value > t.degraded_above) return "degraded";
  if (t.degraded_below !== undefined && value < t.degraded_below) return "degraded";
  return "healthy";
}

const RANK: Record<ModelHealth, number> = { healthy: 0, degraded: 1, failed: 2 };

/**
 * Pure classifier: given the metrics observed for a model and the
 * effective thresholds, returns the worst status across all metrics
 * for which a threshold exists.
 *
 * Effective thresholds = defaults.metrics ⊕ models[id].metrics (model
 * overrides default per metric). Use [[mergeWithDefaults]] to compute.
 */
export function classifyModel(
  metrics: Record<string, number>,
  thresholds: ModelThresholds,
): ModelHealth {
  let worst: ModelHealth = "healthy";
  for (const [name, value] of Object.entries(metrics)) {
    const t = thresholds.metrics[name];
    if (!t) continue;
    const status = classifyMetric(value, t);
    if (RANK[status] > RANK[worst]) worst = status;
  }
  return worst;
}

/**
 * Merge model-specific thresholds onto the defaults so a caller can
 * pass the result straight to [[classifyModel]]. Model overrides win
 * at the per-metric level (not at the per-field level — a model that
 * sets `accuracy.degraded_below` replaces the entire `accuracy` entry
 * from defaults).
 */
export function mergeWithDefaults(
  defaults: ModelThresholds,
  model: ModelThresholds | undefined,
): ModelThresholds {
  if (!model) return defaults;
  return {
    metrics: { ...defaults.metrics, ...model.metrics },
  };
}

// ── Store ──────────────────────────────────────────────────────────

export interface QualityThresholdsStoreOpts {
  yamlPath: string;
  logger: Logger;
}

export class QualityThresholdsStore {
  private cfg: QualityThresholdsConfig = EMPTY;
  private readonly yamlPath: string;
  private readonly logger: Logger;

  constructor(opts: QualityThresholdsStoreOpts) {
    this.yamlPath = opts.yamlPath;
    this.logger = opts.logger;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.yamlPath, "utf8");
      const parsed = yaml.parse(raw) as unknown;
      this.cfg = normalize(parsed);
      this.logger.info("quality thresholds loaded from YAML", {
        path: this.yamlPath,
        models: Object.keys(this.cfg.models),
        has_defaults: Object.keys(this.cfg.defaults.metrics).length > 0,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
      this.cfg = EMPTY;
      this.logger.info("quality thresholds file missing — using empty defaults", {
        path: this.yamlPath,
      });
    }
  }

  get(): QualityThresholdsConfig {
    return this.cfg;
  }

  /** Effective thresholds for a model = defaults merged with model-specific. */
  effective(modelId: string): ModelThresholds {
    return mergeWithDefaults(this.cfg.defaults, this.cfg.models[modelId]);
  }

  async setModel(modelId: string, thresholds: ModelThresholds): Promise<QualityThresholdsConfig> {
    const validated = validateModel(thresholds);
    const next: QualityThresholdsConfig = {
      ...this.cfg,
      models: { ...this.cfg.models, [modelId]: validated },
    };
    this.cfg = next;
    await this.persist();
    this.logger.info("quality thresholds updated", {
      model_id: modelId,
      metric_count: Object.keys(validated.metrics).length,
    });
    return next;
  }

  // Persist via write-then-rename so the YAML is always whole.
  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.yamlPath), { recursive: true });
    const content = yaml.stringify(this.cfg, { sortMapEntries: false });
    const tmp = `${this.yamlPath}.tmp`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, this.yamlPath);
  }
}
