import { describe, it, expect } from "vitest";
import { STRATEGIES, optimize } from "../optimizer.js";

const mockChain = [
  {
    side: "call",
    strike: 95,
    bid: 6.5,
    ask: 7.0,
    mid: 6.75,
    last: 6.8,
    iv: 0.22,
    dte: 45,
    underlyingPrice: 100,
    volume: 100,
    openInterest: 500,
  },
  {
    side: "call",
    strike: 100,
    bid: 3.0,
    ask: 3.5,
    mid: 3.25,
    last: 3.3,
    iv: 0.2,
    dte: 45,
    underlyingPrice: 100,
    volume: 200,
    openInterest: 1000,
  },
  {
    side: "call",
    strike: 105,
    bid: 1.2,
    ask: 1.5,
    mid: 1.35,
    last: 1.3,
    iv: 0.19,
    dte: 45,
    underlyingPrice: 100,
    volume: 150,
    openInterest: 800,
  },
  {
    side: "call",
    strike: 110,
    bid: 0.4,
    ask: 0.6,
    mid: 0.5,
    last: 0.5,
    iv: 0.18,
    dte: 45,
    underlyingPrice: 100,
    volume: 80,
    openInterest: 400,
  },
  {
    side: "put",
    strike: 90,
    bid: 0.3,
    ask: 0.5,
    mid: 0.4,
    last: 0.4,
    iv: 0.25,
    dte: 45,
    underlyingPrice: 100,
    volume: 60,
    openInterest: 300,
  },
  {
    side: "put",
    strike: 95,
    bid: 1.0,
    ask: 1.3,
    mid: 1.15,
    last: 1.1,
    iv: 0.23,
    dte: 45,
    underlyingPrice: 100,
    volume: 120,
    openInterest: 600,
  },
  {
    side: "put",
    strike: 100,
    bid: 2.8,
    ask: 3.2,
    mid: 3.0,
    last: 3.0,
    iv: 0.21,
    dte: 45,
    underlyingPrice: 100,
    volume: 180,
    openInterest: 900,
  },
  {
    side: "put",
    strike: 105,
    bid: 6.0,
    ask: 6.5,
    mid: 6.25,
    last: 6.2,
    iv: 0.2,
    dte: 45,
    underlyingPrice: 100,
    volume: 90,
    openInterest: 450,
  },
];

const scenarios = [
  { name: "Crash", prob: 0.05, priceMove: -0.2, iv_shift: 0.1 },
  { name: "Bear", prob: 0.2, priceMove: -0.08, iv_shift: 0.03 },
  { name: "Flat", prob: 0.4, priceMove: 0, iv_shift: 0 },
  { name: "Bull", prob: 0.25, priceMove: 0.08, iv_shift: -0.02 },
  { name: "Spike", prob: 0.1, priceMove: 0.2, iv_shift: 0.05 },
];

describe("STRATEGIES", () => {
  it("bull_call_spread generates candidates from calls", () => {
    const candidates = STRATEGIES.bull_call_spread.generate(mockChain, 100);
    expect(candidates.length).toBeGreaterThan(0);
    for (const legs of candidates) {
      expect(legs).toHaveLength(2);
      expect(legs[0].direction).toBe("Long");
      expect(legs[1].direction).toBe("Short");
      expect(legs[0].type).toBe("Call");
      expect(legs[1].type).toBe("Call");
      expect(legs[0].strike).toBeLessThan(legs[1].strike);
    }
  });

  it("bear_put_spread generates candidates from puts", () => {
    const candidates = STRATEGIES.bear_put_spread.generate(mockChain, 100);
    expect(candidates.length).toBeGreaterThan(0);
    for (const legs of candidates) {
      expect(legs).toHaveLength(2);
      expect(legs[0].type).toBe("Put");
      expect(legs[1].type).toBe("Put");
    }
  });

  it("iron_condor generates 4-leg candidates", () => {
    const candidates = STRATEGIES.iron_condor.generate(mockChain, 100);
    expect(candidates.length).toBeGreaterThan(0);
    for (const legs of candidates) {
      expect(legs).toHaveLength(4);
    }
  });

  it("long_call generates single-leg candidates", () => {
    const candidates = STRATEGIES.long_call.generate(mockChain, 100);
    expect(candidates.length).toBeGreaterThan(0);
    for (const legs of candidates) {
      expect(legs).toHaveLength(1);
      expect(legs[0].direction).toBe("Long");
      expect(legs[0].type).toBe("Call");
    }
  });

  it("straddle pairs call and put at same strike", () => {
    const candidates = STRATEGIES.straddle.generate(mockChain, 100);
    expect(candidates.length).toBeGreaterThan(0);
    for (const legs of candidates) {
      expect(legs).toHaveLength(2);
      expect(legs[0].strike).toBe(legs[1].strike);
      expect(new Set(legs.map((l) => l.type)).size).toBe(2); // one Call, one Put
    }
  });

  it("strategies use ask for long, bid for short", () => {
    const candidates = STRATEGIES.bull_call_spread.generate(mockChain, 100);
    const [long, short] = candidates[0];
    const longOpt = mockChain.find((c) => c.side === "call" && c.strike === long.strike);
    const shortOpt = mockChain.find((c) => c.side === "call" && c.strike === short.strike);
    expect(long.premium).toBe(longOpt.ask);
    expect(short.premium).toBe(shortOpt.bid);
  });
});

