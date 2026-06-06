//! `qf-optimizer` — `Magpie` LP/MIP optimizer crate.
//!
//! Replaces `javascript-lp-solver` (used by `src/lib/lp-optimizer.js`) for
//! both Greek Builder (browser via WASM, `QF-133`) and automated strategies
//! (Python via `PyO3`, `QF-134`). Per [`docs/polyglot-migration-tdd.md`] §B.2
//! Phase 5.
//!
//! [`docs/polyglot-migration-tdd.md`]: ../../../../docs/polyglot-migration-tdd.md
//!
//! # Portable model
//!
//! [`LpModel`] mirrors the dict-style shape `javascript-lp-solver` accepts
//! (objective name, op-type, named constraints with `{min, max}` bounds,
//! named variables with per-constraint coefficients, optional integer flag
//! per variable). That makes equivalence testing against the legacy JS
//! solver trivial: the same JSON describes both inputs.
//!
//! # Backends
//!
//! Selected at compile time from [`good_lp`]:
//!
//! - **`HiGHS`** (default, `python` feature) — vendored C++ via
//!   `good_lp/highs`. High-quality LP/MIP, but won't cross-compile to
//!   `wasm32`.
//! - **`microlp`** (`wasm` feature) — pure-Rust LP/MIP. Smaller
//!   heuristics than `HiGHS` for big MIPs but fine for the Greek
//!   Builder's continuous LPs, and it cross-compiles to `wasm32`.
//!
//! Same return shape regardless of backend.
//!
//! [`good_lp`]: https://docs.rs/good_lp
//! [HiGHS]: https://highs.dev
//!
//! # Example
//!
//! ```rust
//! use qf_optimizer::{Bound, LpModel, OpType, solve};
//! use std::collections::HashMap;
//!
//! // maximize 3x + 2y  s.t.  x + y <= 4,  x,y >= 0
//! let mut model = LpModel::new("obj", OpType::Max);
//! model.add_constraint("budget", Bound { min: None, max: Some(4.0) });
//! model.add_variable("x", HashMap::from([
//!     ("obj".to_string(), 3.0),
//!     ("budget".to_string(), 1.0),
//! ]));
//! model.add_variable("y", HashMap::from([
//!     ("obj".to_string(), 2.0),
//!     ("budget".to_string(), 1.0),
//! ]));
//!
//! let solution = solve(&model).unwrap();
//! assert!(solution.feasible);
//! assert!((solution.objective_value - 12.0).abs() < 1e-9);
//! ```

mod error;
mod model;
mod solve;

pub use error::LpError;
pub use model::{Bound, LpModel, LpSolution, OpType};
pub use solve::solve;

#[cfg(feature = "python")]
mod python;

#[cfg(feature = "wasm")]
mod wasm;
