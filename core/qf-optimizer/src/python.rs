//! `PyO3` bindings for `qf-optimizer`.
//!
//! Gated behind the `python` feature so pure-Rust consumers don't pull in
//! `CPython` linkage. Built with `maturin build --features python` into a
//! wheel that exposes a `qf_optimizer` Python module.
//!
//! # Surface
//!
//! A single function, `solve(model: dict) -> dict`. The input dict mirrors
//! the legacy `javascript-lp-solver` shape so Python callers can pass the
//! exact JSON they would have handed to the JS solver. The output is
//! a Python dict with three keys (`feasible`, `objective_value`,
//! `values`) — cleaner than the JS solver's flat-with-side-channel
//! return shape.
//!
//! The solve releases the GIL via [`Python::detach`] so other Python
//! threads run while `HiGHS` is at work. Big MIPs can take meaningful
//! wall time, so this matters.

use std::collections::HashMap;

use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyModule};

// `Bound` here would collide with pyo3's `Bound<'py, T>` smart pointer
// used pervasively below. Alias the model one to `LpBound`.
use crate::model::{Bound as LpBound, LpModel, OpType};
use crate::solve::solve as solve_lp;

/// Extract `model.optimize`, `model.opType`, `model.constraints`,
/// `model.variables`, and `model.ints` from a Python dict and build an
/// [`LpModel`]. Surfaces type errors at the field level so a typo in
/// the caller's dict points at the offending key.
fn extract_model(model_py: &Bound<'_, PyDict>) -> PyResult<LpModel> {
    let objective: String = required_field(model_py, "optimize")?.extract()?;

    let op_type_str: String = required_field(model_py, "opType")?.extract()?;
    let op_type = match op_type_str.as_str() {
        "max" => OpType::Max,
        "min" => OpType::Min,
        other => {
            return Err(PyValueError::new_err(format!(
                "opType must be 'max' or 'min', got {other:?}"
            )));
        }
    };

    let mut lp = LpModel::new(objective, op_type);

    if let Some(constraints_obj) = model_py.get_item("constraints")? {
        let constraints_dict = constraints_obj.cast_into::<PyDict>().map_err(|_| {
            PyTypeError::new_err("model['constraints'] must be a dict of {name: {min?, max?}}")
        })?;
        for (k, v) in constraints_dict.iter() {
            let name: String = k.extract()?;
            let bound_dict = v.cast_into::<PyDict>().map_err(|_| {
                PyTypeError::new_err(format!(
                    "constraints[{name:?}] must be a dict with optional 'min' and 'max' keys"
                ))
            })?;
            let min = bound_dict
                .get_item("min")?
                .map(|v| v.extract::<f64>())
                .transpose()?;
            let max = bound_dict
                .get_item("max")?
                .map(|v| v.extract::<f64>())
                .transpose()?;
            lp.add_constraint(name, LpBound { min, max });
        }
    }

    if let Some(variables_obj) = model_py.get_item("variables")? {
        let variables_dict = variables_obj.cast_into::<PyDict>().map_err(|_| {
            PyTypeError::new_err("model['variables'] must be a dict of {name: {row: coef}}")
        })?;
        for (k, v) in variables_dict.iter() {
            let name: String = k.extract()?;
            let coeffs: HashMap<String, f64> = v.extract().map_err(|_| {
                PyTypeError::new_err(format!(
                    "variables[{name:?}] must be a dict of {{row_name: float}}"
                ))
            })?;
            lp.add_variable(name, coeffs);
        }
    }

    // Accept both shapes for `ints`:
    //   - dict (legacy JS shape):  {"x": 1, "y": 1}
    //   - set / list / tuple:      {"x", "y"} or ["x", "y"]
    if let Some(ints_obj) = model_py.get_item("ints")? {
        if let Ok(ints_dict) = ints_obj.cast::<PyDict>() {
            for (k, _) in ints_dict.iter() {
                lp.mark_integer(k.extract::<String>()?);
            }
        } else if let Ok(ints_iter) = ints_obj.try_iter() {
            for item in ints_iter {
                lp.mark_integer(item?.extract::<String>()?);
            }
        } else {
            return Err(PyTypeError::new_err(
                "model['ints'] must be a dict, set, list, or tuple of variable names",
            ));
        }
    }

    Ok(lp)
}

/// Solve the LP / MIP described by `model` and return a dict with keys
/// `feasible` (`bool`), `objective_value` (`float`), `values` (`dict`).
///
/// `model` is a Python dict matching the `javascript-lp-solver` shape:
/// `{optimize, opType, constraints, variables, ints}`. See the module
/// docstring for the full grammar.
#[pyfunction]
#[pyo3(name = "solve")]
fn py_solve<'py>(py: Python<'py>, model: &Bound<'py, PyDict>) -> PyResult<Bound<'py, PyDict>> {
    let lp = extract_model(model)?;

    // Release the GIL during the solve. HiGHS can chew on a big MIP for
    // seconds; pinning the GIL would block every other Python thread.
    let solution = py
        .detach(|| solve_lp(&lp))
        .map_err(|e| PyValueError::new_err(e.to_string()))?;

    let out = PyDict::new(py);
    out.set_item("feasible", solution.feasible)?;
    out.set_item("objective_value", solution.objective_value)?;
    let values = PyDict::new(py);
    for (name, val) in solution.values {
        values.set_item(name, val)?;
    }
    out.set_item("values", values)?;
    Ok(out)
}

fn required_field<'py>(dict: &Bound<'py, PyDict>, key: &str) -> PyResult<Bound<'py, PyAny>> {
    dict.get_item(key)?
        .ok_or_else(|| PyValueError::new_err(format!("model is missing required field `{key}`")))
}

/// `PyO3` module entry. The name `qf_optimizer` must match `[lib].name`
/// in `Cargo.toml`, the wheel filename, and the Python `import` statement.
#[pymodule]
fn qf_optimizer(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(py_solve, m)?)?;
    Ok(())
}
