import { BS, Black76 } from "./bs.js";

// Select pricing model based on position asset class
const model = (p) => (p.assetClass === "futures" ? Black76 : BS);

export function evalPortfolio(positions, scenarios, spot, rfr, hold) {
  if (!positions.length || !scenarios.length)
    return { scResults: [], totalEV: 0, maxLoss: 0, maxGain: 0 };

  const scResults = scenarios.map((sc) => {
    const fs = spot * (1 + sc.priceMove);
    let pnl = 0;
    for (const p of positions) {
      const d = p.direction === "Long" ? 1 : -1;
      const n = p.qty * p.multiplier;
      if (p.type === "Future") {
        pnl += d * n * (fs - p.entryPrice);
      } else {
        const T = Math.max((p.dte - hold) / 365, 0);
        const niv = Math.max(0.05, p.iv + sc.iv_shift);
        const m = model(p);
        const price = (p.type === "Call" ? m.call : m.put)(fs, p.strike, rfr, T, niv);
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

export function calcGreeks(positions, spot, rfr) {
  const g = { d: 0, g: 0, t: 0, v: 0 };
  for (const p of positions) {
    const dir = p.direction === "Long" ? 1 : -1;
    const n = p.qty * p.multiplier;
    if (p.type === "Future") {
      g.d += dir * n;
      continue;
    }
    const T = Math.max(p.dte / 365, 0.001);
    const m = model(p);
    g.d += dir * n * m.delta(spot, p.strike, rfr, T, p.iv, p.type);
    g.g += dir * n * m.gamma(spot, p.strike, rfr, T, p.iv);
    g.t += dir * n * m.theta(spot, p.strike, rfr, T, p.iv, p.type);
    g.v += dir * n * m.vega(spot, p.strike, rfr, T, p.iv);
  }
  return g;
}

export function netPremium(positions) {
  return positions.reduce(
    (s, p) =>
      p.type === "Future"
        ? s
        : s + (p.direction === "Long" ? 1 : -1) * p.qty * p.multiplier * p.premium,
    0,
  );
}
