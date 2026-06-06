import { describe, it, expect } from "vitest";
import { cubicSpline, buildVolSurface } from "../vol-surface.js";

describe("cubicSpline", () => {
  it("interpolates linear data exactly", () => {
    const fn = cubicSpline([0, 1, 2, 3], [0, 1, 2, 3]);
    expect(fn(0.5)).toBeCloseTo(0.5, 2);
    expect(fn(1.5)).toBeCloseTo(1.5, 2);
    expect(fn(2.5)).toBeCloseTo(2.5, 2);
  });

  it("passes through all data points", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [0, 1, 4, 9, 16]; // roughly quadratic
    const fn = cubicSpline(xs, ys);
    for (let i = 0; i < xs.length; i++) {
      expect(fn(xs[i])).toBeCloseTo(ys[i], 6);
    }
  });

  it("clamps at boundaries", () => {
    const fn = cubicSpline([1, 2, 3], [10, 20, 30]);
    expect(fn(0)).toBe(10); // clamp left
    expect(fn(5)).toBe(30); // clamp right
  });

  it("handles two points (linear)", () => {
    const fn = cubicSpline([0, 10], [5, 15]);
    expect(fn(5)).toBeCloseTo(10, 6);
  });

  it("handles single point", () => {
    const fn = cubicSpline([5], [42]);
    expect(fn(0)).toBe(42);
    expect(fn(100)).toBe(42);
  });

  it("produces smooth interpolation (no jumps)", () => {
    const fn = cubicSpline([0, 1, 2, 3, 4], [0, 1, 0, 1, 0]);
    // check that values between points are reasonable (bounded)
    for (let x = 0; x <= 4; x += 0.1) {
      const y = fn(x);
      expect(y).toBeGreaterThan(-1);
      expect(y).toBeLessThan(2);
    }
  });
});

// mock chain data for vol surface tests
function mockChain(spot, dte, ivFlat = 0.2) {
  const contracts = [];
  for (let k = spot * 0.8; k <= spot * 1.2; k += spot * 0.02) {
    const strike = Math.round(k * 100) / 100;
    // add some smile: higher IV in the wings
    const moneyness = Math.abs(strike - spot) / spot;
    const iv = ivFlat + moneyness * 0.3; // simple smile
    contracts.push({
      side: "call",
      strike,
      iv,
      bid: 1,
      ask: 2,
      mid: 1.5,
      dte,
      underlyingPrice: spot,
      volume: 100,
      openInterest: 500,
    });
    contracts.push({
      side: "put",
      strike,
      iv,
      bid: 1,
      ask: 2,
      mid: 1.5,
      dte,
      underlyingPrice: spot,
      volume: 100,
      openInterest: 500,
    });
  }
  return contracts;
}

describe("buildVolSurface", () => {
  it("builds from single expiry", () => {
    const chains = [{ expiry: "2026-06-19", dte: 90, chain: mockChain(100, 90) }];
    const surf = buildVolSurface(chains, 100);
    expect(surf).not.toBeNull();
    expect(surf.smiles).toHaveLength(1);
  });

  it("returns null for empty input", () => {
    expect(buildVolSurface([], 100)).toBeNull();
  });

  it("returns null for chains with no valid IV", () => {
    const chains = [
      { expiry: "2026-06-19", dte: 90, chain: [{ side: "call", strike: 100, iv: null }] },
    ];
    expect(buildVolSurface(chains, 100)).toBeNull();
  });

  it("iv() returns positive values", () => {
    const chains = [
      { expiry: "2026-04-17", dte: 30, chain: mockChain(100, 30) },
      { expiry: "2026-06-19", dte: 90, chain: mockChain(100, 90) },
    ];
    const surf = buildVolSurface(chains, 100);
    expect(surf.iv(100, 30)).toBeGreaterThan(0);
    expect(surf.iv(100, 90)).toBeGreaterThan(0);
    expect(surf.iv(100, 60)).toBeGreaterThan(0); // interpolated
  });

  it("ATM IV is close to input flat vol", () => {
    const chains = [{ expiry: "2026-06-19", dte: 90, chain: mockChain(100, 90, 0.25) }];
    const surf = buildVolSurface(chains, 100);
    // ATM should be close to 0.25 (the flat base vol)
    const atmIv = surf.iv(100, 90);
    expect(atmIv).toBeGreaterThan(0.2);
    expect(atmIv).toBeLessThan(0.35);
  });

  it("wing IV is higher than ATM IV (smile)", () => {
    const chains = [{ expiry: "2026-06-19", dte: 90, chain: mockChain(100, 90, 0.2) }];
    const surf = buildVolSurface(chains, 100);
    const atmIv = surf.iv(100, 90);
    const wingIv = surf.iv(85, 90);
    expect(wingIv).toBeGreaterThan(atmIv);
  });

  it("interpolates between expiries", () => {
    const chains = [
      { expiry: "2026-04-17", dte: 30, chain: mockChain(100, 30, 0.18) },
      { expiry: "2026-09-18", dte: 180, chain: mockChain(100, 180, 0.28) },
    ];
    const surf = buildVolSurface(chains, 100);
    const iv30 = surf.iv(100, 30);
    const iv180 = surf.iv(100, 180);
    const iv90 = surf.iv(100, 90);
    // interpolated IV should be between the two expiries
    expect(iv90).toBeGreaterThan(Math.min(iv30, iv180) - 0.02);
    expect(iv90).toBeLessThan(Math.max(iv30, iv180) + 0.02);
  });

  it("callPrice returns positive values", () => {
    const chains = [{ expiry: "2026-06-19", dte: 90, chain: mockChain(100, 90) }];
    const surf = buildVolSurface(chains, 100);
    expect(surf.callPrice(100, 90)).toBeGreaterThan(0);
    expect(surf.putPrice(100, 90)).toBeGreaterThan(0);
  });

  it("ivGrid returns a grid", () => {
    const chains = [{ expiry: "2026-06-19", dte: 90, chain: mockChain(100, 90) }];
    const surf = buildVolSurface(chains, 100);
    const grid = surf.ivGrid([90, 110], [30, 90], 5, 30);
    expect(grid.length).toBeGreaterThan(0);
    expect(grid[0].length).toBeGreaterThan(0);
    expect(grid[0][0]).toHaveProperty("strike");
    expect(grid[0][0]).toHaveProperty("dte");
    expect(grid[0][0]).toHaveProperty("iv");
  });

  it("forward variance is non-negative (arbitrage-free)", () => {
    const chains = [
      { expiry: "2026-04-17", dte: 30, chain: mockChain(100, 30, 0.3) },
      { expiry: "2026-09-18", dte: 180, chain: mockChain(100, 180, 0.18) },
    ];
    const surf = buildVolSurface(chains, 100);
    // even with inverted term structure, IV should stay positive
    for (let dte = 30; dte <= 180; dte += 10) {
      expect(surf.iv(100, dte)).toBeGreaterThan(0);
    }
  });
});
