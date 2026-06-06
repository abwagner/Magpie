//! Errors surfaced by [`crate::solve`].

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LpError {
    /// The constraint named in a variable's coefficient row is not declared
    /// in `model.constraints` (and is not the objective row). Catching this
    /// upfront beats letting the solver emit a confusing dimensionality
    /// error.
    #[error("variable `{var}` references undeclared row `{row}`")]
    UnknownRow { var: String, row: String },

    /// `HiGHS` reported a status the model can't interpret as
    /// optimal / infeasible / unbounded. Treated as a hard error rather
    /// than a soft `feasible: false` to surface solver-level bugs.
    #[error("solver returned unexpected status: {0}")]
    SolverFailure(String),
}
