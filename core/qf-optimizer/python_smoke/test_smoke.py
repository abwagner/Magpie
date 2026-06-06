"""Smoke test for the qf-optimizer Python wheel.

Verifies the Python-side `solve(model)` returns the same f64 values as
the Rust unit tests / equivalence harness assert. If this passes, the
PyO3 wrapper is wired correctly end-to-end.

Run after `maturin develop --release --features python` (from
`core/qf-optimizer/`):

    python -m pytest python_smoke/test_smoke.py -v
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import qf_optimizer

# Same tolerances as the Rust equivalence harness in
# tests/equivalence.rs. Objective is the well-defined invariant for
# degenerate LPs; constraints must hold within HiGHS's optimality tol.
OBJ_TOL = 1e-4
CONSTRAINT_TOL = 1e-6

FIXTURE_DIR = Path(__file__).parent.parent / "tests" / "fixtures" / "equivalence_v1"


def _check_constraints(model: dict, values: dict[str, float]) -> None:
    """Recompute each constraint row from `values` and assert it sits
    within the declared bounds (within tolerance). Same invariant the
    Rust harness checks — keeps the smoke test honest if degeneracy
    routes HiGHS through a different vertex than the JS solver."""
    for con_name, bound in model.get("constraints", {}).items():
        row = sum(
            coeffs.get(con_name, 0.0) * values.get(var, 0.0)
            for var, coeffs in model["variables"].items()
        )
        if "max" in bound:
            assert row <= bound["max"] + CONSTRAINT_TOL, (
                f"constraint {con_name!r} upper bound violated: row={row}, max={bound['max']}"
            )
        if "min" in bound:
            assert row >= bound["min"] - CONSTRAINT_TOL, (
                f"constraint {con_name!r} lower bound violated: row={row}, min={bound['min']}"
            )


def test_module_exposes_solve() -> None:
    assert hasattr(qf_optimizer, "solve")
    assert callable(qf_optimizer.solve)


def test_trivial_max() -> None:
    # max 3x + 2y  s.t.  x + y <= 4  →  obj = 12 (x=4, y=0)
    model = {
        "optimize": "obj",
        "opType": "max",
        "constraints": {"budget": {"max": 4}},
        "variables": {
            "x": {"obj": 3, "budget": 1},
            "y": {"obj": 2, "budget": 1},
        },
        "ints": {},
    }
    sol = qf_optimizer.solve(model)
    assert sol["feasible"] is True
    assert abs(sol["objective_value"] - 12.0) < OBJ_TOL


def test_infeasible_returns_feasible_false() -> None:
    model = {
        "optimize": "obj",
        "opType": "max",
        "constraints": {"lo": {"min": 5}, "hi": {"max": 2}},
        "variables": {"x": {"obj": 1, "lo": 1, "hi": 1}},
        "ints": {},
    }
    sol = qf_optimizer.solve(model)
    assert sol["feasible"] is False
    # objective_value is 0 when infeasible; explicit per the contract.
    assert sol["objective_value"] == 0.0
    assert sol["values"] == {}


def test_integer_constraint_rounds_down() -> None:
    # max x s.t. x <= 3.7, x integer → x=3
    model = {
        "optimize": "obj",
        "opType": "max",
        "constraints": {"ceil": {"max": 3.7}},
        "variables": {"x": {"obj": 1, "ceil": 1}},
        "ints": {"x": 1},
    }
    sol = qf_optimizer.solve(model)
    assert sol["feasible"] is True
    assert abs(sol["values"]["x"] - 3.0) < 1e-6


def test_ints_accepts_set() -> None:
    # Pythonic shape: ints as a set of names, not a {name: 1} dict.
    model = {
        "optimize": "obj",
        "opType": "max",
        "constraints": {"ceil": {"max": 3.7}},
        "variables": {"x": {"obj": 1, "ceil": 1}},
        "ints": {"x"},
    }
    sol = qf_optimizer.solve(model)
    assert sol["feasible"] is True
    assert abs(sol["values"]["x"] - 3.0) < 1e-6


def test_ints_accepts_list() -> None:
    model = {
        "optimize": "obj",
        "opType": "max",
        "constraints": {"ceil": {"max": 3.7}},
        "variables": {"x": {"obj": 1, "ceil": 1}},
        "ints": ["x"],
    }
    sol = qf_optimizer.solve(model)
    assert sol["feasible"] is True
    assert abs(sol["values"]["x"] - 3.0) < 1e-6


def test_bad_op_type_raises() -> None:
    with pytest.raises(ValueError, match="opType"):
        qf_optimizer.solve(
            {
                "optimize": "obj",
                "opType": "maximise",  # typo — must be "max" or "min"
                "constraints": {},
                "variables": {"x": {"obj": 1}},
            }
        )


def test_missing_required_field_raises() -> None:
    with pytest.raises(ValueError, match="optimize"):
        qf_optimizer.solve(
            {
                "opType": "max",
                "constraints": {},
                "variables": {"x": {"obj": 1}},
            }
        )


@pytest.mark.parametrize(
    "fixture_name",
    [
        "max_single_budget",
        "min_floor",
        "portfolio_continuous",
        "portfolio_integer",
        "greek_builder_flat_delta",
        "infeasible",
        "two_sided_band",
    ],
)
def test_equivalence_with_js_solver(fixture_name: str) -> None:
    """Cross-check the Python wheel against the same JSON fixtures the
    Rust equivalence harness uses. Confirms the PyO3 wrapper is the
    same solve, not a different code path."""
    fixture = json.loads((FIXTURE_DIR / f"{fixture_name}.json").read_text())
    model = fixture["model"]
    expected = fixture["expected"]

    sol = qf_optimizer.solve(model)

    assert sol["feasible"] == expected["feasible"], (
        f"{fixture_name}: feasibility mismatch"
    )
    if not expected["feasible"]:
        return

    obj_diff = abs(sol["objective_value"] - expected["objectiveValue"])
    assert obj_diff < OBJ_TOL, (
        f"{fixture_name}: objective mismatch "
        f"(expected {expected['objectiveValue']}, got {sol['objective_value']}, "
        f"diff {obj_diff})"
    )

    # Constraint satisfaction (rather than per-variable equality) —
    # same reasoning as the Rust harness: degenerate LPs reach the same
    # objective at different vertices.
    _check_constraints(model, sol["values"])

    # Non-negativity (LpModel's implicit x >= 0).
    for var, val in sol["values"].items():
        assert val >= -CONSTRAINT_TOL, f"{var}: violates x>=0 (got {val})"
