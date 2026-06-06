// ── Signal Correlation & IC ────────────────────────────────────────
// Pure functions for signal quality analysis.
// Defined in: docs/tdd/analytics.md, §1

// ── Types ──────────────────────────────────────────────────────────

export interface CorrelationResult {
  model_a: string;
  model_b: string;
  coefficient: number;
  method: "pearson" | "spearman";
  n: number;
}

export interface ICResult {
  ic: number;
  n: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rankArray(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(arr.length);
  for (let i = 0; i < indexed.length; i++) {
    ranks[indexed[i]!.i] = i + 1;
  }
  return ranks;
}

// ── Core Functions ─────────────────────────────────────────────────

export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));

  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  if (denom === 0) return 0;
  return sumXY / denom;
}

export function spearmanCorrelation(x: number[], y: number[]): number {
  return pearsonCorrelation(rankArray(x), rankArray(y));
}

export function computeSignalCorrelation(
  valuesA: number[],
  valuesB: number[],
  modelA: string,
  modelB: string,
  method: "pearson" | "spearman" = "spearman",
): CorrelationResult {
  const n = Math.min(valuesA.length, valuesB.length);
  const coeff =
    method === "pearson"
      ? pearsonCorrelation(valuesA, valuesB)
      : spearmanCorrelation(valuesA, valuesB);

  return { model_a: modelA, model_b: modelB, coefficient: coeff, method, n };
}

export function computeInformationCoefficient(predictions: number[], outcomes: number[]): ICResult {
  const n = Math.min(predictions.length, outcomes.length);
  if (n < 3) return { ic: 0, n };
  const ic = spearmanCorrelation(predictions.slice(0, n), outcomes.slice(0, n));
  return { ic, n };
}

export function computeICStability(
  predictions: number[],
  outcomes: number[],
  windowSize: number = 20,
): { mean_ic: number; std_ic: number; n_windows: number } {
  const ics: number[] = [];
  const n = Math.min(predictions.length, outcomes.length);

  for (let i = 0; i + windowSize <= n; i += windowSize) {
    const pSlice = predictions.slice(i, i + windowSize);
    const oSlice = outcomes.slice(i, i + windowSize);
    const ic = spearmanCorrelation(pSlice, oSlice);
    if (Number.isFinite(ic)) ics.push(ic);
  }

  if (ics.length === 0) return { mean_ic: 0, std_ic: 0, n_windows: 0 };

  const m = mean(ics);
  const variance = ics.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(ics.length - 1, 1);

  return { mean_ic: m, std_ic: Math.sqrt(variance), n_windows: ics.length };
}

export function computeSignalDecay(
  predictions: number[],
  outcomes: number[][],
  lags: number[],
): Array<{ lag: number; ic: number }> {
  return lags.map((lag, i) => {
    const o = outcomes[i];
    if (!o || o.length === 0) return { lag, ic: 0 };
    const { ic } = computeInformationCoefficient(predictions, o);
    return { lag, ic };
  });
}

export function computeTurnover(signals: number[]): number {
  if (signals.length < 2) return 0;
  let changes = 0;
  for (let i = 1; i < signals.length; i++) {
    if (signals[i] !== signals[i - 1]) changes++;
  }
  return changes / (signals.length - 1);
}
