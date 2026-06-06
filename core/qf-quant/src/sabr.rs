//! SABR stochastic-volatility model. **Phase 1.5 stub.**
//!
//! Today this module is empty: it exists so the crate's module tree
//! is in place for Phase 1.5 to fill in without scaffolding work
//! gating that phase (per
//! [`docs/polyglot-migration-plan.md`](../../../../docs/polyglot-migration-plan.md)
//! §B.2 Phase 1 #17).
//!
//! # Phase 1.5 TODO
//!
//! Port [`src/lib/sabr.js`](../../../../src/lib/sabr.js) (196 lines):
//!
//! 1. `fn sabr_implied_vol(f, k, t, alpha, beta, rho, nu) -> f64` —
//!    Hagan et al. 2002 SABR Black-vol approximation.
//! 2. `struct CalibratedSabr { alpha, beta, rho, nu }` and
//!    `fn calibrate_sabr(market_strikes, market_ivs, forward, t, opts)
//!    -> CalibratedSabr` — fit α, ρ, ν to market IVs at fixed β.
//! 3. Nelder-Mead solver used by the calibrator (currently inlined in
//!    `sabr.js:100-`); decide whether to extract into a generic
//!    optimizer module or keep it private to `sabr`.
//! 4. Bug-for-bug parity at 1e-9 (QF-98 equivalence harness covers
//!    `sabr_implied_vol` — the calibrator is RNG-sensitive and may
//!    need a fixed-seed variant for the harness).
//! 5. Property tests: ATM IV ≈ α when β = 1, ν = 0, ρ = 0; smile
//!    monotonicity in ρ; non-negative IV everywhere.
