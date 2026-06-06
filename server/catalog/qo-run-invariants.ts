// ── qo-run invariants ─────────────────────────────────────────────
// Deterministic checks over quant-optimizer wfo_results JSONs (the
// canonical contract in quant_optimizer.schema). Pure functions, no
// I/O — the CLI in scripts/check-qo-run-invariants.ts handles walking
// data/results/qo and reading files.
//
// Per QF-120 (reframed). The qo-runs collector (collectors/qo-runs.ts)
// silently skips malformed JSON.6; this
// module is the strict pre-deploy companion that surfaces violations
// instead of hiding them.

// ── Schema mirror ─────────────────────────────────────────────────
// Matches quant_optimizer.schema (Python). Kept loose ("unknown") at
// the parse boundary so the invariants can report typing problems as
// violations rather than throwing.

export interface OosPanel {
  n_trades?: unknown;
  net_pnl?: unknown;
  sortino?: unknown;
  hit_rate?: unknown;
  max_dd?: unknown;
  metadata?: unknown;
}

export interface Fold {
  fold_id?: unknown;
  is_start?: unknown;
  is_end?: unknown;
  oos_start?: unknown;
  oos_end?: unknown;
  is_metric?: unknown;
  best_params?: unknown;
  oos?: unknown;
  sampler?: unknown;
  n_trials_completed?: unknown;
  n_trials_target?: unknown;
  best_at_trial?: unknown;
  metadata?: unknown;
}

export interface WfoFile {
  schema_version?: unknown;
  strategy?: unknown;
  lineage_id?: unknown;
  folds?: unknown;
}

// ── Violation ─────────────────────────────────────────────────────

export interface Violation {
  // Stable kebab-case code. Tests assert against this; the runbook
  // entry is keyed by it.
  code: string;
  // "top" for run-level checks; otherwise the offending fold_id.
  scope: "top" | number;
  detail: string;
}

// ── Canonical required keys (must match Python schema) ────────────

const FOLD_REQUIRED = [
  "fold_id",
  "is_start",
  "is_end",
  "oos_start",
  "oos_end",
  "is_metric",
  "best_params",
  "oos",
] as const;

const OOS_REQUIRED = ["n_trades", "net_pnl", "sortino", "hit_rate", "max_dd"] as const;

// Anything above this means a producer ahead of this codebase.
export const SUPPORTED_SCHEMA_VERSION = 1;

// ── Helpers ────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ── Per-check functions ────────────────────────────────────────────
// Each push violations into `out`. Returns nothing — composability is
// via the array, not return values.

function checkStructure(file: WfoFile, out: Violation[]): { folds: unknown[] } | null {
  if (!isNonEmptyString(file.strategy)) {
    out.push({
      code: "qo.structure.missing-strategy",
      scope: "top",
      detail: "top-level 'strategy' must be a non-empty string",
    });
  }
  if (file.schema_version !== undefined) {
    if (typeof file.schema_version !== "number" || !Number.isInteger(file.schema_version)) {
      out.push({
        code: "qo.structure.bad-schema-version",
        scope: "top",
        detail: `schema_version must be an integer (got ${typeof file.schema_version})`,
      });
    } else if (file.schema_version > SUPPORTED_SCHEMA_VERSION) {
      out.push({
        code: "qo.structure.future-schema-version",
        scope: "top",
        detail: `schema_version=${file.schema_version} > supported ${SUPPORTED_SCHEMA_VERSION}; upgrade reader`,
      });
    }
  }
  if (!Array.isArray(file.folds)) {
    out.push({
      code: "qo.structure.missing-folds",
      scope: "top",
      detail: "top-level 'folds' must be an array",
    });
    return null;
  }
  if (file.folds.length === 0) {
    out.push({
      code: "qo.structure.empty-folds",
      scope: "top",
      detail: "'folds' must contain at least one fold",
    });
    return null;
  }
  return { folds: file.folds };
}

function foldScope(fold: Fold, index: number): "top" | number {
  return typeof fold.fold_id === "number" && Number.isInteger(fold.fold_id) ? fold.fold_id : index;
}

function checkFoldRequiredFields(fold: Fold, scope: "top" | number, out: Violation[]): void {
  const missing = FOLD_REQUIRED.filter((k) => !(k in (fold as Record<string, unknown>)));
  if (missing.length > 0) {
    out.push({
      code: "qo.fold.missing-fields",
      scope,
      detail: `missing required fields: ${missing.join(", ")}`,
    });
  }
}

function checkOosRequiredFields(fold: Fold, scope: "top" | number, out: Violation[]): void {
  if (!isObject(fold.oos)) return; // already flagged by missing-fields
  const oos = fold.oos as Record<string, unknown>;
  const missing = OOS_REQUIRED.filter((k) => !(k in oos));
  if (missing.length > 0) {
    out.push({
      code: "qo.oos.missing-fields",
      scope,
      detail: `oos panel missing required fields: ${missing.join(", ")}`,
    });
  }
}

function checkUniqueFoldIds(folds: Fold[], out: Violation[]): void {
  const seen = new Set<number>();
  for (const f of folds) {
    if (typeof f.fold_id !== "number" || !Number.isInteger(f.fold_id)) continue;
    if (seen.has(f.fold_id)) {
      out.push({
        code: "qo.fold.duplicate-id",
        scope: f.fold_id,
        detail: `fold_id ${f.fold_id} appears more than once`,
      });
    }
    seen.add(f.fold_id);
  }
}

