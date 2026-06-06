import { describe, it, expect } from "vitest";
import { BS, Black76 } from "../bs.js";

describe("BS.N (normal CDF)", () => {
  it("N(0) = 0.5", () => {
    expect(BS.N(0)).toBeCloseTo(0.5, 6);
  });
  it("N(large positive) ≈ 1", () => {
    expect(BS.N(5)).toBeCloseTo(1, 4);
  });
  it("N(large negative) ≈ 0", () => {
    expect(BS.N(-5)).toBeCloseTo(0, 4);
  });
  // Post-QF-185 textbook anchors — A&S 7.1.26 is good to ~7.5e-8.
  // These values come from scipy.stats.norm.cdf (matched in
  // core/qf-quant/src/normal.rs::cdf_correct).
  it("N(0.5) ≈ 0.6914624 (textbook)", () => {
    expect(BS.N(0.5)).toBeCloseTo(0.6914624612740131, 6);
  });
  it("N(1.0) ≈ 0.8413447 (textbook)", () => {
    expect(BS.N(1.0)).toBeCloseTo(0.8413447460685429, 6);
  });
  it("N(1.96) ≈ 0.9750021 (textbook, the 95th-percentile anchor)", () => {
    expect(BS.N(1.96)).toBeCloseTo(0.9750021048517795, 6);
  });
  it("symmetric: N(-x) = 1 - N(x)", () => {
    for (const x of [0.25, 0.5, 1.0, 1.5, 2.0, 2.5]) {
      expect(BS.N(-x)).toBeCloseTo(1 - BS.N(x), 10);
    }
  });
});

describe("BS.call", () => {
  it("ATM call has positive value", () => {
    const price = BS.call(100, 100, 0.05, 0.5, 0.2);
    expect(price).toBeGreaterThan(0);
  });
  it("deep ITM call ≈ intrinsic + time value", () => {
    const price = BS.call(150, 100, 0.05, 0.5, 0.2);
    expect(price).toBeGreaterThan(50); // intrinsic = 50
  });
  it("deep OTM call ≈ 0", () => {
    const price = BS.call(50, 100, 0.05, 0.5, 0.2);
    expect(price).toBeLessThan(0.01);
  });
  it("at expiration returns intrinsic", () => {
    expect(BS.call(110, 100, 0.05, 0, 0.2)).toBeCloseTo(10, 6);
    expect(BS.call(90, 100, 0.05, 0, 0.2)).toBeCloseTo(0, 6);
  });
  it("higher vol = higher price", () => {
    const low = BS.call(100, 100, 0.05, 0.5, 0.15);
    const high = BS.call(100, 100, 0.05, 0.5, 0.3);
    expect(high).toBeGreaterThan(low);
  });
  it("put-call parity holds", () => {
    const S = 100,
      K = 105,
      r = 0.05,
      T = 0.25,
      v = 0.2;
    const c = BS.call(S, K, r, T, v);
    const p = BS.put(S, K, r, T, v);
    // C - P = S - K*e^(-rT)
    const lhs = c - p;
    const rhs = S - K * Math.exp(-r * T);
    expect(lhs).toBeCloseTo(rhs, 4);
  });
});

describe("BS.put", () => {
  it("ATM put has positive value", () => {
    expect(BS.put(100, 100, 0.05, 0.5, 0.2)).toBeGreaterThan(0);
  });
  it("at expiration returns intrinsic", () => {
    expect(BS.put(90, 100, 0.05, 0, 0.2)).toBeCloseTo(10, 6);
    expect(BS.put(110, 100, 0.05, 0, 0.2)).toBeCloseTo(0, 6);
  });
});

