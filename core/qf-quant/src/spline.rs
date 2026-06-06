//! Spline interpolation. **Phase 1.5 stub.**
//!
//! Today this module is empty: it exists so the crate's module tree
//! is in place for Phase 1.5 to fill in without scaffolding work
//! gating that phase (per
//! [`docs/polyglot-migration-plan.md`](../../../../docs/polyglot-migration-plan.md)
//! §B.2 Phase 1 #17).
//!
//! # Phase 1.5 TODO
//!
//! Port `cubicSpline` from
//! [`src/lib/vol-surface.js`](../../../../src/lib/vol-surface.js#L6-L66)
//! into a dedicated `spline` module:
//!
//! 1. `fn natural_cubic_spline(xs: &[f64], ys: &[f64]) -> impl Fn(f64) -> f64`
//!    — natural cubic spline through `(x, y)` points with C² continuity.
//! 2. Edge cases the JS handles: `n < 2` returns a constant; `n == 2`
//!    returns a linear interpolant.
//! 3. Clamp-to-range on out-of-bounds queries — match the JS behavior
//!    used by [`vol_surface`].
//! 4. Bug-for-bug parity with the JS at 1e-9 (the equivalence harness
//!    in QF-98 will cover this).
//! 5. Property tests with `proptest` for C² continuity at the knots and
//!    monotone-preserving behavior on monotone inputs.
