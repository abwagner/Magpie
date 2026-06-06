//! Translates [`LpModel`] into [`good_lp`]'s API and dispatches to the
//! configured backend (`HiGHS` on native, `microlp` on wasm32).

use std::collections::HashMap;

use good_lp::{
    variable, Expression, ProblemVariables, ResolutionError, Solution, SolverModel, Variable,
};

// Pick the backend at compile time. `wasm` feature forces `microlp` (the
// only one that cross-compiles to wasm32); everything else uses `highs`.
// The `highs` feature implies microlp is *not* enabled — if both ever land
// in the same build, this prefers HiGHS.
#[cfg(feature = "highs")]
use good_lp::highs as backend;
#[cfg(all(feature = "microlp", not(feature = "highs")))]
use good_lp::microlp as backend;

use crate::error::LpError;
use crate::model::{LpModel, LpSolution, OpType};

/// Solve the LP / MIP described by `model` using the active backend.
///
/// Backend selection is compile-time: `HiGHS` for native builds (default
/// and `PyO3`), `microlp` for the `wasm` feature. The returned shape is
/// identical across backends.
///
/// Errors when a variable references a constraint name that wasn't
/// declared. An infeasible or unbounded problem is **not** an error —
/// it's reported as `LpSolution { feasible: false, .. }`, matching the
/// legacy `javascript-lp-solver` return shape.
///
/// # Errors
///
/// Returns [`LpError::UnknownRow`] when a variable references a row name
/// that isn't the objective and isn't in `model.constraints`.
///
/// Returns [`LpError::SolverFailure`] when the backend reports a status
/// that isn't `optimal` / `infeasible` / `unbounded`.
pub fn solve(model: &LpModel) -> Result<LpSolution, LpError> {
    let mut model = model.clone();
    model.canonicalize();

    // Catch dangling row references up front so callers see a clear
    // error rather than a dimension mismatch out of the solver.
    for (var, coeffs) in &model.variables {
        for row in coeffs.keys() {
            if row != &model.objective && !model.constraints.contains_key(row) {
                return Err(LpError::UnknownRow {
                    var: var.clone(),
                    row: row.clone(),
                });
            }
        }
    }

    // Build good_lp's problem. Variable declaration order is arbitrary
    // since we key everything by name; HiGHS doesn't care.
    let mut problem = ProblemVariables::new();
    let mut var_map: HashMap<String, Variable> = HashMap::with_capacity(model.variables.len());
    for name in model.variables.keys() {
        let mut def = variable().min(0.0);
        if model.integers.contains(name) {
            def = def.integer();
        }
        var_map.insert(name.clone(), problem.add(def));
    }

    let objective = build_row_expression(&model, &var_map, &model.objective);

    let unsolved = match model.op_type {
        OpType::Max => problem.maximise(objective.clone()),
        OpType::Min => problem.minimise(objective.clone()),
    };
    let mut solver = unsolved.using(backend);

    for (con_name, bound) in &model.constraints {
        let row = build_row_expression(&model, &var_map, con_name);
        if let Some(max) = bound.max {
            solver = solver.with(row.clone().leq(max));
        }
        if let Some(min) = bound.min {
            solver = solver.with(row.geq(min));
        }
    }

    match solver.solve() {
        Ok(sol) => {
            let values: HashMap<String, f64> = var_map
                .iter()
                .map(|(name, var)| (name.clone(), sol.value(*var)))
                .collect();
            // Compute objective explicitly from the returned values so the
            // result is solver-agnostic across HiGHS / microlp.
            let objective_value = values
                .iter()
                .map(|(name, val)| model.coefficient(name, &model.objective) * val)
                .sum();
            Ok(LpSolution {
                feasible: true,
                objective_value,
                values,
            })
        }
        Err(ResolutionError::Infeasible | ResolutionError::Unbounded) => Ok(LpSolution {
            feasible: false,
            objective_value: 0.0,
            values: HashMap::new(),
        }),
        Err(e) => Err(LpError::SolverFailure(e.to_string())),
    }
}

