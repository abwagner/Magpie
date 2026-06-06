// ── Edge-to-Greeks Translation ──────────────────────────────────────────
// Convert probability edge surface into target portfolio Greeks.
// The edge = model_pdf - market_pdf at each (strike, expiry).

import { BS } from "./bs.js";

// Compute target Greeks from an edge surface at a single expiry.
export function edgeToGreeks(edgeData, spot, rfr = 0.05) {
  const { strikes, edge, dte } = edgeData;
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : 1;
  const T = Math.max(dte / 365, 1 / 365);

  // ── Directional Edge → Delta Target ──────────────────────────────────
  // E_model[S] - E_market[S] = Σ K × edge(K) × δK
  // Positive = model expects higher price → want positive delta
  const expectedPriceDelta = strikes.reduce((s, K, i) => s + K * edge[i] * step, 0);

  // Normalize to a delta target: how many shares-equivalent of directional exposure
  // Scale by spot to get a meaningful delta number
  const targetDelta = expectedPriceDelta / spot;

  // ── Volatility Edge → Vega/Gamma Target ──────────────────────────────
  // Var_model - Var_market = volatility edge
  // Positive = model expects more variance → want long vega/gamma
  const varianceDelta = strikes.reduce((s, K, i) => s + (K - spot) ** 2 * edge[i] * step, 0);

  // Positive variance delta → want long gamma/vega
  // Normalize by spot^2 for a meaningful number
  const targetVega = (varianceDelta / (spot * spot)) * 100; // per 1% vol move

  // ── Skew Edge ────────────────────────────────────────────────────────
  // Third moment of edge: asymmetry
  // Positive = more edge on upside → want positive skew delta
  const skewEdge = strikes.reduce((s, K, i) => s + ((K - spot) / spot) ** 3 * edge[i] * step, 0);

  // ── Kurtosis Edge ────────────────────────────────────────────────────
  // Fourth moment: tail edge
  // Positive = more edge in wings → want wing exposure (straddles)
  // Negative = more edge in center → want to sell wings (condors)
  const kurtosisEdge = strikes.reduce(
    (s, K, i) => s + ((K - spot) / spot) ** 4 * edge[i] * step,
    0,
  );

  // ── Confidence ───────────────────────────────────────────────────────
  // Total absolute edge — how much overall mispricing we detect
  const totalAbsEdge = strikes.reduce((s, _, i) => s + Math.abs(edge[i]) * step, 0);

  return {
    targetDelta,
    targetVega,
    skewEdge,
    kurtosisEdge,
    totalAbsEdge,
    expectedPriceDelta,
    varianceDelta,
    dte,

    // convenience: recommended direction strings
    deltaDirection: targetDelta > 0.01 ? "bullish" : targetDelta < -0.01 ? "bearish" : "neutral",
    vegaDirection: targetVega > 0.1 ? "long vol" : targetVega < -0.1 ? "short vol" : "neutral",
    skewDirection: skewEdge > 0 ? "upside skew" : skewEdge < 0 ? "downside skew" : "symmetric",
    kurtosisDirection: kurtosisEdge > 0 ? "buy wings" : kurtosisEdge < 0 ? "sell wings" : "neutral",
  };
}

// Combine edge-greeks across multiple expiries with term structure weighting
export function multiExpiryEdgeGreeks(edgeDataArray, spot, rfr = 0.05) {
  if (!edgeDataArray.length) {
    return {
      targetDelta: 0,
      targetVega: 0,
      skewEdge: 0,
      kurtosisEdge: 0,
      totalAbsEdge: 0,
      expiries: [],
    };
  }

  const perExpiry = edgeDataArray.map((ed) => ({
    ...edgeToGreeks(ed, spot, rfr),
    expiry: ed.expiry,
  }));

  // weight by inverse DTE (near-term edges are more actionable)
  const totalWeight = perExpiry.reduce((s, g) => s + 1 / Math.max(g.dte, 1), 0);

  const combined = {
    targetDelta: 0,
    targetVega: 0,
    skewEdge: 0,
    kurtosisEdge: 0,
    totalAbsEdge: 0,
    expiries: perExpiry,
  };

  for (const g of perExpiry) {
    const w = 1 / Math.max(g.dte, 1) / totalWeight;
    combined.targetDelta += w * g.targetDelta;
    combined.targetVega += w * g.targetVega;
    combined.skewEdge += w * g.skewEdge;
    combined.kurtosisEdge += w * g.kurtosisEdge;
    combined.totalAbsEdge += g.totalAbsEdge;
  }

  combined.deltaDirection =
    combined.targetDelta > 0.01 ? "bullish" : combined.targetDelta < -0.01 ? "bearish" : "neutral";
  combined.vegaDirection =
    combined.targetVega > 0.1 ? "long vol" : combined.targetVega < -0.1 ? "short vol" : "neutral";

  return combined;
}
