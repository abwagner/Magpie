// Foundation tests: template resolution (build-strategy) + combined
// analytics (strategy-analytics) over a deterministic synthetic chain.

import { describe, expect, it } from "vitest";
import type { Contract } from "../../types/market-data.js";
import type { ChainsByExpiration } from "../../types/option-strategy.js";
import { StrategyBuildError } from "../../types/option-strategy.js";
import { STRATEGY_TEMPLATES, STRATEGY_KINDS } from "./option-strategy-templates.js";
import { buildStrategy } from "./build-strategy.js";

// ── Synthetic chain ────────────────────────────────────────────────
const SPOT = 100;
const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];
const FRONT = "2026-07-17";
const BACK = "2026-08-21";
const TV_BASE: Record<string, number> = { [FRONT]: 2, [BACK]: 4 }; // back has more time value

function mid(right: "call" | "put", strike: number, exp: string): number {
  const tv = TV_BASE[exp]! * Math.max(0, 1 - Math.abs(strike - SPOT) / 40);
  const intrinsic = right === "call" ? Math.max(SPOT - strike, 0) : Math.max(strike - SPOT, 0);
  return Number((intrinsic + tv).toFixed(2));
}

function contract(right: "call" | "put", strike: number, exp: string): Contract {
  const callDelta = Math.min(0.99, Math.max(0.01, 0.5 + (SPOT - strike) / 100));
  const atmness = Math.max(0, 1 - Math.abs(strike - SPOT) / 40);
  return {
    symbol: `TEST_${exp}_${right === "call" ? "C" : "P"}${strike}`,
    underlying: "TEST",
    expiration: exp,
    side: right,
    strike,
    dte: exp === FRONT ? 30 : 60,
    bid: mid(right, strike, exp) - 0.05,
    ask: mid(right, strike, exp) + 0.05,
    mid: mid(right, strike, exp),
    last: mid(right, strike, exp),
    volume: 100,
    openInterest: 100,
    underlyingPrice: SPOT,
    iv: 0.25,
    delta: right === "call" ? callDelta : callDelta - 1,
    gamma: 0.02 * atmness,
    theta: -0.05 * atmness * (exp === FRONT ? 1.5 : 1),
    vega: 0.1 * atmness * (exp === FRONT ? 1 : 1.6),
  };
}

function chainFor(exp: string): Contract[] {
  return STRIKES.flatMap((k) => [contract("call", k, exp), contract("put", k, exp)]);
}

const CHAINS: ChainsByExpiration = new Map([
  [FRONT, chainFor(FRONT)],
  [BACK, chainFor(BACK)],
]);

describe("buildStrategy — templates resolve", () => {
  it("every template kind builds without error on a full chain", () => {
    for (const kind of STRATEGY_KINDS) {
      const t = STRATEGY_TEMPLATES[kind];
      const exps = t.expirationsRequired === 2 ? [FRONT, BACK] : [FRONT];
      const built = buildStrategy(t, CHAINS, { expirations: exps });
      expect(built.legs.length).toBe(t.legs.length);
      expect(built.underlying).toBe("TEST");
    }
  });

  it("rejects too few expirations for a calendar", () => {
    expect(() => buildStrategy(STRATEGY_TEMPLATES["calendar-call"], CHAINS, { expirations: [FRONT] })).toThrow(
      StrategyBuildError,
    );
  });

  it("resolves offset strikes relative to ATM", () => {
    // Bull call spread: buy ATM call (100), sell +1 step call (105).
    const built = buildStrategy(STRATEGY_TEMPLATES["vertical-call-debit"], CHAINS, { expirations: [FRONT] });
    expect(built.legs[0]!.contract.strike).toBe(100);
    expect(built.legs[1]!.contract.strike).toBe(105);
    expect(built.legs[0]!.side).toBe("buy");
    expect(built.legs[1]!.side).toBe("sell");
  });

  it("calendar legs span both expirations at the same strike", () => {
    const built = buildStrategy(STRATEGY_TEMPLATES["calendar-call"], CHAINS, { expirations: [FRONT, BACK] });
    expect(built.legs[0]!.contract.expiration).toBe(FRONT);
    expect(built.legs[1]!.contract.expiration).toBe(BACK);
    expect(built.legs[0]!.contract.strike).toBe(built.legs[1]!.contract.strike);
  });

  it("honours an absolute strike override (nearest available)", () => {
    const built = buildStrategy(STRATEGY_TEMPLATES["vertical-call-debit"], CHAINS, {
      expirations: [FRONT],
      strikeOverrides: { 1: 113 }, // nearest is 115
    });
    expect(built.legs[1]!.contract.strike).toBe(115);
  });
});

