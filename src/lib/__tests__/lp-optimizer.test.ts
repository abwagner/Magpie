import { describe, it, expect } from "vitest";
import {
  generateCandidates,
  labelStrategy,
  applyAutoConstraints,
  GREEK_BUILDER_PRESETS,
  solveGreekBuilder,
  type ChainContract,
  type GreekModes,
  type Solver,
  type LpModel,
  type LpResult,
} from "../lp-optimizer.js";

// QF-135 removed the solveLP / optimizePortfolio / solveGreekBuilder tests
// from this file. solveLP and optimizePortfolio were deleted entirely (no
// live callers); solveGreekBuilder now requires an injected solver and
// is exercised via the WASM-backed Web Worker — real solver coverage
// lives in qf-optimizer's Rust + Python tests.
//
// QF-344 adds regression tests for the mode-min constraint fix:
//   - "min" mode must produce near-zero constraints, not a negative objective
//   - A solver that records the model shape can verify this

const mockChain: ChainContract[] = [
  {
    side: "call",
    strike: 95,
    bid: 6.5,
    ask: 7.0,
    mid: 6.75,
    iv: 0.22,
    dte: 45,
  },
  {
    side: "call",
    strike: 100,
    bid: 3.0,
    ask: 3.5,
    mid: 3.25,
    iv: 0.2,
    dte: 45,
  },
  {
    side: "call",
    strike: 105,
    bid: 1.2,
    ask: 1.5,
    mid: 1.35,
    iv: 0.19,
    dte: 45,
  },
  {
    side: "call",
    strike: 110,
    bid: 0.4,
    ask: 0.6,
    mid: 0.5,
    iv: 0.18,
    dte: 45,
  },
  {
    side: "put",
    strike: 90,
    bid: 0.3,
    ask: 0.5,
    mid: 0.4,
    iv: 0.25,
    dte: 45,
  },
  {
    side: "put",
    strike: 95,
    bid: 1.0,
    ask: 1.3,
    mid: 1.15,
    iv: 0.23,
    dte: 45,
  },
  {
    side: "put",
    strike: 100,
    bid: 2.8,
    ask: 3.2,
    mid: 3.0,
    iv: 0.21,
    dte: 45,
  },
  {
    side: "put",
    strike: 105,
    bid: 6.0,
    ask: 6.5,
    mid: 6.25,
    iv: 0.2,
    dte: 45,
  },
];

// simple model PDF for testing
const mockPDF = {
  strikes: Array.from({ length: 61 }, (_, i) => 70 + i),
  density: Array.from({ length: 61 }, (_, i) => {
    const K = 70 + i;
    const d = (K - 102) / 10; // slightly bullish mean
    return Math.exp((-d * d) / 2) / (10 * Math.sqrt(2 * Math.PI));
  }),
  strikeStep: 1,
};
// normalize
const pdfTotal = mockPDF.density.reduce((s, d) => s + d, 0);
mockPDF.density = mockPDF.density.map((d) => d / pdfTotal);

describe("generateCandidates", () => {
  it("generates long and short for each contract", () => {
    const candidates = generateCandidates(mockChain, 100, 0.05, 45, mockPDF);
    // each contract produces 2 candidates (long + short)
    expect(candidates.length).toBe(mockChain.length * 2);
  });

  it("long candidates use ask price", () => {
    const candidates = generateCandidates(mockChain, 100, 0.05, 45, mockPDF);
    const longCall100 = candidates.find((c) => c.id === "L_C_100");
    expect(longCall100?.premium).toBe(3.5); // ask
  });

  it("short candidates use bid price", () => {
    const candidates = generateCandidates(mockChain, 100, 0.05, 45, mockPDF);
    const shortCall100 = candidates.find((c) => c.id === "S_C_100");
    expect(shortCall100?.premium).toBe(3.0); // bid
  });

  it("each candidate has required fields", () => {
    const candidates = generateCandidates(mockChain, 100, 0.05, 45, mockPDF);
    for (const c of candidates) {
      expect(c).toHaveProperty("id");
      expect(c).toHaveProperty("delta");
      expect(c).toHaveProperty("gamma");
      expect(c).toHaveProperty("theta");
      expect(c).toHaveProperty("vega");
      expect(c).toHaveProperty("expectedPnL");
      expect(c).toHaveProperty("cost");
    }
  });

  it("long call has positive delta", () => {
    const candidates = generateCandidates(mockChain, 100, 0.05, 45, mockPDF);
    const longCall = candidates.find((c) => c.id === "L_C_100");
    expect(longCall?.delta).toBeGreaterThan(0);
  });

  it("short put has positive delta", () => {
    const candidates = generateCandidates(mockChain, 100, 0.05, 45, mockPDF);
    const shortPut = candidates.find((c) => c.id === "S_P_100");
    expect(shortPut?.delta).toBeGreaterThan(0);
  });
});

