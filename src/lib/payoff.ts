// ── P&L / Payoff Calculations ─────────────────────────────────────
// Pure functions for option payoff diagrams. No I/O.

import { BS } from "./bs.js";

// A single leg in a P&L calculation.
export interface PayoffLeg {
  side: "call" | "put";
  strike: number;
  premium: number;
  quantity: number;
  iv?: number;
  dte?: number;
}

export interface PayoffPoint {
  spot: number;
  pnl: number;
}

// Payoff of a single leg at expiry for a given spot price.
// Premium is per-contract (not per-share). Quantity is signed
// (+N = long, -N = short).
export function legPayoffAtExpiry(leg: PayoffLeg, spotPrice: number): number {
  const intrinsic =
    leg.side === "call" ? Math.max(0, spotPrice - leg.strike) : Math.max(0, leg.strike - spotPrice);
  return (intrinsic - leg.premium) * leg.quantity * 100;
}

// Total P&L of all legs at expiry for a given spot price.
export function payoffAtExpiry(legs: PayoffLeg[], spotPrice: number): number {
  return legs.reduce((sum, leg) => sum + legPayoffAtExpiry(leg, spotPrice), 0);
}

// Payoff of a single leg at a given DTE using Black-Scholes.
// Useful for showing "P&L today" vs "P&L at expiry".
export function legPayoffAtDte(
  leg: PayoffLeg,
  spotPrice: number,
  daysLeft: number,
  rfr = 0.05,
): number {
  if (daysLeft <= 0) return legPayoffAtExpiry(leg, spotPrice);
  const T = daysLeft / 365;
  const iv = leg.iv ?? 0.25;
  const theoretical =
    leg.side === "call"
      ? BS.call(spotPrice, leg.strike, rfr, T, iv)
      : BS.put(spotPrice, leg.strike, rfr, T, iv);
  return (theoretical - leg.premium) * leg.quantity * 100;
}

// Total P&L of all legs at a given DTE for a given spot price.
export function payoffAtDte(
  legs: PayoffLeg[],
  spotPrice: number,
  daysLeft: number,
  rfr = 0.05,
): number {
  return legs.reduce((sum, leg) => sum + legPayoffAtDte(leg, spotPrice, daysLeft, rfr), 0);
}

// Generate a P&L curve: array of { spot, pnl } for charting.
// daysLeft: null = at expiry
export function generatePayoffCurve(
  legs: PayoffLeg[],
  spotMin: number,
  spotMax: number,
  steps = 200,
  daysLeft: number | null = null,
): PayoffPoint[] {
  const points: PayoffPoint[] = [];
  const step = (spotMax - spotMin) / steps;
  for (let i = 0; i <= steps; i++) {
    const spot = spotMin + step * i;
    const pnl =
      daysLeft != null && daysLeft > 0
        ? payoffAtDte(legs, spot, daysLeft)
        : payoffAtExpiry(legs, spot);
    points.push({ spot, pnl });
  }
  return points;
}

// Find breakeven points (where P&L crosses zero) from a curve.
export function findBreakevens(curve: PayoffPoint[]): number[] {
  const breakevens: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1];
    const curr = curve[i];
    if (prev === undefined || curr === undefined) continue;
    if ((prev.pnl <= 0 && curr.pnl > 0) || (prev.pnl >= 0 && curr.pnl < 0)) {
      // Linear interpolation
      const ratio = Math.abs(prev.pnl) / (Math.abs(prev.pnl) + Math.abs(curr.pnl));
      breakevens.push(prev.spot + ratio * (curr.spot - prev.spot));
    }
  }
  return breakevens;
}