function checkWindowSanity(fold: Fold, scope: "top" | number, out: Violation[]): void {
  const is_start = fold.is_start;
  const is_end = fold.is_end;
  const oos_start = fold.oos_start;
  const oos_end = fold.oos_end;
  if (
    typeof is_start !== "string" ||
    typeof is_end !== "string" ||
    typeof oos_start !== "string" ||
    typeof oos_end !== "string"
  ) {
    // Already covered by missing-fields if absent; non-string types
    // produce a separate violation here.
    return;
  }
  if (is_start > is_end) {
    out.push({
      code: "qo.window.is-inverted",
      scope,
      detail: `is_start (${is_start}) > is_end (${is_end})`,
    });
  }
  if (oos_start > oos_end) {
    out.push({
      code: "qo.window.oos-inverted",
      scope,
      detail: `oos_start (${oos_start}) > oos_end (${oos_end})`,
    });
  }
  if (is_end > oos_start) {
    out.push({
      code: "qo.window.is-oos-leak",
      scope,
      detail: `is_end (${is_end}) > oos_start (${oos_start}) — IS overlaps OOS`,
    });
  }
}

function checkWalkForwardDirection(folds: Fold[], out: Violation[]): void {
  // Sort by fold_id (skipping non-integer fold_ids; missing-fields will
  // have already flagged those).
  const sortable = folds.filter(
    (f): f is Fold & { fold_id: number; is_start: string } =>
      typeof f.fold_id === "number" &&
      Number.isInteger(f.fold_id) &&
      typeof f.is_start === "string",
  );
  const sorted = [...sortable].sort((a, b) => a.fold_id - b.fold_id);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.is_start < prev.is_start) {
      out.push({
        code: "qo.walk-forward.regression",
        scope: curr.fold_id,
        detail: `fold ${curr.fold_id} is_start (${curr.is_start}) < prior fold ${prev.fold_id} is_start (${prev.is_start})`,
      });
    }
  }
}

function checkTrialBookkeeping(fold: Fold, scope: "top" | number, out: Violation[]): void {
  const completed = fold.n_trials_completed;
  const target = fold.n_trials_target;
  const best = fold.best_at_trial;

  // best_at_trial bounds.
  if (best !== null && best !== undefined) {
    if (typeof best !== "number" || !Number.isInteger(best)) {
      out.push({
        code: "qo.trials.bad-best-at-trial",
        scope,
        detail: `best_at_trial must be integer or null (got ${typeof best})`,
      });
    } else if (typeof completed === "number" && Number.isInteger(completed)) {
      if (best < 0 || best >= completed) {
        out.push({
          code: "qo.trials.best-at-trial-out-of-range",
          scope,
          detail: `best_at_trial=${best} outside [0, n_trials_completed=${completed})`,
        });
      }
    }
  }

  // n_trials_completed ≤ n_trials_target when both set.
  if (
    typeof completed === "number" &&
    Number.isInteger(completed) &&
    typeof target === "number" &&
    Number.isInteger(target)
  ) {
    if (completed > target) {
      out.push({
        code: "qo.trials.over-budget",
        scope,
        detail: `n_trials_completed=${completed} > n_trials_target=${target}`,
      });
    }
  }
}

function checkOosSanity(fold: Fold, scope: "top" | number, out: Violation[]): void {
  if (!isObject(fold.oos)) return;
  const oos = fold.oos as OosPanel;

  if (isFiniteNumber(oos.n_trades) && oos.n_trades < 0) {
    out.push({
      code: "qo.oos.negative-trades",
      scope,
      detail: `oos.n_trades=${oos.n_trades} is negative`,
    });
  }
  if (isFiniteNumber(oos.hit_rate) && (oos.hit_rate < 0 || oos.hit_rate > 1)) {
    out.push({
      code: "qo.oos.hit-rate-out-of-range",
      scope,
      detail: `oos.hit_rate=${oos.hit_rate} outside [0, 1]`,
    });
  }
  if (isFiniteNumber(oos.max_dd) && oos.max_dd < 0) {
    out.push({
      code: "qo.oos.negative-max-dd",
      scope,
      detail: `oos.max_dd=${oos.max_dd} is negative; drawdowns are stored as positive magnitudes`,
    });
  }
}

// ── Public entry point ─────────────────────────────────────────────

export function validateWfoFile(parsed: unknown): Violation[] {
  const out: Violation[] = [];

  if (!isObject(parsed)) {
    out.push({
      code: "qo.structure.not-object",
      scope: "top",
      detail: `top-level JSON must be an object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    });
    return out;
  }

  const file = parsed as WfoFile;
  const struct = checkStructure(file, out);
  if (struct === null) return out;

  const folds = struct.folds as Fold[];
  checkUniqueFoldIds(folds, out);
  checkWalkForwardDirection(folds, out);

  folds.forEach((fold, index) => {
    const scope = foldScope(fold, index);
    checkFoldRequiredFields(fold, scope, out);
    checkOosRequiredFields(fold, scope, out);
    checkWindowSanity(fold, scope, out);
    checkTrialBookkeeping(fold, scope, out);
    checkOosSanity(fold, scope, out);
  });

  return out;
}

// ── CLI formatting helper ──────────────────────────────────────────

export function formatViolation(filepath: string, v: Violation): string {
  return `${filepath} · ${v.scope} · ${v.code} · ${v.detail}`;
}