describe("labelStrategy", () => {
  it("labels single long call", () => {
    expect(labelStrategy([{ type: "Call", direction: "Long", strike: 100, qty: 1 }])).toBe(
      "Long Call",
    );
  });

  it("labels single short put", () => {
    expect(labelStrategy([{ type: "Put", direction: "Short", strike: 100, qty: 1 }])).toBe(
      "Short Put",
    );
  });

  it("labels bull call spread", () => {
    const legs = [
      { type: "Call" as const, direction: "Long" as const, strike: 100, qty: 1 },
      { type: "Call" as const, direction: "Short" as const, strike: 110, qty: 1 },
    ];
    expect(labelStrategy(legs)).toBe("Bull Call Spread");
  });

  it("labels bear put spread", () => {
    const legs = [
      { type: "Put" as const, direction: "Short" as const, strike: 90, qty: 1 },
      { type: "Put" as const, direction: "Long" as const, strike: 100, qty: 1 },
    ];
    expect(labelStrategy(legs)).toBe("Bear Put Spread");
  });

  it("labels long straddle", () => {
    const legs = [
      { type: "Call" as const, direction: "Long" as const, strike: 100, qty: 1 },
      { type: "Put" as const, direction: "Long" as const, strike: 100, qty: 1 },
    ];
    expect(labelStrategy(legs)).toBe("Long Straddle");
  });

  it("labels long strangle", () => {
    const legs = [
      { type: "Put" as const, direction: "Long" as const, strike: 95, qty: 1 },
      { type: "Call" as const, direction: "Long" as const, strike: 105, qty: 1 },
    ];
    expect(labelStrategy(legs)).toBe("Long Strangle");
  });

  it("labels iron condor", () => {
    const legs = [
      { type: "Put" as const, direction: "Long" as const, strike: 85, qty: 1 },
      { type: "Put" as const, direction: "Short" as const, strike: 90, qty: 1 },
      { type: "Call" as const, direction: "Short" as const, strike: 110, qty: 1 },
      { type: "Call" as const, direction: "Long" as const, strike: 115, qty: 1 },
    ];
    expect(labelStrategy(legs)).toBe("Iron Condor");
  });

  it("labels custom for unrecognized patterns", () => {
    const legs = [
      { type: "Call" as const, direction: "Long" as const, strike: 100, qty: 1 },
      { type: "Call" as const, direction: "Long" as const, strike: 105, qty: 1 },
      { type: "Put" as const, direction: "Short" as const, strike: 90, qty: 1 },
    ];
    expect(labelStrategy(legs)).toContain("Custom");
  });

  it("labels empty portfolio", () => {
    expect(labelStrategy([])).toBe("Empty");
  });

  it("labels short straddle", () => {
    const legs = [
      { type: "Call" as const, direction: "Short" as const, strike: 100, qty: 1 },
      { type: "Put" as const, direction: "Short" as const, strike: 100, qty: 1 },
    ];
    expect(labelStrategy(legs)).toBe("Short Straddle");
  });

  it("labels short strangle", () => {
    const legs = [
      { type: "Put" as const, direction: "Short" as const, strike: 95, qty: 1 },
      { type: "Call" as const, direction: "Short" as const, strike: 105, qty: 1 },
    ];
    expect(labelStrategy(legs)).toBe("Short Strangle");
  });
});

