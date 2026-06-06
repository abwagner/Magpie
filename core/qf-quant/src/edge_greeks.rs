//! Edge-to-Greeks mapping for the LP Greek Builder. **Phase 1.5 stub.**
//!
//! Today this module is empty: it exists so the crate's module tree
//! is in place for Phase 1.5 to fill in without scaffolding work
//! gating that phase (per
//! [`docs/polyglot-migration-plan.md`](../../../../docs/polyglot-migration-plan.md)
//! §B.2 Phase 1 #17).
//!
//! # Phase 1.5 TODO
//!
//! Port [`src/lib/edge-greeks.js`](../../../../src/lib/edge-greeks.js)
//! (112 lines):
//!
//! 1. `fn edge_to_greeks(edge_data, spot, rfr) -> EdgeGreeks` — turn
//!    a per-strike density edge (from
//!    [`crate::probability::compute_edge`]) into expected
//!    deltas/gammas/thetas/vegas under the LP-aligned discretization.
//! 2. `struct EdgeGreeks { delta, gamma, theta, vega }` — payoff
//!    summary the Greek Builder LP optimizes against.
//! 3. `fn multi_expiry_edge_greeks(edge_data_array, spot, rfr) ->
//!    Vec<EdgeGreeks>` — same shape across the term structure.
//! 4. Default pricing model: [`crate::bs`] (`cdf_correct` after
//!    Phase 1.5 cutover). The LP doesn't care about Black-76 since
//!    the Greek Builder is equity-only today; revisit if futures
//!    Greek-budgeting becomes a thing.
//! 5. Bug-for-bug parity at 1e-9 (QF-98) for `edge_to_greeks` on a
//!    fixed-fixture edge density.
//! 6. The LP optimizer that consumes these Greeks lives in
//!    [`src/lib/lp-optimizer.js`](../../../../src/lib/lp-optimizer.js) and
//!    will move to a separate `qf-optimizer` crate per
//!    [`docs/polyglot-migration-plan.md`](../../../../docs/polyglot-migration-plan.md)
//!    Phase 5 — out of scope for `qf-quant`.
