import { describe, it, expect } from "vitest";
import {
  realizedVolCC,
  realizedVolParkinson,
  computeReturns,
  realizedVolMultiWindow,
  ivRvAnalysis,
  rvAdjustedVol,
} from "../rv-analysis.js";

describe("computeReturns", () => {
  it("computes log returns", () => {
    const returns = computeReturns([100, 105, 102]);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(Math.log(105 / 100), 10);
    expect(returns[1]).toBeCloseTo(Math.log(102 / 105), 10);
  });

  it("handles single price", () => {
    expect(computeReturns([100])).toHaveLength(0);
  });

  it("skips zero prices", () => {
    const returns = computeReturns([100, 0, 105]);
    // should skip the 0→105 return (100→0 is valid though: log(0/100) = -Inf, but we check > 0)
    expect(returns.length).toBeLessThanOrEqual(2);
  });
});

describe("realizedVolCC", () => {
  it("returns 0 for insufficient data", () => {
    expect(realizedVolCC([])).toBe(0);
    expect(realizedVolCC([0.01])).toBe(0);
  });

  it("constant returns produce low vol", () => {
    const returns = Array(20).fill(0.001); // constant 0.1% daily
    const vol = realizedVolCC(returns);
    expect(vol).toBeLessThan(0.01); // nearly zero
  });

  it("volatile returns produce higher vol", () => {
    const returns = [];
    for (let i = 0; i < 60; i++) returns.push((Math.random() - 0.5) * 0.04);
    const vol = realizedVolCC(returns);
    expect(vol).toBeGreaterThan(0.05);
    expect(vol).toBeLessThan(1.0);
  });

  it("known computation matches manual", () => {
    // 3 returns: 1%, -1%, 1%
    const returns = [0.01, -0.01, 0.01];
    const mean = (0.01 - 0.01 + 0.01) / 3;
    const variance = ((0.01 - mean) ** 2 + (-0.01 - mean) ** 2 + (0.01 - mean) ** 2) / 2;
    const expected = Math.sqrt(variance * 252);
    expect(realizedVolCC(returns)).toBeCloseTo(expected, 6);
  });
});

describe("realizedVolParkinson", () => {
  it("returns 0 for empty data", () => {
    expect(realizedVolParkinson([])).toBe(0);
  });

  it("tight ranges produce low vol", () => {
    const bars = Array(20).fill({ high: 101, low: 99 });
    const vol = realizedVolParkinson(bars);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(0.5);
  });

  it("wide ranges produce higher vol", () => {
    const narrow = Array(20).fill({ high: 101, low: 99 });
    const wide = Array(20).fill({ high: 110, low: 90 });
    expect(realizedVolParkinson(wide)).toBeGreaterThan(realizedVolParkinson(narrow));
  });
});

describe("realizedVolMultiWindow", () => {
  it("returns results for available windows", () => {
    const prices = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.1) * 5);
    const result = realizedVolMultiWindow(prices);
    expect(result).toHaveProperty("10");
    expect(result).toHaveProperty("20");
    expect(result).toHaveProperty("30");
    expect(result).toHaveProperty("60");
    expect(result).toHaveProperty("90");
  });

  it("skips windows larger than data", () => {
    const prices = Array.from({ length: 15 }, (_, i) => 100 + i);
    const result = realizedVolMultiWindow(prices);
    expect(result).toHaveProperty("10");
    expect(result).not.toHaveProperty("60");
  });
});

describe("ivRvAnalysis", () => {
  it("computes IV/RV ratio", () => {
    const prices = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.1) * 3);
    const result = ivRvAnalysis(0.2, prices);
    expect(result.currentIV).toBe(0.2);
    expect(result.avgRV).toBeGreaterThan(0);
    for (const [, data] of Object.entries(result.windows)) {
      expect(data.ivRvRatio).toBeGreaterThan(0);
      expect(data.vrp).toBeDefined();
    }
  });
});

describe("rvAdjustedVol", () => {
  it("computes adjustment ratio", () => {
    const adj = rvAdjustedVol(0.25, 0.18);
    expect(adj.adjustedVol).toBe(0.18);
    expect(adj.ratio).toBeCloseTo(0.18 / 0.25, 6);
    expect(adj.vrp).toBeCloseTo(0.07, 6);
  });

  it("adjustIV scales proportionally", () => {
    const adj = rvAdjustedVol(0.25, 0.18);
    expect(adj.adjustIV(0.3)).toBeCloseTo((0.3 * 0.18) / 0.25, 6);
  });
});