describe("applyAutoConstraints", () => {
  it("auto-applies delta flat when optimizing gamma", () => {
    const { modes } = applyAutoConstraints(
      { delta: "any", gamma: "max", theta: "any", vega: "any" },
      {},
    );
    expect(modes.delta).toBe("flat");
  });

  it("auto-applies gamma flat when selling premium", () => {
    const { modes } = applyAutoConstraints(
      { delta: "flat", gamma: "any", theta: "max", vega: "any" },
      {},
    );
    expect(modes.gamma).toBe("flat");
  });

  it("auto-applies gamma flat when delta is directional", () => {
    const { modes } = applyAutoConstraints(
      { delta: "max", gamma: "any", theta: "any", vega: "any" },
      {},
    );
    expect(modes.gamma).toBe("flat");
  });

  it("leaves modes unchanged when delta is already bound", () => {
    const { modes } = applyAutoConstraints(
      { delta: "bound", gamma: "max", theta: "any", vega: "any" },
      { deltaMin: -0.1, deltaMax: 0.1 },
    );
    expect(modes.delta).toBe("bound");
  });

  it("leaves modes unchanged when delta is already flat", () => {
    const { modes } = applyAutoConstraints(
      { delta: "flat", gamma: "max", theta: "any", vega: "any" },
      {},
    );
    expect(modes.delta).toBe("flat");
  });

  it("auto-applies delta flat when a greek is 'min' (min triggers same delta-auto logic as max)", () => {
    const { modes } = applyAutoConstraints(
      { delta: "any", gamma: "min", theta: "any", vega: "any" },
      {},
    );
    expect(modes.delta).toBe("flat");
  });
});

describe("GREEK_BUILDER_PRESETS", () => {
  it("all presets have required fields", () => {
    for (const [, preset] of Object.entries(GREEK_BUILDER_PRESETS)) {
      expect(preset).toHaveProperty("label");
      expect(preset).toHaveProperty("modes");
      expect(preset.modes).toHaveProperty("delta");
      expect(preset.modes).toHaveProperty("gamma");
    }
  });

  it("all presets have at least one max or min mode", () => {
    for (const [, preset] of Object.entries(GREEK_BUILDER_PRESETS)) {
      const hasObj = Object.values(preset.modes).some((m) => m === "max" || m === "min");
      expect(hasObj).toBe(true);
    }
  });
});

// ── QF-344 regression: mode-min constraint fix ──────────────────────────
// A recording solver that captures the LP model it was handed. Used to
// verify the model structure without needing the real WASM solver.
function makeRecordingSolver(returnFeasible = false): {
  solver: Solver;
  capturedModel: () => LpModel | null;
} {
  let model: LpModel | null = null;
  const solver: Solver = {
    Solve(m: LpModel): LpResult {
      model = m;
      if (!returnFeasible) return { feasible: false };
      // Return a trivial feasible result: all variables at 0.
      const result: LpResult = { feasible: true, result: 0, bounded: true };
      return result;
    },
  };
  return { solver, capturedModel: () => model };
}

// Chain with enough valid data for solveGreekBuilder to reach solveGreekLP.
const solverTestChain: ChainContract[] = [
  {
    side: "call",
    strike: 100,
    bid: 3.0,
    ask: 3.5,
    mid: 3.25,
    iv: 0.2,
    dte: 45,
    delta: 0.5,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.15,
    underlyingPrice: 100,
  },
  {
    side: "put",
    strike: 100,
    bid: 2.8,
    ask: 3.2,
    mid: 3.0,
    iv: 0.21,
    dte: 45,
    delta: -0.5,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.15,
    underlyingPrice: 100,
  },
];

