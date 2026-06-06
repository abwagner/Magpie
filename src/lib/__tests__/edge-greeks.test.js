import { describe, it, expect } from "vitest";
import { edgeToGreeks, multiExpiryEdgeGreeks } from "../edge-greeks.js";

function makeEdge(strikes, edgeValues, dte = 90) {
  return { strikes, edge: edgeValues, dte, spot: 100 };
}

describe("edgeToGreeks", () => {
  it("zero edge produces zero targets", () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 80 + i);
    const edge = new Array(41).fill(0);
    const result = edgeToGreeks(makeEdge(strikes, edge), 100);
    expect(result.targetDelta).toBeCloseTo(0, 4);
    expect(result.targetVega).toBeCloseTo(0, 2);
    expect(result.totalAbsEdge).toBeCloseTo(0, 4);
  });

  it("positive upside edge → positive delta", () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 80 + i);
    // more probability above spot than market thinks
    const edge = strikes.map((K) => (K > 100 ? 0.01 : -0.01));
    const result = edgeToGreeks(makeEdge(strikes, edge), 100);
    expect(result.targetDelta).toBeGreaterThan(0);
    expect(result.deltaDirection).toBe("bullish");
  });

  it("positive downside edge → negative delta", () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 80 + i);
    const edge = strikes.map((K) => (K < 100 ? 0.01 : -0.01));
    const result = edgeToGreeks(makeEdge(strikes, edge), 100);
    expect(result.targetDelta).toBeLessThan(0);
    expect(result.deltaDirection).toBe("bearish");
  });

  it("wider model distribution → positive vega target", () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 80 + i);
    // more weight in wings (wider distribution)
    const edge = strikes.map((K) => {
      const d = Math.abs(K - 100);
      return d > 10 ? 0.005 : -0.005;
    });
    const result = edgeToGreeks(makeEdge(strikes, edge), 100);
    expect(result.targetVega).toBeGreaterThan(0);
    expect(result.vegaDirection).toBe("long vol");
  });

  it("narrower model distribution → negative vega target", () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 80 + i);
    // more weight in center (narrower distribution)
    const edge = strikes.map((K) => {
      const d = Math.abs(K - 100);
      return d < 5 ? 0.01 : -0.005;
    });
    const result = edgeToGreeks(makeEdge(strikes, edge), 100);
    expect(result.targetVega).toBeLessThan(0);
    expect(result.vegaDirection).toBe("short vol");
  });

  it("symmetric edge → neutral delta", () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 80 + i);
    // perfectly symmetric edge around spot
    const edge = strikes.map((K) => {
      const d = K - 100;
      return Math.exp((-d * d) / 50) * 0.01 - 0.005;
    });
    const result = edgeToGreeks(makeEdge(strikes, edge), 100);
    // delta should be near zero due to symmetry
    expect(Math.abs(result.targetDelta)).toBeLessThan(0.5);
  });

  it("totalAbsEdge measures overall mispricing", () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 80 + i);
    const edge = strikes.map(() => 0.01);
    const result = edgeToGreeks(makeEdge(strikes, edge), 100);
    expect(result.totalAbsEdge).toBeGreaterThan(0);
  });
});

describe("multiExpiryEdgeGreeks", () => {
  it("handles empty input", () => {
    const result = multiExpiryEdgeGreeks([], 100);
    expect(result.targetDelta).toBe(0);
    expect(result.expiries).toHaveLength(0);
  });

  it("single expiry returns same as edgeToGreeks", () => {
    const strikes = Array.from({ length: 21 }, (_, i) => 90 + i);
    const edge = strikes.map((K) => (K > 100 ? 0.01 : -0.01));
    const edgeData = makeEdge(strikes, edge, 30);
    const single = edgeToGreeks(edgeData, 100);
    const multi = multiExpiryEdgeGreeks([edgeData], 100);
    expect(multi.targetDelta).toBeCloseTo(single.targetDelta, 4);
  });

  it("near-term edge is weighted more than far-term", () => {
    const strikes = Array.from({ length: 21 }, (_, i) => 90 + i);
    // near-term bullish, far-term bearish
    const nearEdge = makeEdge(
      strikes,
      strikes.map((K) => (K > 100 ? 0.01 : -0.01)),
      10,
    );
    const farEdge = makeEdge(
      strikes,
      strikes.map((K) => (K > 100 ? -0.01 : 0.01)),
      180,
    );
    const result = multiExpiryEdgeGreeks([nearEdge, farEdge], 100);
    // near-term should dominate → net bullish
    expect(result.targetDelta).toBeGreaterThan(0);
  });
});
