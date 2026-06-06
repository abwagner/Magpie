//! Equivalence harness: load each fixture in
//! `tests/fixtures/equivalence_v1/`, solve via `qf-optimizer`, and assert
//! the result matches the JS-recorded baseline.
//!
//! Fixtures are produced by `gen.mjs` (re-run only when the corpus
//! changes). Each file is `{ model, expected }` where `expected` is the
//! `javascript-lp-solver` output normalized to the [`LpSolution`] shape.

use std::fs;
use std::path::{Path, PathBuf};

use qf_optimizer::{solve, LpModel, LpSolution};
use serde::Deserialize;

// LP solutions are not unique in general — multiple variable assignments
// can yield the same objective. The legacy JS solver uses a Simplex
// (BLAND's rule) while HiGHS uses dual Simplex with parallel-mode
// heuristics; degenerate LPs (and the Greek Builder is genuinely
// degenerate — many candidates contribute identical objective per unit
// of margin) can land on different vertices on different CPUs.
//
// The well-defined invariants are:
//   1. Feasibility flag matches.
//   2. Objective value matches the JS reference within OBJ_TOL.
//   3. The returned point satisfies every declared constraint within
//      CONSTRAINT_TOL.
//   4. Variables are non-negative (LpModel's implicit lower bound).
// Per-variable equality with the JS vertex is *not* an invariant and
// was removed after CI revealed a different vertex on the linux runner
// vs. local for the Greek-Builder fixture (same objective, different x).
const OBJ_TOL: f64 = 1e-4;
const CONSTRAINT_TOL: f64 = 1e-6;

#[derive(Debug, Deserialize)]
struct Fixture {
    model: LpModel,
    expected: LpSolution,
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/equivalence_v1")
}

fn load(name: &str) -> Fixture {
    let path = fixture_dir().join(format!("{name}.json"));
    let body = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
    serde_json::from_str(&body).unwrap_or_else(|e| panic!("parse fixture {}: {e}", path.display()))
}

fn assert_matches(name: &str, model: &LpModel, expected: &LpSolution, got: &LpSolution) {
    assert_eq!(
        got.feasible, expected.feasible,
        "{name}: feasibility mismatch (expected {}, got {})",
        expected.feasible, got.feasible,
    );

    if !expected.feasible {
        return;
    }

    let obj_diff = (got.objective_value - expected.objective_value).abs();
    assert!(
        obj_diff < OBJ_TOL,
        "{name}: objective mismatch (expected {}, got {}, diff {})",
        expected.objective_value,
        got.objective_value,
        obj_diff,
    );

    // Non-negativity (LpModel's implicit x >= 0).
    for (var, &val) in &got.values {
        assert!(
            val >= -CONSTRAINT_TOL,
            "{name}: var `{var}` violates x>=0 (got {val})"
        );
    }

    // Constraint satisfaction: recompute each row from the returned values
    // and check it sits within the declared bounds.
    for (con_name, bound) in &model.constraints {
        let row_val: f64 = model
            .variables
            .iter()
            .map(|(var, coeffs)| {
                let coef = coeffs.get(con_name).copied().unwrap_or(0.0);
                let val = got.values.get(var).copied().unwrap_or(0.0);
                coef * val
            })
            .sum();
        if let Some(max) = bound.max {
            assert!(
                row_val <= max + CONSTRAINT_TOL,
                "{name}: constraint `{con_name}` upper bound violated (row={row_val}, max={max})"
            );
        }
        if let Some(min) = bound.min {
            assert!(
                row_val >= min - CONSTRAINT_TOL,
                "{name}: constraint `{con_name}` lower bound violated (row={row_val}, min={min})"
            );
        }
    }
}

fn check(name: &str) {
    let fx = load(name);
    let got = solve(&fx.model).unwrap_or_else(|e| panic!("{name}: solver error: {e}"));
    assert_matches(name, &fx.model, &fx.expected, &got);
}

#[test]
fn max_single_budget() {
    check("max_single_budget");
}

#[test]
fn min_floor() {
    check("min_floor");
}

#[test]
fn portfolio_continuous() {
    check("portfolio_continuous");
}

#[test]
fn portfolio_integer() {
    check("portfolio_integer");
}

#[test]
fn greek_builder_flat_delta() {
    check("greek_builder_flat_delta");
}

#[test]
fn infeasible_case() {
    check("infeasible");
}

#[test]
fn two_sided_band() {
    check("two_sided_band");
}
