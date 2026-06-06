// Cross-language equivalence fixture generator for qf-quant.
//
// ⚠️  DO NOT REGENERATE AS PART OF NORMAL WORK — the committed fixture is
//    an archaeological record of the pre-Phase-1.5 JS pricing surface.
//    Both halves of the equivalence have moved past it:
//
//      • Phase 1.5 (QF-102/103) flipped Rust BS/Black76 to `cdf_correct`.
//      • QF-185 flipped JS bs.ts to the same erf-based form.
//
//    The Rust harness preserves the pre-cutover comparison on purpose
//    (`expected_divergence.toml` bounds the BS/Black76 gap; the
//    `normal::cdf` arm still calls the deprecated buggy fn so the
//    fixture lines up). Re-running this generator against the new
//    JS would re-anchor the fixture to textbook-correct values; the
//    Rust harness would then fail on every `normal::cdf` case
//    (Rust returns the buggy value by design). The cleanup is
//    Phase-6 work — retiring `normal::cdf` and the bug-for-bug
//    fixture in one go.
//
// Run from the Magpie repo root, only when retiring the
// archaeological fixture under Phase 6:
//
//   npx tsx core/qf-quant/tests/fixtures/equivalence_v1/generate.mjs
//   (`tsx` is required since QF-185; `src/lib/bs.ts` is no longer .js.)
//
// Writes one JSON file per function group alongside this script:
//   - normal.json        — normal::cdf, normal::pdf
//   - bs.json            — bs::{call,put,delta,gamma,theta,vega,implied_vol}
//   - black76.json       — black76::{call,put,delta,gamma,theta,vega,implied_vol}
//   - futures_specs.json — futures_specs::{futures_root,get_futures_spec_present}
//
// Each file has the same schema:
//   {
//     "schema_version": 1,
//     "function":       "<canonical name>",
//     "input_columns":  ["<col0>", "<col1>", ...],
//     "cases": [
//       {"id": "<unique>", "inputs": [...], "expected": <number or string>, "tolerance": 1e-9}
//     ]
//   }
//
// The fixture is deterministic and re-runnable — no RNG, no time-of-day.

import { BS, Black76 } from "../../../../../src/lib/bs.js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOL_DEFAULT = 1e-9;
// Looser tolerance for IV because the bisection convergence is to 1e-6 in
// price-space; vol-space error compounds to a few ULP times that. Rust and JS
// use identical bisection arithmetic over the same bracket, so we *expect*
// bit-equal — but allow 1e-8 to keep the harness honest about what the
// converged vol means.
const TOL_IV = 1e-8;

const SPOT = 100;
const STRIKES = [70, 85, 95, 100, 105, 115, 130];
const RATES = [0.0, 0.05, 0.1];
const TTMS = [0.05, 0.25, 1.0, 2.0];
const VOLS = [0.1, 0.25, 0.5, 1.0];

// Sampled x for normal CDF/PDF. Spans the body and both tails plus a few
// pathological points (exact zero, large magnitude).
const NORMAL_XS = (() => {
  const xs = [0, 1e-6, -1e-6, 4.5, -4.5, 8, -8];
  // Linear sweep from -3 to 3 in steps of 0.025 = 241 samples.
  for (let i = -120; i <= 120; i++) xs.push(i * 0.025);
  // Wider sweep -6..6 in steps of 0.2 = 61 samples.
  for (let i = -30; i <= 30; i++) xs.push(i * 0.2);
  return xs;
})();

