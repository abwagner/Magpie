//! `wasm-bindgen` wrapper for `qf-optimizer`.
//!
//! Gated behind the `wasm` feature; built into a browser-compatible
//! WASM module by:
//!
//! ```text
//! wasm-pack build core/qf-optimizer \
//!   --target web \
//!   --out-dir ../../src/lib/wasm/qf_optimizer \
//!   --no-default-features --features wasm
//! ```
//!
//! The produced `qf_optimizer.js` + `qf_optimizer_bg.wasm` pair is
//! imported by the Greek Builder Web Worker (`src/lib/greek-builder-worker.ts`).
//! Vite handles WASM loading transparently when imported from a Web Worker.

use wasm_bindgen::prelude::*;

use crate::model::LpModel;
use crate::solve::solve as solve_lp;

/// Install a panic hook that routes Rust panics to `console.error` rather
/// than letting them silently abort the WASM instance. Call once from JS
/// after `init()`. Cheap — installs a single handler.
#[wasm_bindgen(js_name = "installPanicHook")]
pub fn install_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Solve the LP / MIP described by `model`.
///
/// `model` is a JS object matching the `javascript-lp-solver` shape
/// (`{optimize, opType, constraints, variables, ints}`) — the same shape
/// the legacy `src/lib/lp-optimizer.js` already constructs. Result is a JS
/// object with `{feasible, objective_value, values}` (camelCase
/// `objectiveValue` is rendered as `snake_case` `objective_value` to match
/// the Python wrapper).
///
/// # Errors
///
/// Returns a JS `Error` when the model has a malformed shape (caught by
/// serde) or when a variable references an undeclared constraint row.
/// Infeasible / unbounded is **not** an error — the returned object has
/// `feasible: false`.
#[wasm_bindgen]
pub fn solve(model: JsValue) -> Result<JsValue, JsValue> {
    let lp: LpModel = serde_wasm_bindgen::from_value(model)
        .map_err(|e| JsValue::from_str(&format!("invalid model: {e}")))?;
    let solution = solve_lp(&lp).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&solution)
        .map_err(|e| JsValue::from_str(&format!("failed to serialize solution: {e}")))
}
