// Generate the equivalence corpus from `javascript-lp-solver`.
//
// Each fixture is a JSON file containing { model, expected }, where:
//   - `model` is the portable LpModel shape (objective name + opType +
//     constraints + variables + ints).
//   - `expected` is the LpSolution as returned by the JS solver, captured
//     by re-running this generator. Fields: feasible, objectiveValue,
//     values.
//
// The Rust equivalence test (`tests/equivalence.rs`) loads each file,
// solves via qf-optimizer, and asserts the result matches `expected`
// within tolerance.
//
// Re-run only when fixtures change:
//
//   node core/qf-optimizer/tests/fixtures/equivalence_v1/gen.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import solver from "javascript-lp-solver";

const HERE = dirname(fileURLToPath(import.meta.url));
mkdirSync(HERE, { recursive: true });

// ── LP shapes ──────────────────────────────────────────────────────────
// 1. Trivial max with a single budget constraint.
const maxSingleBudget = {
  optimize: "obj",
  opType: "max",
  constraints: {
    budget: { max: 10 },
  },
  variables: {
    x: { obj: 5, budget: 2 },
    y: { obj: 3, budget: 1 },
  },
  ints: {},
};

// 2. Min with floor.
const minFloor = {
  optimize: "obj",
  opType: "min",
  constraints: {
    floor: { min: 7 },
  },
  variables: {
    a: { obj: 2, floor: 1 },
    b: { obj: 1, floor: 1 },
  },
  ints: {},
};

// 3. Portfolio-shape: 4 candidates, delta band, vega band, budget cap,
//    position-count cap. Mirrors solveLP() in lp-optimizer.js — but
//    continuous, to test the LP-only path.
const portfolioContinuous = {
  optimize: "expectedPnL",
  opType: "max",
  constraints: {
    deltaLower: { min: -50 },
    deltaUpper: { max: 50 },
    vegaLower: { min: -50 },
    vegaUpper: { max: 50 },
    budget: { max: 5000 },
    posCount: { max: 8 },
  },
  variables: {
    long_call_100: {
      expectedPnL: 120,
      deltaLower: 55,
      deltaUpper: 55,
      vegaLower: 18,
      vegaUpper: 18,
      budget: 350,
      posCount: 1,
    },
    short_call_110: {
      expectedPnL: 80,
      deltaLower: -35,
      deltaUpper: -35,
      vegaLower: -12,
      vegaUpper: -12,
      budget: 200,
      posCount: 1,
    },
    long_put_95: {
      expectedPnL: 70,
      deltaLower: -45,
      deltaUpper: -45,
      vegaLower: 16,
      vegaUpper: 16,
      budget: 280,
      posCount: 1,
    },
    short_put_90: {
      expectedPnL: 60,
      deltaLower: 30,
      deltaUpper: 30,
      vegaLower: -10,
      vegaUpper: -10,
      budget: 150,
      posCount: 1,
    },
  },
  ints: {},
};

// 4. Portfolio-shape: integer version of #3. Forces a MIP solve. Same
//    candidates, tighter delta band so the rounding matters.
const portfolioInteger = {
  optimize: "expectedPnL",
  opType: "max",
  constraints: {
    deltaLower: { min: -20 },
    deltaUpper: { max: 20 },
    budget: { max: 1500 },
    posCount: { max: 4 },
  },
  variables: {
    L1: { expectedPnL: 100, deltaLower: 50, deltaUpper: 50, budget: 300, posCount: 1 },
    S1: { expectedPnL: 60, deltaLower: -40, deltaUpper: -40, budget: 200, posCount: 1 },
    L2: { expectedPnL: 80, deltaLower: 30, deltaUpper: 30, budget: 250, posCount: 1 },
    S2: { expectedPnL: 45, deltaLower: -25, deltaUpper: -25, budget: 180, posCount: 1 },
  },
  ints: { L1: 1, S1: 1, L2: 1, S2: 1 },
};

// 5. Greek-Builder shape: continuous, flat-delta + max-gamma. Mirrors
//    solveGreekLP() with one greek in the objective and the rest in
//    flat bands.
const greekBuilderFlatDelta = {
  optimize: "objValue",
  opType: "max",
  constraints: {
    deltaLB: { min: -0.45 },
    deltaUB: { max: 0.45 },
    thetaLB: { min: -0.18 },
    thetaUB: { max: 0.18 },
    marginBudget: { max: 2000 },
    posCount: { max: 6 },
  },
  variables: {
    // High-gamma, near-ATM long calls/puts.
    LC100: {
      objValue: 0.045,
      deltaLB: 0.52,
      deltaUB: 0.52,
      thetaLB: -0.04,
      thetaUB: -0.04,
      marginBudget: 380,
      posCount: 1,
    },
    LP100: {
      objValue: 0.045,
      deltaLB: -0.48,
      deltaUB: -0.48,
      thetaLB: -0.04,
      thetaUB: -0.04,
      marginBudget: 360,
      posCount: 1,
    },
    LC105: {
      objValue: 0.038,
      deltaLB: 0.35,
      deltaUB: 0.35,
      thetaLB: -0.035,
      thetaUB: -0.035,
      marginBudget: 240,
      posCount: 1,
    },
    LP95: {
      objValue: 0.038,
      deltaLB: -0.31,
      deltaUB: -0.31,
      thetaLB: -0.035,
      thetaUB: -0.035,
      marginBudget: 220,
      posCount: 1,
    },
  },
  ints: {},
};

// 6. Infeasible: contradicting bounds.
const infeasible = {
  optimize: "obj",
  opType: "max",
  constraints: {
    lo: { min: 5 },
    hi: { max: 2 },
  },
  variables: {
    x: { obj: 1, lo: 1, hi: 1 },
  },
  ints: {},
};

// 7. Single variable + two-sided band → forces the band's upper edge.
const twoSidedBand = {
  optimize: "obj",
  opType: "max",
  constraints: {
    band: { min: 1, max: 4 },
  },
  variables: {
    x: { obj: 1, band: 1 },
  },
  ints: {},
};

// ── Solver harness ─────────────────────────────────────────────────────
// js-lp-solver returns a flat object with the variable values and a
// `feasible` flag + `result` (= objective value). Normalize to the
// shape qf-optimizer's LpSolution uses.
function captureExpected(model) {
  const out = solver.Solve(structuredClone(model));
  const values = {};
  for (const varName of Object.keys(model.variables)) {
    values[varName] = out[varName] || 0;
  }
  return {
    feasible: Boolean(out.feasible),
    objectiveValue: out.feasible ? out.result : 0,
    values,
  };
}

const corpus = [
  ["max_single_budget", maxSingleBudget],
  ["min_floor", minFloor],
  ["portfolio_continuous", portfolioContinuous],
  ["portfolio_integer", portfolioInteger],
  ["greek_builder_flat_delta", greekBuilderFlatDelta],
  ["infeasible", infeasible],
  ["two_sided_band", twoSidedBand],
];

for (const [name, model] of corpus) {
  const expected = captureExpected(model);
  const fixture = { model, expected };
  const path = join(HERE, `${name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(`${name}: feasible=${expected.feasible}, obj=${expected.objectiveValue.toFixed(4)}`);
}
