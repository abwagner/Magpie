import { BS } from "./bs.js";

// ── Breeden-Litzenberger PDF Extraction ─────────────────────────────────
// Extract risk-neutral probability density from a vol surface using the
// finite-difference approximation of the second derivative of call prices
// with respect to strike:
//   q(K) = e^(rT) × [C(K-δ) - 2C(K) + C(K+δ)] / δ²

export function extractMarketPDF(volSurface, dte, options = {}) {
  const {
    strikeStep = 0.5, // δ for finite differences
    rangeMultiple = 0.5, // how far from spot (as fraction) to extend
    rfr,
  } = options;

  const spot = volSurface.spot;
  const r = rfr ?? volSurface.rfr;
  const T = Math.max(dte / 365, 1 / 365);

  const loStrike = Math.floor(spot * (1 - rangeMultiple));
  const hiStrike = Math.ceil(spot * (1 + rangeMultiple));

  const strikes = [];
  const density = [];
  const delta = strikeStep;
  const discount = Math.exp(r * T);

  for (let K = loStrike + delta; K <= hiStrike - delta; K += delta) {
    const cMinus = volSurface.callPrice(K - delta, dte);
    const cCenter = volSurface.callPrice(K, dte);
    const cPlus = volSurface.callPrice(K + delta, dte);

    // Breeden-Litzenberger finite difference
    const q = (discount * (cMinus - 2 * cCenter + cPlus)) / (delta * delta);

    strikes.push(K);
    density.push(Math.max(q, 0)); // enforce non-negative density
  }

  // normalize so PDF integrates to ~1.0
  const totalArea = density.reduce((s, d) => s + d * delta, 0);
  if (totalArea > 0) {
    for (let i = 0; i < density.length; i++) {
      density[i] /= totalArea;
    }
  }

  // compute CDF
  const cdf = new Array(strikes.length);
  let cumulative = 0;
  for (let i = 0; i < strikes.length; i++) {
    cumulative += density[i] * delta;
    cdf[i] = Math.min(cumulative, 1);
  }

  return {
    strikes,
    density,
    cdf,
    dte,
    spot,
    strikeStep: delta,
    // summary statistics
    expectedValue: strikes.reduce((s, k, i) => s + k * density[i] * delta, 0),
    variance: (() => {
      const mean = strikes.reduce((s, k, i) => s + k * density[i] * delta, 0);
      return strikes.reduce((s, k, i) => s + (k - mean) ** 2 * density[i] * delta, 0);
    })(),
  };
}

// ── Log-Normal Reference PDF ────────────────────────────────────────────
// Generate a log-normal PDF (BS assumption) for comparison with market PDF
export function logNormalPDF(spot, rfr, T, sigma, strikes) {
  const density = strikes.map((K) => {
    if (K <= 0) return 0;
    const d = (Math.log(K / spot) - (rfr - (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
    return Math.exp((-d * d) / 2) / (K * sigma * Math.sqrt(2 * Math.PI * T));
  });

  // normalize
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : 1;
  const total = density.reduce((s, d) => s + d * step, 0);
  if (total > 0) {
    for (let i = 0; i < density.length; i++) density[i] /= total;
  }

  return density;
}

// ── Model Blending ──────────────────────────────────────────────────────
// Blend multiple PDFs with configurable weights.
// Each model output: { strikes, density, ... }
// Weights are normalized to sum to 1.
export function blendPDFs(models, weights) {
  if (!models.length) return null;
  if (models.length === 1) return models[0];

  // normalize weights
  const totalW = weights.reduce((s, w) => s + w, 0);
  const normWeights = weights.map((w) => w / totalW);

  // use the first model's strike grid
  const strikes = models[0].strikes;
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : 1;

  const blended = new Array(strikes.length).fill(0);
  for (let m = 0; m < models.length; m++) {
    const pdf = models[m];
    const w = normWeights[m];

    for (let i = 0; i < strikes.length; i++) {
      // find closest strike in this model's grid
      const k = strikes[i];
      let val = 0;
      if (pdf.strikes.length) {
        const idx = findClosestIndex(pdf.strikes, k);
        val = pdf.density[idx] || 0;
      }
      blended[i] += w * val;
    }
  }

  // normalize
  const total = blended.reduce((s, d) => s + d * step, 0);
  if (total > 0) {
    for (let i = 0; i < blended.length; i++) blended[i] /= total;
  }

  // compute CDF
  const cdf = new Array(strikes.length);
  let cumulative = 0;
  for (let i = 0; i < strikes.length; i++) {
    cumulative += blended[i] * step;
    cdf[i] = Math.min(cumulative, 1);
  }

  return {
    strikes,
    density: blended,
    cdf,
    dte: models[0].dte,
    spot: models[0].spot,
    strikeStep: step,
    expectedValue: strikes.reduce((s, k, i) => s + k * blended[i] * step, 0),
    variance: (() => {
      const mean = strikes.reduce((s, k, i) => s + k * blended[i] * step, 0);
      return strikes.reduce((s, k, i) => s + (k - mean) ** 2 * blended[i] * step, 0);
    })(),
  };
}

// ── Edge Computation ────────────────────────────────────────────────────
// Compute the probability edge: model_pdf - market_pdf at each strike
export function computeEdge(modelPDF, marketPDF) {
  const strikes = marketPDF.strikes;
  const edge = new Array(strikes.length);
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : 1;

  for (let i = 0; i < strikes.length; i++) {
    const k = strikes[i];
    const modelVal = interpolatePDF(modelPDF, k);
    const marketVal = marketPDF.density[i] || 0;
    edge[i] = modelVal - marketVal;
  }

  return {
    strikes,
    edge,
    dte: marketPDF.dte,
    spot: marketPDF.spot,
    // summary: net directional edge
    expectedPriceDelta: strikes.reduce((s, k, i) => s + k * edge[i] * step, 0),
    // summary: variance edge
    varianceDelta: (() => {
      const spot = marketPDF.spot;
      return strikes.reduce((s, k, i) => s + (k - spot) ** 2 * edge[i] * step, 0);
    })(),
  };
}

function findClosestIndex(arr, target) {
  let lo = 0,
    hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1] - target) < Math.abs(arr[lo] - target)) return lo - 1;
  return lo;
}

function interpolatePDF(pdf, strike) {
  const idx = findClosestIndex(pdf.strikes, strike);
  return pdf.density[idx] || 0;
}
