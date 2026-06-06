// Web Worker that owns the Greek Builder LP solve.
//
// Wires the qf-optimizer WASM module (QF-133) into the existing
// `solveGreekBuilder` pipeline as a drop-in replacement for the
// javascript-lp-solver `.Solve()` call. The candidate-generation,
// margin-reconciliation, and result-formatting logic stays in
// lp-optimizer.js — only the solver call swaps.
//
// `javascript-lp-solver` stays as the default for any other call sites
// until QF-135 (the call-site swap). This worker is the only browser
// caller; the swap here is the bulk of the JS-solver retirement.

import { solveGreekBuilder } from "./lp-optimizer.js";
import init, { installPanicHook, solve as wasmSolve } from "./wasm/qf_optimizer/qf_optimizer.js";

// js-lp-solver's `.Solve()` return shape:
//   { feasible, result, bounded, varName1: val1, varName2: val2, ... }
// qf-optimizer (WASM) return shape:
//   { feasible, objective_value, values: { varName1: val1, ... } }
// Adapter flattens the latter into the former so solveGreekBuilder doesn't
// know which solver it's talking to.
interface JsLpSolverModel {
  optimize: string;
  opType: "max" | "min";
  constraints: Record<string, { min?: number; max?: number }>;
  variables: Record<string, Record<string, number>>;
  ints?: Record<string, number>;
}

interface JsLpSolverResult {
  feasible: boolean;
  result: number;
  bounded: boolean;
  [varName: string]: number | boolean;
}

interface WasmSolution {
  feasible: boolean;
  objective_value: number;
  values: Record<string, number>;
}

interface JsLpSolverLike {
  Solve(model: JsLpSolverModel): JsLpSolverResult;
}

// Initialize the WASM module once on worker startup, before the first
// message. `init()` returns a promise; the handler awaits the same
// promise so messages don't race the WASM load.
const wasmReady: Promise<JsLpSolverLike> = init().then(() => {
  installPanicHook();
  return {
    Solve(model: JsLpSolverModel): JsLpSolverResult {
      const solution = wasmSolve(model) as WasmSolution;
      const flat: JsLpSolverResult = {
        feasible: solution.feasible,
        result: solution.objective_value,
        // js-lp-solver sets `bounded: true` for any feasible solution.
        // qf-optimizer's `feasible: false` already covers infeasible
        // and unbounded together (matching the legacy JS shape).
        bounded: solution.feasible,
      };
      for (const [name, val] of Object.entries(solution.values)) {
        flat[name] = val;
      }
      return flat;
    },
  };
});

// The chain + options shapes belong to lp-optimizer.js, which is still
// untyped JS (slated for deletion in QF-135). Pass them through as
// `unknown` — the solver-injection contract is the only typed surface
// this worker owns.
self.onmessage = async (e: MessageEvent<{ chain: unknown; options: unknown }>) => {
  const solver = await wasmReady;
  const { chain, options } = e.data;
  const t0 = performance.now();
  // solveGreekBuilder accepts an optional solver param (added by this
  // ticket); see lp-optimizer.js. Passing `solver` overrides the
  // js-lp-solver default.
  // lp-optimizer.js is still untyped JS (slated for deletion in QF-135),
  // so TS infers its argument types loosely (the `solver` slot ends up
  // as `typeof javascript-lp-solver` which doesn't accept our minimal
  // shim). Cast the args through `unknown`. QF-135 deletes both this
  // file and lp-optimizer.js, so refining the types here is wasted work.
  type SolveGreekBuilderArgs = Parameters<typeof solveGreekBuilder>;
  const result = solveGreekBuilder(
    chain as SolveGreekBuilderArgs[0],
    options as SolveGreekBuilderArgs[1],
    solver as unknown as SolveGreekBuilderArgs[2],
  ) as unknown as Record<string, unknown>;
  result.solveMs = Math.round(performance.now() - t0);
  result.solverBackend = "wasm";
  self.postMessage(result);
};
