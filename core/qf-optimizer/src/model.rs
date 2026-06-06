//! Portable LP/MIP model. Mirrors the dict-style shape that
//! `javascript-lp-solver` accepts so the same JSON describes both
//! the legacy JS path and this crate's inputs.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Maximize or minimize the objective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpType {
    Max,
    Min,
}

/// A constraint's bounds. Either or both sides may be present.
/// At least one of `min` / `max` must be `Some` for a constraint to bind.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Bound {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

/// An LP / MIP problem in the `javascript-lp-solver` style.
///
/// Variables have an implicit non-negative lower bound (`x >= 0`), matching
/// `javascript-lp-solver`'s default. Coefficients map per-variable into
/// either the objective or a named constraint:
///
/// - `variables[var_name][objective] = c_i` — objective coefficient.
/// - `variables[var_name][constraint_name] = a_ij` — row coefficient.
/// - Names absent from a variable's coefficient map are treated as zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LpModel {
    /// Name of the row that serves as the objective.
    #[serde(rename = "optimize")]
    pub objective: String,

    #[serde(rename = "opType")]
    pub op_type: OpType,

    /// Named constraint rows. Empty map = unconstrained.
    #[serde(default)]
    pub constraints: HashMap<String, Bound>,

    /// Per-variable coefficient maps. Missing entries default to zero.
    #[serde(default)]
    pub variables: HashMap<String, HashMap<String, f64>>,

    /// Variables marked integer.
    ///
    /// The legacy JS solver stores this as `{ varName: 1 }`; we model it
    /// as a set since the value is just a flag. Both `LpModel::from_js`
    /// and the serde derive accept the map shape via [`Self::from_js`].
    #[serde(skip)]
    pub integers: HashSet<String>,

    /// Mirror of the JS `ints` field for JSON round-tripping. Populated
    /// by deserialization; [`Self::canonicalize`] folds it into
    /// [`Self::integers`] before [`solve`] inspects the model.
    ///
    /// [`solve`]: crate::solve
    #[serde(default, rename = "ints", skip_serializing_if = "HashMap::is_empty")]
    ints_json: HashMap<String, u8>,
}

impl LpModel {
    /// Create an empty model with the given objective name and direction.
    #[must_use]
    pub fn new(objective: impl Into<String>, op_type: OpType) -> Self {
        Self {
            objective: objective.into(),
            op_type,
            constraints: HashMap::new(),
            variables: HashMap::new(),
            integers: HashSet::new(),
            ints_json: HashMap::new(),
        }
    }

    /// Declare a named constraint with the given bounds.
    pub fn add_constraint(&mut self, name: impl Into<String>, bound: Bound) {
        self.constraints.insert(name.into(), bound);
    }

    /// Declare a variable and its coefficient row.
    pub fn add_variable(&mut self, name: impl Into<String>, coefficients: HashMap<String, f64>) {
        self.variables.insert(name.into(), coefficients);
    }

    /// Mark a variable as integer.
    pub fn mark_integer(&mut self, name: impl Into<String>) {
        self.integers.insert(name.into());
    }

    /// Fold the `ints_json` field (populated by `serde`) into the canonical
    /// `integers` set. Called automatically by [`solve`]; users building a
    /// model programmatically don't need to invoke it.
    ///
    /// [`solve`]: crate::solve
    pub(crate) fn canonicalize(&mut self) {
        for (var, flag) in self.ints_json.drain() {
            if flag != 0 {
                self.integers.insert(var);
            }
        }
    }

    /// Coefficient `a_ij` for a variable in a row (objective or constraint).
    /// Returns 0.0 when the variable doesn't list the row.
    pub(crate) fn coefficient(&self, var: &str, row: &str) -> f64 {
        self.variables
            .get(var)
            .and_then(|coeffs| coeffs.get(row))
            .copied()
            .unwrap_or(0.0)
    }
}

/// Result of solving an [`LpModel`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LpSolution {
    /// Whether the solver returned a feasible (optimal or near-optimal) solution.
    pub feasible: bool,

    /// Objective value at the returned point. `0.0` when infeasible.
    #[serde(rename = "objectiveValue")]
    pub objective_value: f64,

    /// Value assigned to each variable. Variables absent from this map
    /// were left at their default lower bound (`0.0`).
    pub values: HashMap<String, f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coefficient_defaults_to_zero() {
        let m = LpModel::new("obj", OpType::Max);
        assert!(m.coefficient("x", "obj").abs() < f64::EPSILON);
    }

    #[test]
    fn ints_json_round_trips_through_canonicalize() {
        let json = r#"{
            "optimize": "obj",
            "opType": "max",
            "constraints": {},
            "variables": {"x": {"obj": 1.0}},
            "ints": {"x": 1}
        }"#;
        let mut model: LpModel = serde_json::from_str(json).unwrap();
        assert!(model.integers.is_empty()); // populated only after canonicalize
        model.canonicalize();
        assert!(model.integers.contains("x"));
    }

    #[test]
    fn op_type_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&OpType::Max).unwrap(), "\"max\"");
        assert_eq!(serde_json::to_string(&OpType::Min).unwrap(), "\"min\"");
    }
}