function writeFixture(name, fn, columns, cases) {
  const out = {
    schema_version: 1,
    function: fn,
    input_columns: columns,
    cases,
  };
  const path = join(HERE, `${name}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(`${path}  ${cases.length} cases`);
}

// ── normal ───────────────────────────────────────────────────────────────

{
  const cases = NORMAL_XS.map((x, i) => ({
    id: `cdf_${i.toString().padStart(4, "0")}`,
    inputs: [x],
    expected: BS.N(x),
    tolerance: TOL_DEFAULT,
  }));
  writeFixture("normal_cdf", "normal::cdf", ["x"], cases);
}

{
  const pdfFn = (x) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
  const cases = NORMAL_XS.map((x, i) => ({
    id: `pdf_${i.toString().padStart(4, "0")}`,
    inputs: [x],
    expected: pdfFn(x),
    tolerance: TOL_DEFAULT,
  }));
  writeFixture("normal_pdf", "normal::pdf", ["x"], cases);
}

// ── option-pricing grid (shared by bs and black76) ────────────────────────

const GRID = [];
for (const K of STRIKES)
  for (const r of RATES) for (const T of TTMS) for (const v of VOLS) GRID.push({ K, r, T, v });

console.log(`Option grid: ${GRID.length} unique (K, r, T, v) tuples`);

function emitPricing(prefix, fnName, fnCall, fnPut, columns) {
  const fns = {
    call: (g) => fnCall(SPOT, g.K, g.r, g.T, g.v),
    put: (g) => fnPut(SPOT, g.K, g.r, g.T, g.v),
  };
  for (const [name, evaluator] of Object.entries(fns)) {
    const cases = GRID.map((g, i) => ({
      id: `${prefix}_${name}_${i.toString().padStart(4, "0")}`,
      inputs: [SPOT, g.K, g.r, g.T, g.v],
      expected: evaluator(g),
      tolerance: TOL_DEFAULT,
    }));
    writeFixture(`${prefix}_${name}`, `${fnName}::${name}`, columns, cases);
  }
}

function emitGreek(prefix, fnName, greek, greekFnCall, greekFnPut, columns) {
  // delta / theta / implied_vol have a Call/Put kind; gamma / vega don't.
  const variants = greekFnPut
    ? [
        ["call", greekFnCall],
        ["put", greekFnPut],
      ]
    : [["", greekFnCall]];
  for (const [kind, evaluator] of variants) {
    const suffix = kind ? `_${kind}` : "";
    const cases = GRID.map((g, i) => ({
      id: `${prefix}_${greek}${suffix}_${i.toString().padStart(4, "0")}`,
      inputs: [SPOT, g.K, g.r, g.T, g.v],
      expected: evaluator(g),
      tolerance: TOL_DEFAULT,
    }));
    writeFixture(`${prefix}_${greek}${suffix}`, `${fnName}::${greek}${suffix}`, columns, cases);
  }
}

// ── bs ────────────────────────────────────────────────────────────────────

emitPricing(
  "bs",
  "bs",
  (S, K, r, T, v) => BS.call(S, K, r, T, v),
  (S, K, r, T, v) => BS.put(S, K, r, T, v),
  ["S", "K", "r", "T", "v"],
);

emitGreek(
  "bs",
  "bs",
  "delta",
  (g) => BS.delta(SPOT, g.K, g.r, g.T, g.v, "Call"),
  (g) => BS.delta(SPOT, g.K, g.r, g.T, g.v, "Put"),
  ["S", "K", "r", "T", "v"],
);
emitGreek("bs", "bs", "gamma", (g) => BS.gamma(SPOT, g.K, g.r, g.T, g.v), null, [
  "S",
  "K",
  "r",
  "T",
  "v",
]);
emitGreek(
  "bs",
  "bs",
  "theta",
  (g) => BS.theta(SPOT, g.K, g.r, g.T, g.v, "Call"),
  (g) => BS.theta(SPOT, g.K, g.r, g.T, g.v, "Put"),
  ["S", "K", "r", "T", "v"],
);
emitGreek("bs", "bs", "vega", (g) => BS.vega(SPOT, g.K, g.r, g.T, g.v), null, [
  "S",
  "K",
  "r",
  "T",
  "v",
]);

// Implied vol: round-trip a call/put price, expect the same vol back. Skip
// the (rare) cases where the JS solver returns null (price below intrinsic).
function emitIV(prefix, fnName, priceFn, ivFn, columns) {
  for (const kind of ["call", "put"]) {
    const cases = [];
    for (let i = 0; i < GRID.length; i++) {
      const g = GRID[i];
      const price = priceFn(SPOT, g.K, g.r, g.T, g.v, kind);
      const solvedVol = ivFn(SPOT, g.K, g.r, g.T, price, kind);
      if (solvedVol == null || !Number.isFinite(solvedVol)) continue;
      cases.push({
        id: `${prefix}_iv_${kind}_${i.toString().padStart(4, "0")}`,
        inputs: [SPOT, g.K, g.r, g.T, price],
        expected: solvedVol,
        tolerance: TOL_IV,
      });
    }
    writeFixture(`${prefix}_iv_${kind}`, `${fnName}::implied_vol_${kind}`, columns, cases);
  }
}
emitIV(
  "bs",
  "bs",
  (S, K, r, T, v, kind) => (kind === "call" ? BS.call(S, K, r, T, v) : BS.put(S, K, r, T, v)),
  (S, K, r, T, price, kind) => BS.impliedVol(S, K, r, T, price, kind === "call" ? "Call" : "Put"),
  ["S", "K", "r", "T", "market_price"],
);

// ── black76 ───────────────────────────────────────────────────────────────

emitPricing(
  "black76",
  "black76",
  (F, K, r, T, v) => Black76.call(F, K, r, T, v),
  (F, K, r, T, v) => Black76.put(F, K, r, T, v),
  ["F", "K", "r", "T", "v"],
);
emitGreek(
  "black76",
  "black76",
  "delta",
  (g) => Black76.delta(SPOT, g.K, g.r, g.T, g.v, "Call"),
  (g) => Black76.delta(SPOT, g.K, g.r, g.T, g.v, "Put"),
  ["F", "K", "r", "T", "v"],
);
emitGreek("black76", "black76", "gamma", (g) => Black76.gamma(SPOT, g.K, g.r, g.T, g.v), null, [
  "F",
  "K",
  "r",
  "T",
  "v",
]);
emitGreek(
  "black76",
  "black76",
  "theta",
  (g) => Black76.theta(SPOT, g.K, g.r, g.T, g.v, "Call"),
  (g) => Black76.theta(SPOT, g.K, g.r, g.T, g.v, "Put"),
  ["F", "K", "r", "T", "v"],
);
emitGreek("black76", "black76", "vega", (g) => Black76.vega(SPOT, g.K, g.r, g.T, g.v), null, [
  "F",
  "K",
  "r",
  "T",
  "v",
]);
emitIV(
  "black76",
  "black76",
  (F, K, r, T, v, kind) =>
    kind === "call" ? Black76.call(F, K, r, T, v) : Black76.put(F, K, r, T, v),
  (F, K, r, T, price, kind) =>
    Black76.impliedVol(F, K, r, T, price, kind === "call" ? "Call" : "Put"),
  ["F", "K", "r", "T", "market_price"],
);

// ── futures_specs ─────────────────────────────────────────────────────────

{
  // Cover the canonical root forms + a few negative cases. Expected output is
  // the *root string* — comparison happens as string equality in the harness.
  const symbols = [
    "/CLM26",
    "./CLM26",
    "CLM26",
    "ESH25",
    "/ESH25",
    "/NQU24",
    "/YMZ26",
    "/RTYH24",
    "/GCM25",
    "/SIK26",
    "/HGN24",
    "/NGU24",
    "/ZBZ24",
    "/ZNH25",
    "/ZCK25",
    "/ZSU24",
    "/ZWZ25",
    "/6EU24",
    "/MNQU24",
    "AAPL",
    "/ZB",
    "GC",
    "",
  ];
  const cases = symbols.map((s, i) => ({
    id: `futures_root_${i.toString().padStart(4, "0")}`,
    inputs: [s],
    expected: (() => {
      // Inline the JS futures_root logic for the fixture.
      const cleaned = s.replace(/^[./]+/, "");
      const m = cleaned.match(/^([A-Z0-9]{1,3})[FGHJKMNQUVXZ]\d{1,2}$/);
      return m ? m[1] : cleaned;
    })(),
    tolerance: 0,
  }));
  writeFixture("futures_root", "futures_specs::futures_root", ["symbol"], cases);
}
