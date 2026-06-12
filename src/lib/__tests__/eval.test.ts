import { describe, it, expect } from "vitest";
import { evalPortfolio, calcGreeks, netPremium } from "../eval.js";

const scenarios = [
  { name: "Down", prob: 0.3, priceMove: -0.1, iv_shift: 0.05 },
  { name: "Flat", prob: 0.4, priceMove: 0, iv_shift: 0 },
  { name: "Up", prob: 0.3, priceMove: 0.1, iv_shift: -0.03 },
];

describe("evalPortfolio", () => {
  it("returns zeros for empty positions", () => {
    const r = evalPortfolio([], scenarios, 100, 0.05, 30);
    expect(r.totalEV).toBe(0);
    expect(r.scResults).toEqual([]);
  });

  it("returns zeros for empty scenarios", () => {
    const pos = [
      {
        type: "Call",
        direction: "Long",
        qty: 1,
        multiplier: 100,
        entryPrice: 100,
        strike: 100,
        premium: 5,
        dte: 30,
        iv: 0.2,
      },
    ];
    const r = evalPortfolio(pos, [], 100, 0.05, 30);
    expect(r.totalEV).toBe(0);
  });

  it("computes P&L for a long call", () => {
    const pos = [
      {
        type: "Call",
        direction: "Long",
        qty: 1,
        multiplier: 100,
        entryPrice: 100,
        strike: 100,
        premium: 5,
        dte: 60,
        iv: 0.2,
      },
    ];
    const r = evalPortfolio(pos, scenarios, 100, 0.05, 30);
    expect(r.scResults).toHaveLength(3);
    expect(r.scResults[0]!.name).toBe("Down");
    // down scenario: spot drops 10%, call should lose value
    expect(r.scResults[0]!.pnl).toBeLessThan(0);
    // up scenario: spot rises 10%, call should gain
    expect(r.scResults[2]!.pnl).toBeGreaterThan(r.scResults[0]!.pnl);
  });

  it("computes P&L for a future", () => {
    const pos = [
      {
        type: "Future",
        direction: "Long",
        qty: 1,
        multiplier: 100,
        entryPrice: 100,
        strike: 0,
        premium: 0,
        dte: 0,
        iv: 0,
      },
    ];
    const r = evalPortfolio(pos, scenarios, 100, 0.05, 30);
    // down 10%: P&L = 1 * 100 * (90 - 100) = -1000
    expect(r.scResults[0]!.pnl).toBeCloseTo(-1000, 0);
    // flat: P&L = 0
    expect(r.scResults[1]!.pnl).toBeCloseTo(0, 0);
    // up 10%: P&L = 1000
    expect(r.scResults[2]!.pnl).toBeCloseTo(1000, 0);
  });

  it("EV is probability-weighted sum", () => {
    const pos = [
      {
        type: "Future",
        direction: "Long",
        qty: 1,
        multiplier: 100,
        entryPrice: 100,
        strike: 0,
        premium: 0,
        dte: 0,
        iv: 0,
      },
    ];
    const r = evalPortfolio(pos, scenarios, 100, 0.05, 30);
    const expectedEV = r.scResults.reduce((s, sc) => s + sc.evc, 0);
    expect(r.totalEV).toBeCloseTo(expectedEV, 6);
  });

  it("short position inverts P&L", () => {
    const longPos = [
      {
        type: "Call",
        direction: "Long",
        qty: 1,
        multiplier: 100,
        entryPrice: 100,
        strike: 100,
        premium: 5,
        dte: 60,
        iv: 0.2,
      },
    ];
    const shortPos = [
      {
        type: "Call",
        direction: "Short",
        qty: 1,
        multiplier: 100,
        entryPrice: 100,
        strike: 100,
        premium: 5,
        dte: 60,
        iv: 0.2,
      },
    ];
    const rLong = evalPortfolio(longPos, scenarios, 100, 0.05, 30);
    const rShort = evalPortfolio(shortPos, scenarios, 100, 0.05, 30);
    expect(rLong.totalEV).toBeCloseTo(-rShort.totalEV, 4);
  });

  it("maxLoss and maxGain are correct", () => {
    const pos = [
      {
        type: "Future",
        direction: "Long",
        qty: 1,
        multiplier: 100,
        entryPrice: 100,
        strike: 0,
        premium: 0,
        dte: 0,
        iv: 0,
      },
    ];
    const r = evalPortfolio(pos, scenarios, 100, 0.05, 30);
    expect(r.maxLoss).toBe(Math.min(...r.scResults.map((s) => s.pnl)));
    expect(r.maxGain).toBe(Math.max(...r.scResults.map((s) => s.pnl)));
  });
});

describe("calcGreeks", () => {
  it("future has delta = qty * multiplier, zero greeks otherwise", () => {
    const pos = [
      {
        type: "Future",
        direction: "Long",
        qty: 2,
        multiplier: 100,
        strike: 0,
        premium: 0,
        dte: 0,
        iv: 0,
      },
    ];
    const g = calcGreeks(pos, 100, 0.05);
    expect(g.d).toBe(200);
    expect(g.g).toBe(0);
    expect(g.t).toBe(0);
    expect(g.v).toBe(0);
  });

  it("long call has positive delta", () => {
    const pos = [
      {
        type: "Call",
        direction: "Long",
        qty: 1,
        multiplier: 100,
        strike: 100,
        premium: 5,
        dte: 30,
        iv: 0.2,
      },
    ];
    const g = calcGreeks(pos, 100, 0.05);
    expect(g.d).toBeGreaterThan(0);
  });

  it("short call has negative delta", () => {
    const pos = [
      {
        type: "Call",
        direction: "Short",
        qty: 1,
        multiplier: 100,
        strike: 100,
        premium: 5,
        dte: 30,
        iv: 0.2,
      },
    ];
    const g = calcGreeks(pos, 100, 0.05);
    expect(g.d).toBeLessThan(0);
  });
});

describe("netPremium", () => {
  it("long call has positive net premium (premium paid)", () => {
    const pos = [{ type: "Call", direction: "Long", qty: 1, multiplier: 100, premium: 5 }];
    expect(netPremium(pos)).toBe(500);
  });

  it("short call has negative net premium (premium received)", () => {
    const pos = [{ type: "Call", direction: "Short", qty: 1, multiplier: 100, premium: 5 }];
    expect(netPremium(pos)).toBe(-500);
  });

  it("futures have zero premium", () => {
    const pos = [{ type: "Future", direction: "Long", qty: 1, multiplier: 100, premium: 0 }];
    expect(netPremium(pos)).toBe(0);
  });

  it("multi-leg net premium", () => {
    const pos = [
      { type: "Call", direction: "Long", qty: 1, multiplier: 100, premium: 10 },
      { type: "Call", direction: "Short", qty: 1, multiplier: 100, premium: 5 },
    ];
    expect(netPremium(pos)).toBe(500); // 1000 - 500
  });
});