describe("BS.delta", () => {
  it("ATM call delta ≈ 0.5", () => {
    const d = BS.delta(100, 100, 0.05, 0.5, 0.2, "Call");
    expect(d).toBeGreaterThan(0.4);
    expect(d).toBeLessThan(0.7);
  });
  it("ATM put delta ≈ -0.5", () => {
    const d = BS.delta(100, 100, 0.05, 0.5, 0.2, "Put");
    expect(d).toBeLessThan(-0.3);
    expect(d).toBeGreaterThan(-0.7);
  });
  it("call delta is between 0 and 1", () => {
    const d = BS.delta(100, 100, 0.05, 0.5, 0.2, "Call");
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
  it("expired ITM call delta = 1", () => {
    expect(BS.delta(110, 100, 0.05, 0, 0.2, "Call")).toBe(1);
  });
  it("expired OTM call delta = 0", () => {
    expect(BS.delta(90, 100, 0.05, 0, 0.2, "Call")).toBe(0);
  });
});

describe("BS.gamma", () => {
  it("ATM gamma is positive", () => {
    expect(BS.gamma(100, 100, 0.05, 0.5, 0.2)).toBeGreaterThan(0);
  });
  it("expired gamma = 0", () => {
    expect(BS.gamma(100, 100, 0.05, 0, 0.2)).toBe(0);
  });
  it("OTM gamma < ATM gamma", () => {
    const atm = BS.gamma(100, 100, 0.05, 0.5, 0.2);
    const otm = BS.gamma(100, 130, 0.05, 0.5, 0.2);
    expect(atm).toBeGreaterThan(otm);
  });
});

describe("BS.theta", () => {
  it("long call theta is negative (time decay)", () => {
    const t = BS.theta(100, 100, 0.05, 0.5, 0.2, "Call");
    expect(t).toBeLessThan(0);
  });
  it("expired theta = 0", () => {
    expect(BS.theta(100, 100, 0.05, 0, 0.2, "Call")).toBe(0);
  });
});

describe("BS.vega", () => {
  it("ATM vega is positive", () => {
    expect(BS.vega(100, 100, 0.05, 0.5, 0.2)).toBeGreaterThan(0);
  });
  it("expired vega = 0", () => {
    expect(BS.vega(100, 100, 0.05, 0, 0.2)).toBe(0);
  });
});

// ── Black-76 Tests ──────────────────────────────────────────────────────

describe("Black76.call", () => {
  it("ATM call has positive value", () => {
    const price = Black76.call(100, 100, 0.05, 0.5, 0.2);
    expect(price).toBeGreaterThan(0);
  });
  it("deep ITM call > intrinsic (discounted)", () => {
    const price = Black76.call(150, 100, 0.05, 0.5, 0.2);
    expect(price).toBeGreaterThan(50 * Math.exp(-0.05 * 0.5) - 0.01);
  });
  it("deep OTM call ≈ 0", () => {
    expect(Black76.call(50, 100, 0.05, 0.5, 0.2)).toBeLessThan(0.01);
  });
  it("at expiration returns intrinsic", () => {
    expect(Black76.call(110, 100, 0.05, 0, 0.2)).toBeCloseTo(10, 6);
    expect(Black76.call(90, 100, 0.05, 0, 0.2)).toBeCloseTo(0, 6);
  });
  it("higher vol = higher price", () => {
    const low = Black76.call(100, 100, 0.05, 0.5, 0.15);
    const high = Black76.call(100, 100, 0.05, 0.5, 0.3);
    expect(high).toBeGreaterThan(low);
  });
});

describe("Black76.put", () => {
  it("ATM put has positive value", () => {
    expect(Black76.put(100, 100, 0.05, 0.5, 0.2)).toBeGreaterThan(0);
  });
  it("at expiration returns intrinsic", () => {
    expect(Black76.put(90, 100, 0.05, 0, 0.2)).toBeCloseTo(10, 6);
    expect(Black76.put(110, 100, 0.05, 0, 0.2)).toBeCloseTo(0, 6);
  });
});

describe("Black76 put-call parity", () => {
  it("C - P = e^(-rT) * (F - K)", () => {
    const F = 95,
      K = 100,
      r = 0.05,
      T = 0.25,
      v = 0.3;
    const c = Black76.call(F, K, r, T, v);
    const p = Black76.put(F, K, r, T, v);
    const lhs = c - p;
    const rhs = Math.exp(-r * T) * (F - K);
    expect(lhs).toBeCloseTo(rhs, 4);
  });
  it("holds for ITM case", () => {
    const F = 110,
      K = 90,
      r = 0.03,
      T = 1,
      v = 0.25;
    const c = Black76.call(F, K, r, T, v);
    const p = Black76.put(F, K, r, T, v);
    expect(c - p).toBeCloseTo(Math.exp(-r * T) * (F - K), 4);
  });
});

describe("Black76 vs BS equivalence", () => {
  it("Black76(F, K, r, T, v) ≈ BS(F*e^(-rT), K, r, T, v)", () => {
    const F = 100,
      K = 105,
      r = 0.05,
      T = 0.5,
      v = 0.2;
    const b76call = Black76.call(F, K, r, T, v);
    const bsCall = BS.call(F * Math.exp(-r * T), K, r, T, v);
    expect(b76call).toBeCloseTo(bsCall, 4);
  });
});

describe("Black76.delta", () => {
  it("ATM call delta ≈ 0.5 (discounted)", () => {
    const d = Black76.delta(100, 100, 0.05, 0.5, 0.2, "Call");
    expect(d).toBeGreaterThan(0.35);
    expect(d).toBeLessThan(0.65);
  });
  it("ATM put delta is negative", () => {
    const d = Black76.delta(100, 100, 0.05, 0.5, 0.2, "Put");
    expect(d).toBeLessThan(0);
    expect(d).toBeGreaterThan(-0.65);
  });
  it("call delta + |put delta| ≈ e^(-rT)", () => {
    const F = 100,
      K = 100,
      r = 0.05,
      T = 0.5,
      v = 0.2;
    const cd = Black76.delta(F, K, r, T, v, "Call");
    const pd = Black76.delta(F, K, r, T, v, "Put");
    expect(cd - pd).toBeCloseTo(Math.exp(-r * T), 4);
  });
  it("expired ITM call delta = 1", () => {
    expect(Black76.delta(110, 100, 0.05, 0, 0.2, "Call")).toBe(1);
  });
  it("expired OTM call delta = 0", () => {
    expect(Black76.delta(90, 100, 0.05, 0, 0.2, "Call")).toBe(0);
  });
});

describe("Black76.gamma", () => {
  it("ATM gamma is positive", () => {
    expect(Black76.gamma(100, 100, 0.05, 0.5, 0.2)).toBeGreaterThan(0);
  });
  it("expired gamma = 0", () => {
    expect(Black76.gamma(100, 100, 0.05, 0, 0.2)).toBe(0);
  });
});

describe("Black76.theta", () => {
  it("ATM call theta is negative", () => {
    expect(Black76.theta(100, 100, 0.05, 0.5, 0.2, "Call")).toBeLessThan(0);
  });
  it("expired theta = 0", () => {
    expect(Black76.theta(100, 100, 0.05, 0, 0.2, "Call")).toBe(0);
  });
});

describe("Black76.vega", () => {
  it("ATM vega is positive", () => {
    expect(Black76.vega(100, 100, 0.05, 0.5, 0.2)).toBeGreaterThan(0);
  });
  it("expired vega = 0", () => {
    expect(Black76.vega(100, 100, 0.05, 0, 0.2)).toBe(0);
  });
});

// ── Implied Volatility Solver Tests ─────────────────────────────────────

describe("BS.impliedVol", () => {
  it("round-trips ATM call", () => {
    const S = 100,
      K = 100,
      r = 0.05,
      T = 0.5,
      v = 0.25;
    const price = BS.call(S, K, r, T, v);
    const recovered = BS.impliedVol(S, K, r, T, price, "Call");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("round-trips ATM put", () => {
    const S = 100,
      K = 100,
      r = 0.05,
      T = 0.5,
      v = 0.3;
    const price = BS.put(S, K, r, T, v);
    const recovered = BS.impliedVol(S, K, r, T, price, "Put");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("round-trips OTM call", () => {
    const S = 100,
      K = 120,
      r = 0.05,
      T = 0.25,
      v = 0.35;
    const price = BS.call(S, K, r, T, v);
    const recovered = BS.impliedVol(S, K, r, T, price, "Call");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("round-trips ITM put", () => {
    const S = 100,
      K = 120,
      r = 0.05,
      T = 0.5,
      v = 0.2;
    const price = BS.put(S, K, r, T, v);
    const recovered = BS.impliedVol(S, K, r, T, price, "Put");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("round-trips high vol", () => {
    const S = 100,
      K = 100,
      r = 0.05,
      T = 1.0,
      v = 1.5;
    const price = BS.call(S, K, r, T, v);
    const recovered = BS.impliedVol(S, K, r, T, price, "Call");
    expect(recovered).toBeCloseTo(v, 3);
  });
  it("round-trips low vol", () => {
    const S = 100,
      K = 100,
      r = 0.05,
      T = 0.5,
      v = 0.05;
    const price = BS.call(S, K, r, T, v);
    const recovered = BS.impliedVol(S, K, r, T, price, "Call");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("returns null for expired options", () => {
    expect(BS.impliedVol(100, 100, 0.05, 0, 5, "Call")).toBeNull();
  });
  it("returns null for price below intrinsic", () => {
    // ITM call with price less than intrinsic
    expect(BS.impliedVol(110, 100, 0.05, 0.5, 0.01, "Call")).toBeNull();
  });
  it("returns null for zero price", () => {
    expect(BS.impliedVol(100, 100, 0.05, 0.5, 0, "Call")).toBeNull();
  });
});

describe("Black76.impliedVol", () => {
  it("round-trips ATM call", () => {
    const F = 100,
      K = 100,
      r = 0.05,
      T = 0.5,
      v = 0.25;
    const price = Black76.call(F, K, r, T, v);
    const recovered = Black76.impliedVol(F, K, r, T, price, "Call");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("round-trips ATM put", () => {
    const F = 100,
      K = 100,
      r = 0.05,
      T = 0.5,
      v = 0.3;
    const price = Black76.put(F, K, r, T, v);
    const recovered = Black76.impliedVol(F, K, r, T, price, "Put");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("round-trips OTM put", () => {
    const F = 100,
      K = 80,
      r = 0.05,
      T = 0.25,
      v = 0.4;
    const price = Black76.put(F, K, r, T, v);
    const recovered = Black76.impliedVol(F, K, r, T, price, "Put");
    expect(recovered).toBeCloseTo(v, 4);
  });
  it("returns null for expired options", () => {
    expect(Black76.impliedVol(100, 100, 0.05, 0, 5, "Call")).toBeNull();
  });
  it("returns null for zero price", () => {
    expect(Black76.impliedVol(100, 100, 0.05, 0.5, 0, "Call")).toBeNull();
  });
});
