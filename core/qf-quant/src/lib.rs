//! `qf-quant` — `Magpie` math hot-path crate.
//!
//! Pure-Rust port of `src/lib/{bs,sabr,vol-surface,probability,edge-greeks,
//! futures-specs}.js` per [`docs/polyglot-migration-tdd.md`] §8.1.1. `PyO3`
//! wrappers ship behind the `python` Cargo feature; pure-Rust consumers
//! don't pull in `CPython` linkage.
//!
//! [`docs/polyglot-migration-tdd.md`]: ../../../../docs/polyglot-migration-tdd.md
//!
//! # Bug-for-bug equivalence
//!
//! Phase 1's contract is that this crate matches the JS reference within
//! 1e-9 absolute tolerance, **including the half-substituted CDF bug**
//! described in [`docs/polyglot-migration-tdd.md`] §8.1.1.1. The
//! [`normal::cdf`] function preserves that bug; the corrected version
//! lives at [`normal::cdf_correct`] and becomes the default in Phase 1.5.
//!
//! # Modules
//!
//! - [`normal`] — standard normal CDF (`cdf` bug-for-bug, `cdf_correct`
//!   real A&S 7.1.26) and PDF. Anchors every BS / Black-76 / IV result.
//! - [`iv`] — implied-volatility bisection solver. Shared between `bs`
//!   and `black76`.
//! - [`bs`] — Black-Scholes for equity options (price, Greeks, IV).
//! - [`black76`] — Black-76 for options on futures (price, Greeks, IV).
//! - [`probability`] — Breeden-Litzenberger PDF extraction, log-normal
//!   reference PDF, PDF blending, model-vs-market edge.
//! - [`futures_specs`] — multiplier / tick size / exchange metadata for
//!   common futures contracts, plus root-symbol parsing.
//!
//! # Phase 1.5 stubs
//!
//! Empty modules whose contents land in Phase 1.5; today they exist so
//! the crate's module tree is in place and downstream code can already
//! name the eventual paths:
//!
//! - [`spline`] — natural cubic spline interpolation. Extracted from
//!   `vol-surface.js` for reuse by `vol_surface`.
//! - [`sabr`] — SABR implied-vol formula and Nelder-Mead calibrator.
//! - [`vol_surface`] — full vol surface construction with smile fit
//!   and flat-forward-variance term-structure interpolation.
//! - [`edge_greeks`] — edge-density to Greeks mapping that the LP
//!   Greek Builder optimizes against.
//!
//! No Phase 1 follow-ups remain — every module named in §8.1.1 has a Rust
//! port. The `python` feature flag exposes the `PyO3`-wrapped surface
//! (`pip install qf-quant`).

pub mod black76;
pub mod bs;
pub mod edge_greeks;
pub mod futures_specs;
pub mod iv;
pub mod normal;
pub mod probability;
pub mod sabr;
pub mod spline;
pub mod vol_surface;

#[cfg(feature = "python")]
mod python;