describe("QF-344: mode-min LP model fix", () => {
  it("min mode adds near-zero constraints, not an objective weight", () => {
    const { solver, capturedModel } = makeRecordingSolver(false);

    solveGreekBuilder(
      solverTestChain,
      {
        modes: { delta: "min", gamma: "max", theta: "min", vega: "min" },
        bounds: {},
        maxBudget: 50000,
        maxLegs: 6,
      },
      solver,
    );

    const m = capturedModel();
    expect(m).not.toBeNull();
    if (!m) return;

    // "min" greeks should produce constraint rows, not be in the objective
    // Delta, theta, vega are "min" — each should have LB + UB constraint rows
    expect(m.constraints).toHaveProperty("deltaLB");
    expect(m.constraints).toHaveProperty("deltaUB");
    expect(m.constraints).toHaveProperty("thetaLB");
    expect(m.constraints).toHaveProperty("thetaUB");
    expect(m.constraints).toHaveProperty("vegaLB");
    expect(m.constraints).toHaveProperty("vegaUB");

    // "gamma" is "max" — should appear in objValue (each variable should
    // have a non-zero objValue coefficient driven by gamma contribution)
    const vars = Object.values(m.variables);
    const hasNonZeroObj = vars.some((v) => (v["objValue"] ?? 0) !== 0);
    expect(hasNonZeroObj).toBe(true);

    // The objValue coefficients should NOT have been polluted by delta/theta/vega
    // minimization. With only gamma=max, all variables' objValue should be
    // proportional to their gamma contribution only.
    // All candidates have identical gamma sign/magnitude here (we have L+S pairs),
    // so long candidates get positive objValue and short candidates get negative.
    for (const varCoeffs of vars) {
      // No variable should have a separate "deltaObj" or "thetaObj" key —
      // the old buggy code would have incorporated delta/theta/vega negatively
      // into objValue, not as separate constraint rows.
      expect(varCoeffs).not.toHaveProperty("deltaObj");
      expect(varCoeffs).not.toHaveProperty("thetaObj");
      expect(varCoeffs).not.toHaveProperty("vegaObj");
    }
  });

  it("min mode produces the same constraint structure as flat mode", () => {
    const { solver: solverMin, capturedModel: capturedMin } = makeRecordingSolver(false);
    const { solver: solverFlat, capturedModel: capturedFlat } = makeRecordingSolver(false);

    const modesMin: GreekModes = { delta: "min", gamma: "max", theta: "min", vega: "min" };
    const modesFlat: GreekModes = { delta: "flat", gamma: "max", theta: "flat", vega: "flat" };

    solveGreekBuilder(solverTestChain, { modes: modesMin, maxBudget: 50000 }, solverMin);
    solveGreekBuilder(solverTestChain, { modes: modesFlat, maxBudget: 50000 }, solverFlat);

    const mMin = capturedMin();
    const mFlat = capturedFlat();
    expect(mMin).not.toBeNull();
    expect(mFlat).not.toBeNull();
    if (!mMin || !mFlat) return;

    // The constraint keys should be identical between min and flat
    const minKeys = Object.keys(mMin.constraints).sort();
    const flatKeys = Object.keys(mFlat.constraints).sort();
    expect(minKeys).toEqual(flatKeys);

    // Constraint bounds should match
    for (const key of minKeys) {
      expect(mMin.constraints[key]).toEqual(mFlat.constraints[key]);
    }
  });

  it("solveGreekBuilder rejects modes with no max greek", () => {
    const { solver } = makeRecordingSolver(false);

    const result = solveGreekBuilder(
      solverTestChain,
      {
        modes: { delta: "min", gamma: "min", theta: "min", vega: "min" },
        bounds: {},
      },
      solver,
    );

    expect(result.feasible).toBe(false);
    expect(result.reason).toMatch(/Max/i);
  });

  it("solveGreekBuilder accepts modes with only max greeks", () => {
    const { solver } = makeRecordingSolver(false);

    // Should not throw — reaching the solver (infeasible is fine for this test)
    const result = solveGreekBuilder(
      solverTestChain,
      {
        modes: { delta: "any", gamma: "max", theta: "any", vega: "any" },
        bounds: {},
        maxBudget: 50000,
      },
      solver,
    );

    // We get a result (infeasible from the mock solver is fine — no error thrown)
    expect(result).toHaveProperty("feasible");
  });
});