describe("analytics — vertical (defined risk)", () => {
  const built = buildStrategy(STRATEGY_TEMPLATES["vertical-call-debit"], CHAINS, { expirations: [FRONT] });
  const a = built.analytics;

  it("is a net debit", () => {
    expect(a.netDebit).toBeGreaterThan(0); // pay for the long ATM call net of the short
  });
  it("max loss equals the debit paid; max profit is bounded", () => {
    expect(a.maxLoss).toBeCloseTo(-a.netDebit, 6);
    expect(a.maxProfit).not.toBeNull();
    // width (5) × 100 − debit
    expect(a.maxProfit!).toBeCloseTo(5 * 100 - a.netDebit, 6);
  });
  it("has one breakeven between the strikes", () => {
    expect(a.breakevens.length).toBe(1);
    expect(a.breakevens[0]!).toBeGreaterThan(100);
    expect(a.breakevens[0]!).toBeLessThan(105);
  });
});

describe("analytics — long straddle (unbounded upside)", () => {
  const built = buildStrategy(STRATEGY_TEMPLATES["straddle"], CHAINS, { expirations: [FRONT] });
  const a = built.analytics;

  it("is a net debit with positive gamma and vega", () => {
    expect(a.netDebit).toBeGreaterThan(0);
    expect(a.netGamma).toBeGreaterThan(0);
    expect(a.netVega).toBeGreaterThan(0);
  });
  it("has unbounded max profit and a bounded max loss = debit", () => {
    expect(a.maxProfit).toBeNull();
    expect(a.maxLoss).toBeCloseTo(-a.netDebit, 6);
  });
  it("has two breakevens straddling spot", () => {
    expect(a.breakevens.length).toBe(2);
    expect(a.breakevens[0]!).toBeLessThan(SPOT);
    expect(a.breakevens[1]!).toBeGreaterThan(SPOT);
  });
});

describe("analytics — iron condor (net credit, defined risk)", () => {
  const built = buildStrategy(STRATEGY_TEMPLATES["iron-condor"], CHAINS, { expirations: [FRONT] });
  const a = built.analytics;

  it("collects a net credit", () => {
    expect(a.netDebit).toBeLessThan(0);
  });
  it("max profit equals the credit; loss and profit both bounded", () => {
    expect(a.maxProfit).not.toBeNull();
    expect(a.maxLoss).not.toBeNull();
    expect(a.maxProfit!).toBeCloseTo(-a.netDebit, 6);
  });
  it("has two breakevens around spot", () => {
    expect(a.breakevens.length).toBe(2);
    expect(a.breakevens[0]!).toBeLessThan(SPOT);
    expect(a.breakevens[1]!).toBeGreaterThan(SPOT);
  });
});

describe("analytics — multiplier scales P/L (CL futures options ×1000)", () => {
  it("scales debit and payoff by the multiplier", () => {
    const eq = buildStrategy(STRATEGY_TEMPLATES["straddle"], CHAINS, { expirations: [FRONT] });
    const cl = buildStrategy(STRATEGY_TEMPLATES["straddle"], CHAINS, { expirations: [FRONT], multiplier: 1000 });
    expect(cl.analytics.netDebit).toBeCloseTo(eq.analytics.netDebit * 10, 6);
    // greeks are per-contract, not scaled by the dollar multiplier
    expect(cl.analytics.netGamma).toBeCloseTo(eq.analytics.netGamma, 6);
  });
});
