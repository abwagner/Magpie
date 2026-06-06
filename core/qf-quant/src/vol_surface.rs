//! Vol surface construction. **Phase 1.5 stub.**
//!
//! Today this module is empty: it exists so the crate's module tree
//! is in place for Phase 1.5 to fill in without scaffolding work
//! gating that phase (per
//! [`docs/polyglot-migration-plan.md`](../../../../docs/polyglot-migration-plan.md)
//! §B.2 Phase 1 #17).
//!
//! # Phase 1.5 TODO
//!
//! Port [`src/lib/vol-surface.js`](../../../../src/lib/vol-surface.js)
//! (213 lines) on top of [`spline`] and [`crate::bs`] / [`crate::black76`]:
//!
//! 1. `fn fit_smile(contracts, spot, rfr, dte, pricing_model)` — fit
//!    IVs to a single-expiry smile in delta-space using
//!    [`spline::natural_cubic_spline`].
//! 2. `struct VolSurface { spot, rfr, smiles: BTreeMap<Dte, Smile> }`
//!    — full term-structure surface.
//! 3. `impl VolSurface { fn implied_vol(&self, k, dte) -> f64; fn
//!    call_price(&self, k, dte) -> f64; fn put_price(&self, k, dte)
//!    -> f64 }` — strike-and-time queries.
//! 4. Flat-forward-variance interpolation between expiries (matches
//!    `vol-surface.js:124-` semantics).
//! 5. `fn build_vol_surface(chains_by_expiry, spot, rfr, opts)` —
//!    constructor from raw chain data.
//! 6. Phase 1.5 default pricing model: `cdf_correct`. Phase 1
//!    crate-mode wiring (via `cdf`) is for the equivalence-harness
//!    cutover.
//! 7. Bug-for-bug parity at 1e-9 (QF-98); fixture inputs sourced from
//!    the existing JS test suite (`src/lib/__tests__/vol-surface.test.js`).