describe("optimize", () => {
  it("returns results sorted by score", async () => {
    const results = await optimize({
      chain: mockChain,
      scenarios,
      spot: 100,
      rfr: 0.05,
      hold: 30,
      target: {
        minReturnPct: 5,
        maxLossPct: 50,
        maxDebit: 10000,
        optimizeFor: "ev",
        strategies: ["bull_call_spread", "long_call"],
      },
    });
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("respects maxDebit constraint", async () => {
    const results = await optimize({
      chain: mockChain,
      scenarios,
      spot: 100,
      rfr: 0.05,
      hold: 30,
      target: {
        minReturnPct: 5,
        maxLossPct: 50,
        maxDebit: 50,
        optimizeFor: "ev",
        strategies: ["long_call"],
      },
    });
    // with maxDebit=50, most strategies should be filtered out since calls cost more
    // (but some cheap OTM calls might pass)
    for (const r of results) {
      expect(Math.abs(r.netDebit)).toBeLessThanOrEqual(50);
    }
  });

  it("returns empty for no strategies", async () => {
    const results = await optimize({
      chain: mockChain,
      scenarios,
      spot: 100,
      rfr: 0.05,
      hold: 30,
      target: {
        minReturnPct: 5,
        maxLossPct: 50,
        maxDebit: 10000,
        optimizeFor: "ev",
        strategies: [],
      },
    });
    expect(results).toHaveLength(0);
  });

  it("returns empty for empty chain", async () => {
    const results = await optimize({
      chain: [],
      scenarios,
      spot: 100,
      rfr: 0.05,
      hold: 30,
      target: {
        minReturnPct: 5,
        maxLossPct: 50,
        maxDebit: 10000,
        optimizeFor: "ev",
        strategies: ["long_call"],
      },
    });
    expect(results).toHaveLength(0);
  });

  it("includes existing positions in hedge mode", async () => {
    const existing = [
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
    const results = await optimize({
      chain: mockChain,
      scenarios,
      spot: 100,
      rfr: 0.05,
      hold: 30,
      existingPositions: existing,
      target: {
        minReturnPct: 5,
        maxLossPct: 100,
        maxDebit: 10000,
        optimizeFor: "ev",
        strategies: ["long_put"],
      },
    });
    expect(results.length).toBeGreaterThan(0);
    // the hedge mode results should include the existing future in evaluation
  });

  it("each result has required fields", async () => {
    const results = await optimize({
      chain: mockChain,
      scenarios,
      spot: 100,
      rfr: 0.05,
      hold: 30,
      target: {
        minReturnPct: 5,
        maxLossPct: 50,
        maxDebit: 10000,
        optimizeFor: "ev",
        strategies: ["bull_call_spread"],
      },
    });
    for (const r of results) {
      expect(r).toHaveProperty("strategyKey");
      expect(r).toHaveProperty("strategyName");
      expect(r).toHaveProperty("legs");
      expect(r).toHaveProperty("result");
      expect(r).toHaveProperty("netDebit");
      expect(r).toHaveProperty("returnProb");
      expect(r).toHaveProperty("score");
      expect(r.result).toHaveProperty("totalEV");
      expect(r.result).toHaveProperty("maxLoss");
      expect(r.result).toHaveProperty("maxGain");
    }
  });
});
