import { BS, Black76 } from "./bs.js";
import type { OptionApi } from "./bs.js";

// ── Types ─────────────────────────────────────────────────────────
// Positions accept plain strings for `type`/`direction` so callers can
// pass object literals without const assertions. Numeric option fields
// are optional: the `Future` branch and netPremium never read the
// option-only fields, so they may be omitted for those positions.

export interface EvalPosition {
  type: string;
  direction: string;
  qty: number;
  multiplier: number;
  premium: number;
  strike?: number;
  entryPrice?: number;
  dte?: number;
  iv?: number;
  assetClass?: string;
}

export interface EvalScenario {
  name: string;
  prob: number;
  priceMove: number;
  iv_shift: number;
}

export interface ScenarioResult {
  name: string;
  prob: number;
  pm: number;
  pnl: number;
  evc: number;
}

export interface EvalResult {
  scResults: ScenarioResult[];
  totalEV: number;
  maxLoss: number;
  maxGain: number;
}

export interface PortfolioGreeks {
  d: number;
  g: number;
  t: number;
  v: number;
}

// Select pricing model based on position asset class
const model = (p: EvalPosition): OptionApi => (p.assetClass === "futures" ? Black76 : BS);

export function evalPortfolio(
  positions: EvalPosition[],
  scenarios: EvalScenario[],
  spot: number,
  rfr: number,
  hold: number,
): EvalResult {
  if (!positions.length || !scenarios.length)
    return { scResults: [], totalEV: 0, maxLoss: 0, maxGain: 0 };

  const scResults = scenarios.map((sc) => {
    const fs = spot * (1 + sc.priceMove);
    let pnl = 0;
    for (const p of positions) {
      const d = p.direction === "Long" ? 1 : -1;
      const n = p.qty * p.multiplier;
      if (p.type === "Future") {
        pnl += d * n * (fs - (p.entryPrice as number));
      } else {
        const T = Math.max(((p.dte as number) - hold) / 365, 0);
        const niv = Math.max(0.05, (p.iv as number) + sc.iv_shift);
        const m = model(p);
        const price = (p.type === "Call" ? m.call : m.put)(fs, p.strike as number, rfr, T, niv);
        pnl += d * n * (price - p.premium);
      }
    }
    return { name: sc.name, prob: sc.prob, pm: sc.priceMove, pnl, evc: pnl * sc.prob };
  });

  return {
    scResults,
    totalEV: scResults.reduce((s, r) => s + r.evc, 0),
    maxLoss: Math.min(...scResults.map((r) => r.pnl)),
    maxGain: Math.max(...scResults.map((r) => r.pnl)),
  };
}

export function calcGreeks(positions: EvalPosition[], spot: number, rfr: number): PortfolioGreeks {
  const g: PortfolioGreeks = { d: 0, g: 0, t: 0, v: 0 };
  for (const p of positions) {
    const dir = p.direction === "Long" ? 1 : -1;
    const n = p.qty * p.multiplier;
    if (p.type === "Future") {
      g.d += dir * n;
      continue;
    }
    const T = Math.max((p.dte as number) / 365, 0.001);
    const m = model(p);
    const strike = p.strike as number;
    const iv = p.iv as number;
    const t = p.type as "Call" | "Put";
    g.d += dir * n * m.delta(spot, strike, rfr, T, iv, t);
    g.g += dir * n * m.gamma(spot, strike, rfr, T, iv);
    g.t += dir * n * m.theta(spot, strike, rfr, T, iv, t);
    g.v += dir * n * m.vega(spot, strike, rfr, T, iv);
  }
  return g;
}

export function netPremium(positions: EvalPosition[]): number {
  return positions.reduce(
    (s, p) =>
      p.type === "Future"
        ? s
        : s + (p.direction === "Long" ? 1 : -1) * p.qty * p.multiplier * p.premium,
    0,
  );
}
