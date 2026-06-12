// ── P&L and Greek Curves ─────────────────────────────────────────────────
// Compute P&L and Greeks across a range of underlying prices.
// Used by the Scenario Builder for 2D charts and 3D surfaces.

import { BS, Black76 } from "./bs.js";
import type { OptionApi } from "./bs.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface CurvePosition {
  strike: number;
  type: "Call" | "Put" | string;
  direction: "Long" | "Short" | string;
  qty: number;
  premium?: number;
  mid?: number;
  last?: number;
  iv?: number;
  dte?: number;
  multiplier?: number;
  assetClass?: string;
}

export interface CurveOptions {
  priceRange?: [number, number];
  priceStep?: number;
  holdDays?: number;
  ivShift?: number;
  pricingModel?: OptionApi | null;
}

export interface SurfaceOptions {
  priceRange?: [number, number];
  priceStep?: number;
  maxDays?: number;
  dayStep?: number;
  ivShift?: number;
  pricingModel?: OptionApi | null;
}

export interface PnlCurvePoint {
  price: number;
  pnl: number;
}

export interface GreekCurvePoint {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface PnlSurfaceResult {
  prices: number[];
  days: number[];
  pnl: number[][];
}

type PreparedPnlPosition = CurvePosition & {
  dir: number;
  pm: OptionApi;
  T: number;
  price: number;
};

type PreparedGreekPosition = CurvePosition & {
  dir: number;
  pm: OptionApi;
  T: number;
};

type PreparedSurfacePosition = CurvePosition & {
  dir: number;
  pm: OptionApi;
  T: number;
  entryPrice: number;
};

// Compute P&L curve across price range for a set of positions
// Each position: { strike, type: "Call"|"Put", direction: "Long"|"Short", qty, premium, iv, dte, multiplier, assetClass }
export function pnlCurve(
  positions: CurvePosition[],
  spot: number,
  rfr = 0.05,
  options: CurveOptions = {},
): PnlCurvePoint[] {
  const {
    priceRange = [spot * 0.5, spot * 1.5],
    priceStep = spot * 0.005,
    holdDays = 0,
    ivShift = 0,
    pricingModel = null, // auto-detect from assetClass
  } = options;

  // Current portfolio value
  let currentValue = 0;
  const posData: PreparedPnlPosition[] = positions
    .filter((p) => p.type === "Call" || p.type === "Put")
    .map((p) => {
      const dir = p.direction === "Long" ? 1 : -1;
      const pm = pricingModel || (p.assetClass === "futures" ? Black76 : BS);
      const T = Math.max((p.dte || 30) / 365, 1 / 365);
      const price = p.premium || p.mid || p.last || 0;
      currentValue += dir * p.qty * price * (p.multiplier || 100);
      return { ...p, dir, pm, T, price };
    });

  const points: PnlCurvePoint[] = [];
  for (let price = priceRange[0]; price <= priceRange[1]; price += priceStep) {
    let newValue = 0;
    for (const p of posData) {
      const newT = Math.max(p.T - holdDays / 365, 1e-4);
      const newIV = Math.max((p.iv || 0.3) + ivShift, 0.01);
      const fn = p.type === "Call" ? p.pm.call : p.pm.put;
      const optPrice = fn(price, p.strike, rfr, newT, newIV);
      newValue += p.dir * p.qty * optPrice * (p.multiplier || 100);
    }
    points.push({ price, pnl: newValue - currentValue });
  }

  return points;
}

// Compute Greek curves across price range
export function greekCurves(
  positions: CurvePosition[],
  spot: number,
  rfr = 0.05,
  options: CurveOptions = {},
): GreekCurvePoint[] {
  const {
    priceRange = [spot * 0.5, spot * 1.5],
    priceStep = spot * 0.005,
    holdDays = 0,
    ivShift = 0,
    pricingModel = null,
  } = options;

  const posData: PreparedGreekPosition[] = positions
    .filter((p) => p.type === "Call" || p.type === "Put")
    .map((p) => {
      const dir = p.direction === "Long" ? 1 : -1;
      const pm = pricingModel || (p.assetClass === "futures" ? Black76 : BS);
      const T = Math.max((p.dte || 30) / 365, 1 / 365);
      return { ...p, dir, pm, T };
    });

  const points: GreekCurvePoint[] = [];
  for (let price = priceRange[0]; price <= priceRange[1]; price += priceStep) {
    let delta = 0,
      gamma = 0,
      theta = 0,
      vega = 0;
    for (const p of posData) {
      const newT = Math.max(p.T - holdDays / 365, 1e-4);
      const newIV = Math.max((p.iv || 0.3) + ivShift, 0.01);
      const type = p.type === "Call" ? "Call" : "Put";
      const mult = p.multiplier || 100;
      delta += p.dir * p.qty * mult * p.pm.delta(price, p.strike, rfr, newT, newIV, type);
      gamma += p.dir * p.qty * mult * p.pm.gamma(price, p.strike, rfr, newT, newIV);
      theta += p.dir * p.qty * mult * p.pm.theta(price, p.strike, rfr, newT, newIV, type);
      vega += p.dir * p.qty * mult * p.pm.vega(price, p.strike, rfr, newT, newIV);
    }
    points.push({ price, delta, gamma, theta, vega });
  }

  return points;
}

// Compute P&L surface (price × time) for 3D visualization
export function pnlSurface(
  positions: CurvePosition[],
  spot: number,
  rfr = 0.05,
  options: SurfaceOptions = {},
): PnlSurfaceResult {
  const {
    priceRange = [spot * 0.7, spot * 1.3],
    priceStep = spot * 0.01,
    maxDays = 60,
    dayStep = 1,
    ivShift = 0,
    pricingModel = null,
  } = options;

  const posData: PreparedSurfacePosition[] = positions
    .filter((p) => p.type === "Call" || p.type === "Put")
    .map((p) => {
      const dir = p.direction === "Long" ? 1 : -1;
      const pm = pricingModel || (p.assetClass === "futures" ? Black76 : BS);
      const T = Math.max((p.dte || 30) / 365, 1 / 365);
      const price = p.premium || p.mid || p.last || 0;
      return { ...p, dir, pm, T, entryPrice: price };
    });

  let currentValue = 0;
  for (const p of posData) {
    currentValue += p.dir * p.qty * p.entryPrice * (p.multiplier || 100);
  }

  const prices: number[] = [];
  const days: number[] = [];
  const pnl: number[][] = [];

  for (let price = priceRange[0]; price <= priceRange[1]; price += priceStep) {
    prices.push(price);
  }
  for (let d = 0; d <= maxDays; d += dayStep) {
    days.push(d);
  }

  for (let di = 0; di < days.length; di++) {
    const row: number[] = [];
    for (let pi = 0; pi < prices.length; pi++) {
      let newValue = 0;
      for (const p of posData) {
        const newT = Math.max(p.T - (days[di] as number) / 365, 1e-4);
        const newIV = Math.max((p.iv || 0.3) + ivShift, 0.01);
        const fn = p.type === "Call" ? p.pm.call : p.pm.put;
        newValue +=
          p.dir * p.qty * fn(prices[pi] as number, p.strike, rfr, newT, newIV) * (p.multiplier || 100);
      }
      row.push(newValue - currentValue);
    }
    pnl.push(row);
  }

  return { prices, days, pnl };
}
