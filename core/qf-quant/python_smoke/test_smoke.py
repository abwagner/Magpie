"""Smoke test for the qf-quant Python wheel.

Verifies the Python-side calls return the same f64 values as the Rust unit
tests asserted (which were themselves anchored against JS). If this test
passes, the PyO3 wrapper is wired correctly end-to-end.

Run after `maturin develop --release --features python` (from
`core/qf-quant/`):

    python -m pytest python_smoke/test_smoke.py -v
"""

from __future__ import annotations

import math

import qf_quant


TOL = 1e-9
# Post-Phase-1.5 cutover: BS / Black-76 compare against scipy-anchored
# textbook values within the A&S 7.1.26 vs scipy-erf gap (~1e-5 for our
# grid). See bs.rs SCIPY_PARITY_TOL.
BS_TOL = 5e-5


def assert_close(got: float, want: float, label: str, tol: float = TOL) -> None:
    diff = abs(got - want)
    assert diff < tol, f"{label}: got={got}, want={want}, |diff|={diff}"


def test_normal_cdf_correct_textbook() -> None:
    cases = [
        (-1.0, 0.158_655_253_931_457_05),
        (0.0, 0.5),
        (1.0, 0.841_344_746_068_543),
        (1.96, 0.975_002_104_851_779_5),
    ]
    for x, want in cases:
        # Larger tolerance: A&S 7.1.26 max error ~7.5e-8.
        got = qf_quant.cdf_correct(x)
        assert abs(got - want) < 1e-7, f"cdf_correct({x}): got={got}, want={want}"


def test_normal_pdf() -> None:
    # phi(0) = 1/sqrt(2*pi)
    assert_close(qf_quant.pdf(0.0), 1.0 / math.sqrt(2 * math.pi), "pdf(0)")
    # Symmetry
    assert_close(qf_quant.pdf(-1.5), qf_quant.pdf(1.5), "pdf(-1.5) == pdf(1.5)")


def test_bs_atm_call_put() -> None:
    # Textbook reference (scipy.stats.norm.cdf), same fixture row as the
    # Rust unit tests post-Phase-1.5 cutover.
    s, k, r, t, v = 100.0, 100.0, 0.05, 0.25, 0.20
    assert_close(
        qf_quant.bs_call(s, k, r, t, v),
        4.614_997_129_602_855,
        "bs_call ATM 3mo",
        BS_TOL,
    )
    assert_close(
        qf_quant.bs_put(s, k, r, t, v), 3.372_777_178_991_008, "bs_put ATM 3mo", BS_TOL
    )
    assert_close(
        qf_quant.bs_delta(s, k, r, t, v, "call"),
        0.569_460_183_207_673_7,
        "bs_delta call",
        BS_TOL,
    )
    assert_close(
        qf_quant.bs_gamma(s, k, r, t, v),
        0.039_288_000_944_737_93,
        "bs_gamma",
        BS_TOL,
    )
    assert_close(
        qf_quant.bs_vega(s, k, r, t, v), 0.196_440_004_723_689_67, "bs_vega", BS_TOL
    )


def test_bs_implied_vol_round_trip() -> None:
    s, k, r, t, v_true = 100.0, 100.0, 0.05, 0.25, 0.20
    px = qf_quant.bs_call(s, k, r, t, v_true)
    v_solved = qf_quant.bs_implied_vol(s, k, r, t, px, "call")
    assert v_solved is not None
    assert abs(v_solved - v_true) < 1e-5


def test_bs_implied_vol_outside_bracket_returns_none() -> None:
    # Price below intrinsic -> solver gives up -> Python None.
    assert qf_quant.bs_implied_vol(110.0, 100.0, 0.05, 0.25, 0.5, "call") is None


def test_black76_parity() -> None:
    # Textbook reference (scipy), same fixture row as the Rust black76
    # tests post-cutover.
    f, k, r, t, v = 100.0, 100.0, 0.05, 0.25, 0.20
    assert_close(
        qf_quant.black76_call(f, k, r, t, v),
        3.938_224_402_866_887,
        "black76_call ATM 3mo",
        BS_TOL,
    )
    # Symmetric ATM, zero forward bias -> call and put equal.
    call = qf_quant.black76_call(f, k, r, t, v)
    put = qf_quant.black76_put(f, k, r, t, v)
    assert abs(call - put) < TOL


def test_kind_string_validation() -> None:
    import pytest

    with pytest.raises(ValueError):
        qf_quant.bs_delta(100.0, 100.0, 0.05, 0.25, 0.20, "long")


def test_futures_root_and_spec() -> None:
    assert qf_quant.futures_root("/CLM26") == "CL"
    assert qf_quant.futures_root("./CLM26") == "CL"
    assert qf_quant.futures_root("AAPL") == "AAPL"
    assert qf_quant.is_futures_symbol("/CLM26") is True
    assert qf_quant.is_futures_symbol("AAPL") is False

    spec = qf_quant.get_futures_spec("/CLM26")
    assert spec is not None
    root, name, multiplier, tick_size, tick_value, unit, exchange = spec
    assert root == "CL"
    assert name == "Crude Oil"
    assert multiplier == 1000.0
    assert tick_size == 0.01
    assert tick_value == 10.0
    assert unit == "bbl"
    assert exchange == "NYMEX"

    # /MNQU24 parses as a futures symbol but has no spec entry.
    assert qf_quant.get_futures_spec("/MNQU24") is None
    assert qf_quant.get_futures_spec("AAPL") is None


def test_bs_price_chain_matches_per_strike_calls() -> None:
    spot = 100.0
    r, t, v = 0.05, 0.25, 0.20
    strikes = [80.0, 90.0, 100.0, 110.0, 120.0]
    calls, puts = qf_quant.bs_price_chain(spot, strikes, r, t, v)
    assert len(calls) == len(strikes)
    assert len(puts) == len(strikes)
    for k, c, p in zip(strikes, calls, puts):
        assert_close(c, qf_quant.bs_call(spot, k, r, t, v), f"chain call K={k}")
        assert_close(p, qf_quant.bs_put(spot, k, r, t, v), f"chain put K={k}")