fn build_row_expression(
    model: &LpModel,
    var_map: &HashMap<String, Variable>,
    row: &str,
) -> Expression {
    let mut expr = Expression::default();
    for (var_name, coeffs) in &model.variables {
        if let Some(&c) = coeffs.get(row) {
            if c != 0.0 {
                expr += c * var_map[var_name];
            }
        }
    }
    expr
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Bound;

    fn coef(pairs: &[(&str, f64)]) -> HashMap<String, f64> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    /// max 3x + 2y  s.t.  x + y <= 4,  x,y >= 0  → x=4, y=0, obj=12.
    #[test]
    fn maximize_continuous() {
        let mut m = LpModel::new("obj", OpType::Max);
        m.add_constraint(
            "budget",
            Bound {
                min: None,
                max: Some(4.0),
            },
        );
        m.add_variable("x", coef(&[("obj", 3.0), ("budget", 1.0)]));
        m.add_variable("y", coef(&[("obj", 2.0), ("budget", 1.0)]));

        let sol = solve(&m).unwrap();
        assert!(sol.feasible);
        assert!((sol.objective_value - 12.0).abs() < 1e-6);
        assert!((sol.values["x"] - 4.0).abs() < 1e-6);
        assert!(sol.values["y"].abs() < 1e-6);
    }

    /// min x + y  s.t.  x + y >= 5  → obj=5.
    #[test]
    fn minimize_continuous() {
        let mut m = LpModel::new("obj", OpType::Min);
        m.add_constraint(
            "floor",
            Bound {
                min: Some(5.0),
                max: None,
            },
        );
        m.add_variable("x", coef(&[("obj", 1.0), ("floor", 1.0)]));
        m.add_variable("y", coef(&[("obj", 1.0), ("floor", 1.0)]));

        let sol = solve(&m).unwrap();
        assert!(sol.feasible);
        assert!((sol.objective_value - 5.0).abs() < 1e-6);
    }

    /// max x  s.t.  x <= 3.7, x integer  → x=3, obj=3.
    #[test]
    fn integer_constraint_rounds_down() {
        let mut m = LpModel::new("obj", OpType::Max);
        m.add_constraint(
            "ceil",
            Bound {
                min: None,
                max: Some(3.7),
            },
        );
        m.add_variable("x", coef(&[("obj", 1.0), ("ceil", 1.0)]));
        m.mark_integer("x");

        let sol = solve(&m).unwrap();
        assert!(sol.feasible);
        assert!((sol.values["x"] - 3.0).abs() < 1e-6);
        assert!((sol.objective_value - 3.0).abs() < 1e-6);
    }

    /// Two-sided constraint:  min: 1, max: 4  → forces the row into a band.
    #[test]
    fn two_sided_constraint() {
        let mut m = LpModel::new("obj", OpType::Max);
        m.add_constraint(
            "band",
            Bound {
                min: Some(1.0),
                max: Some(4.0),
            },
        );
        // Maximize x with x in [1, 4].
        m.add_variable("x", coef(&[("obj", 1.0), ("band", 1.0)]));
        let sol = solve(&m).unwrap();
        assert!(sol.feasible);
        assert!((sol.values["x"] - 4.0).abs() < 1e-6);
    }

    /// Infeasible: x >= 5 AND x <= 2.
    #[test]
    fn infeasible_returns_feasible_false() {
        let mut m = LpModel::new("obj", OpType::Max);
        m.add_constraint(
            "lo",
            Bound {
                min: Some(5.0),
                max: None,
            },
        );
        m.add_constraint(
            "hi",
            Bound {
                min: None,
                max: Some(2.0),
            },
        );
        m.add_variable("x", coef(&[("obj", 1.0), ("lo", 1.0), ("hi", 1.0)]));

        let sol = solve(&m).unwrap();
        assert!(!sol.feasible);
        assert!(sol.objective_value.abs() < f64::EPSILON);
    }

    /// Dangling row reference: variable cites a row that isn't declared.
    #[test]
    fn unknown_row_errors() {
        let mut m = LpModel::new("obj", OpType::Max);
        m.add_variable("x", coef(&[("obj", 1.0), ("typo", 1.0)]));

        let err = solve(&m).unwrap_err();
        match err {
            LpError::UnknownRow { var, row } => {
                assert_eq!(var, "x");
                assert_eq!(row, "typo");
            }
            LpError::SolverFailure(_) => panic!("unexpected solver-failure error"),
        }
    }
}
