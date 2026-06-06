import { describe, it, expect } from "vitest";
import { buildEventOverlay, makeEvent } from "../event-model.js";
import { extractMarketPDF } from "../probability.js";
import { buildVolSurface } from "../vol-surface.js";

function mockChain(spot, dte, iv = 0.2) {
  const contracts = [];
  for (let k = spot * 0.7; k <= spot * 1.3; k += spot * 0.02) {
    const strike = Math.round(k * 100) / 100;
    const moneyness = Math.abs(strike - spot) / spot;
    contracts.push({
      side: "call",
      strike,
      iv: iv + moneyness * 0.15,
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
      iv: iv + moneyness * 0.15,
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

function makeBasePDF(spot = 100, dte = 90) {
  const surf = buildVolSurface([{ expiry: "2026-06-19", dte, chain: mockChain(spot, dte) }], spot);
  return extractMarketPDF(surf, dte);
}

describe("buildEventOverlay", () => {
  it("with no events, returns base distribution", () => {
    const base = makeBasePDF();
    const result = buildEventOverlay([], base, 100, 90 / 365);
    const integral = result.density.reduce((s, d) => s + d * result.strikeStep, 0);
    expect(integral).toBeCloseTo(1.0, 1);
    // should be very close to base
    for (let i = 0; i < result.density.length; i++) {
      expect(result.density[i]).toBeCloseTo(base.density[i], 4);
    }
  });

  it("mixture density integrates to ~1.0", () => {
    const base = makeBasePDF();
    const events = [makeEvent("Crash", 0.1, -0.15, 0.3)];
    const result = buildEventOverlay(events, base, 100, 90 / 365);
    const integral = result.density.reduce((s, d) => s + d * result.strikeStep, 0);
    expect(integral).toBeCloseTo(1.0, 1);
  });

  it("crash event shifts expected value down", () => {
    const base = makeBasePDF();
    const events = [makeEvent("Crash", 0.3, -0.2, 0.35)];
    const result = buildEventOverlay(events, base, 100, 90 / 365);
    expect(result.expectedValue).toBeLessThan(base.expectedValue);
  });

  it("bull event shifts expected value up", () => {
    const base = makeBasePDF();
    const events = [makeEvent("Rally", 0.3, 0.15, 0.25)];
    const result = buildEventOverlay(events, base, 100, 90 / 365);
    expect(result.expectedValue).toBeGreaterThan(base.expectedValue);
  });

  it("multiple events blend correctly", () => {
    const base = makeBasePDF();
    const events = [makeEvent("Crash", 0.1, -0.2, 0.35), makeEvent("Rally", 0.1, 0.15, 0.25)];
    const result = buildEventOverlay(events, base, 100, 90 / 365);
    const integral = result.density.reduce((s, d) => s + d * result.strikeStep, 0);
    expect(integral).toBeCloseTo(1.0, 1);
    expect(result.baseProbability).toBeCloseTo(0.8, 6);
  });

  it("100% event probability uses only event distribution", () => {
    const base = makeBasePDF();
    const events = [makeEvent("Total", 1.0, -0.1, 0.25)];
    const result = buildEventOverlay(events, base, 100, 90 / 365);
    expect(result.baseProbability).toBeCloseTo(0, 6);
    const integral = result.density.reduce((s, d) => s + d * result.strikeStep, 0);
    expect(integral).toBeCloseTo(1.0, 1);
  });

  it("0% event probability returns base", () => {
    const base = makeBasePDF();
    const events = [makeEvent("Nothing", 0, -0.1, 0.25)];
    const result = buildEventOverlay(events, base, 100, 90 / 365);
    for (let i = 0; i < result.density.length; i++) {
      expect(result.density[i]).toBeCloseTo(base.density[i], 4);
    }
  });

  it("high vol event produces wider tails", () => {
    const base = makeBasePDF();
    const events = [makeEvent("HighVol", 0.5, 0, 0.6)];
    const result = buildEventOverlay(events, base, 100, 90 / 365);
    expect(result.variance).toBeGreaterThan(base.variance);
  });
});

describe("makeEvent", () => {
  it("creates event with defaults", () => {
    const e = makeEvent("Test", 0.2, -0.05);
    expect(e.name).toBe("Test");
    expect(e.prob).toBe(0.2);
    expect(e.priceMove).toBe(-0.05);
    expect(e.vol).toBe(0.2);
    expect(e.ivShift).toBe(0);
  });

  it("accepts custom vol and ivShift", () => {
    const e = makeEvent("Test", 0.1, 0.1, 0.35, 0.05);
    expect(e.vol).toBe(0.35);
    expect(e.ivShift).toBe(0.05);
  });
});
