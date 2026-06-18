// ── Strategy analytics ───────────────────────────────────────────────
// Combined greeks, net debit/credit, max P/L, breakevens, and a payoff
// curve for a resolved multi-leg structure. Expiration payoffs are
// piecewise-linear in the underlying with kinks at each strike, so the
// global extrema and breakevens are found exactly at the breakpoints —
// no sampling error. Unbounded upside (e.g. long straddle) is detected
// from the asymptotic slope above the highest strike; downside is always
// bounded because the underlying cannot go below zero.

import type { ResolvedLeg, StrategyAnalytics, PayoffPoint } from "../../types/option-strategy.js";

const DEFAULT_MULTIPLIER = 100; // equity options; pass 1000 for CL futures options, etc.
const PAYOFF_SAMPLES = 60;

function sideSign(side: ResolvedLeg["side"]): 1 | -1 {
  return side === "buy" ? 1 : -1;
}

function intrinsic(right: ResolvedLeg["right"], strike: number, underlying: number): number {
  return right === "call" ? Math.max(underlying - strike, 0) : Math.max(strike - underlying, 0);
}

// P/L of the whole structure at expiration for a given underlying price,
// per 1 unit (× multiplier applied). Includes entry debit/credit.
function payoffAt(legs: ResolvedLeg[], underlying: number, multiplier: number): number {
  let pnl = 0;
  for (const leg of legs) {
    const s = sideSign(leg.side);
    const entry = leg.contract.mid;
    const value = intrinsic(leg.right, leg.contract.strike, underlying);
    pnl += s * (value - entry) * leg.ratio * multiplier;
  }
  return pnl;
}

// Net P/L slope above the highest strike (calls contribute +1/unit there,
// puts 0). > 0 ⇒ unbounded profit upside; < 0 ⇒ unbounded loss upside.
function upperSlope(legs: ResolvedLeg[]): number {
  let slope = 0;
  for (const leg of legs) {
    if (leg.right === "call") slope += sideSign(leg.side) * leg.ratio;
  }
  return slope;
}

export function computeAnalytics(
  legs: ResolvedLeg[],
  multiplier: number = DEFAULT_MULTIPLIER,
): StrategyAnalytics {
  let netDelta = 0;
  let netGamma = 0;
  let netTheta = 0;
  let netVega = 0;
  let netDebit = 0;
  for (const leg of legs) {
    const s = sideSign(leg.side);
    const c = leg.contract;
    netDelta += s * leg.ratio * c.delta;
    netGamma += s * leg.ratio * c.gamma;
    netTheta += s * leg.ratio * c.theta;
    netVega += s * leg.ratio * c.vega;
    netDebit += s * leg.ratio * c.mid * multiplier;
  }

  // Breakpoints: every strike (where the piecewise-linear payoff kinks)
  // plus S=0. The global max/min live at these for a bounded payoff.
  const strikes = [...new Set(legs.map((l) => l.contract.strike))].sort((a, b) => a - b);
  const breakpoints = [0, ...strikes];
  const slope = upperSlope(legs);

  const bpPnls = breakpoints.map((s) => payoffAt(legs, s, multiplier));
  const maxProfit = slope > 0 ? null : Math.max(...bpPnls);
  const maxLoss = slope < 0 ? null : Math.min(...bpPnls);

  // Breakevens: zero-crossings of the piecewise-linear payoff between
  // adjacent breakpoints (exact via linear interpolation at the kinks).
  const breakevens: number[] = [];
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const x0 = breakpoints[i]!;
    const x1 = breakpoints[i + 1]!;
    const y0 = bpPnls[i]!;
    const y1 = bpPnls[i + 1]!;
    if (y0 === 0) breakevens.push(x0);
    if ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0)) {
      breakevens.push(x0 + ((0 - y0) / (y1 - y0)) * (x1 - x0));
    }
  }
  // A breakeven beyond the highest strike (when the tail slopes back to 0).
  const hiStrike = strikes[strikes.length - 1] ?? 0;
  if (slope !== 0) {
    const yHi = payoffAt(legs, hiStrike, multiplier);
    const cross = hiStrike + -yHi / (slope * multiplier);
    if (cross > hiStrike) breakevens.push(cross);
  }

  // Payoff curve for display: spot-centred band that always spans the
  // strikes, sampled evenly with the kinks merged in for crisp corners.
  const spot = legs[0]!.contract.underlyingPrice;
  const lo = Math.max(0, Math.min(spot * 0.7, (strikes[0] ?? spot) * 0.9));
  const hi = Math.max(spot * 1.3, hiStrike * 1.1);
  const xs = new Set<number>(strikes.filter((s) => s >= lo && s <= hi));
  for (let i = 0; i <= PAYOFF_SAMPLES; i++) xs.add(lo + ((hi - lo) * i) / PAYOFF_SAMPLES);
  const payoff: PayoffPoint[] = [...xs]
    .sort((a, b) => a - b)
    .map((underlying) => ({ underlying, pnl: payoffAt(legs, underlying, multiplier) }));

  return {
    netDelta,
    netGamma,
    netTheta,
    netVega,
    netDebit,
    maxProfit,
    maxLoss,
    breakevens: [...new Set(breakevens.map((b) => Math.round(b * 100) / 100))].sort((a, b) => a - b),
    payoff,
  };
}
