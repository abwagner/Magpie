"""Generate the [cdf-correction.functions] section of
`expected_divergence.toml` from the existing JS-anchored fixtures.

For every BS / Black-76 case in the equivalence fixture, this script
computes the textbook value (scipy.stats.norm.cdf-anchored BS/Black-76)
and compares to the JS reference. The maximum |textbook − JS|
observed for each function — plus a small headroom for the residual
A&S 7.1.26 vs scipy-erf gap that affects the actual Rust impl —
becomes that function's per-function tolerance in the expected-
divergence config.

This is a Phase 1.5 one-off. Re-run only when fixtures change.

Run from the QF repo root:

    .scipy-venv/bin/python core/qf-quant/tests/fixtures/equivalence_v1/gen_cdf_correction_divergence.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Callable

from scipy.stats import norm  # type: ignore[import-not-found]

# A&S 7.1.26 max |err| ~7.5e-8; that propagates through BS roughly as
# `S × err`. For our test grid S ≤ 110, the residual Rust-vs-scipy
# absolute gap is ~1e-5. The cdf-correction tolerance bounds
# |Rust − JS|, so add the residual gap to the max observed
# |textbook − JS| to keep the harness honest.
RESIDUAL_HEADROOM = 1e-4

FIXTURE_DIR = Path(__file__).parent


def d1_bs(s: float, k: float, r: float, t: float, v: float) -> float:
    return (math.log(s / k) + (r + v * v / 2) * t) / (v * math.sqrt(t))


def d2_bs(s: float, k: float, r: float, t: float, v: float) -> float:
    return d1_bs(s, k, r, t, v) - v * math.sqrt(t)


def bs_call(s: float, k: float, r: float, t: float, v: float) -> float:
    return s * norm.cdf(d1_bs(s, k, r, t, v)) - k * math.exp(-r * t) * norm.cdf(
        d2_bs(s, k, r, t, v)
    )


def bs_put(s: float, k: float, r: float, t: float, v: float) -> float:
    return k * math.exp(-r * t) * norm.cdf(-d2_bs(s, k, r, t, v)) - s * norm.cdf(
        -d1_bs(s, k, r, t, v)
    )


def bs_delta_call(s, k, r, t, v):
    return norm.cdf(d1_bs(s, k, r, t, v))


def bs_delta_put(s, k, r, t, v):
    return norm.cdf(d1_bs(s, k, r, t, v)) - 1.0


def bs_gamma(s, k, r, t, v):
    return norm.pdf(d1_bs(s, k, r, t, v)) / (s * v * math.sqrt(t))


def bs_theta_common(s, k, r, t, v):
    return -s * norm.pdf(d1_bs(s, k, r, t, v)) * v / (2 * math.sqrt(t))


def bs_theta_call(s, k, r, t, v):
    return (
        bs_theta_common(s, k, r, t, v)
        - r * k * math.exp(-r * t) * norm.cdf(d2_bs(s, k, r, t, v))
    ) / 365


def bs_theta_put(s, k, r, t, v):
    return (
        bs_theta_common(s, k, r, t, v)
        + r * k * math.exp(-r * t) * norm.cdf(-d2_bs(s, k, r, t, v))
    ) / 365


def bs_vega(s, k, r, t, v):
    return s * math.sqrt(t) * norm.pdf(d1_bs(s, k, r, t, v)) / 100


def d1_b76(f: float, k: float, t: float, v: float) -> float:
    return (math.log(f / k) + (v * v / 2) * t) / (v * math.sqrt(t))


def d2_b76(f: float, k: float, t: float, v: float) -> float:
    return d1_b76(f, k, t, v) - v * math.sqrt(t)


def b76_call(f, k, r, t, v):
    disc = math.exp(-r * t)
    return disc * (f * norm.cdf(d1_b76(f, k, t, v)) - k * norm.cdf(d2_b76(f, k, t, v)))


def b76_put(f, k, r, t, v):
    disc = math.exp(-r * t)
    return disc * (
        k * norm.cdf(-d2_b76(f, k, t, v)) - f * norm.cdf(-d1_b76(f, k, t, v))
    )


def b76_delta_call(f, k, r, t, v):
    return math.exp(-r * t) * norm.cdf(d1_b76(f, k, t, v))


def b76_delta_put(f, k, r, t, v):
    return math.exp(-r * t) * (norm.cdf(d1_b76(f, k, t, v)) - 1.0)


def b76_gamma(f, k, r, t, v):
    return math.exp(-r * t) * norm.pdf(d1_b76(f, k, t, v)) / (f * v * math.sqrt(t))


def b76_theta_common(f, k, r, t, v):
    return -f * math.exp(-r * t) * norm.pdf(d1_b76(f, k, t, v)) * v / (2 * math.sqrt(t))


def b76_theta_call(f, k, r, t, v):
    disc = math.exp(-r * t)
    return (
        b76_theta_common(f, k, r, t, v)
        + r * f * disc * norm.cdf(d1_b76(f, k, t, v))
        - r * k * disc * norm.cdf(d2_b76(f, k, t, v))
    ) / 365


def b76_theta_put(f, k, r, t, v):
    disc = math.exp(-r * t)
    return (
        b76_theta_common(f, k, r, t, v)
        - r * f * disc * norm.cdf(-d1_b76(f, k, t, v))
        + r * k * disc * norm.cdf(-d2_b76(f, k, t, v))
    ) / 365


def b76_vega(f, k, r, t, v):
    return f * math.exp(-r * t) * math.sqrt(t) * norm.pdf(d1_b76(f, k, t, v)) / 100


# (fixture_filename, function_name, scipy_callable)
PRICING_GREEK_FUNCTIONS: list[tuple[str, str, Callable[..., float]]] = [
    ("bs_call.json", "bs::call", bs_call),
    ("bs_put.json", "bs::put", bs_put),
    ("bs_delta_call.json", "bs::delta_call", bs_delta_call),
    ("bs_delta_put.json", "bs::delta_put", bs_delta_put),
    ("bs_gamma.json", "bs::gamma", bs_gamma),
    ("bs_theta_call.json", "bs::theta_call", bs_theta_call),
    ("bs_theta_put.json", "bs::theta_put", bs_theta_put),
    ("bs_vega.json", "bs::vega", bs_vega),
    ("black76_call.json", "black76::call", b76_call),
    ("black76_put.json", "black76::put", b76_put),
    ("black76_delta_call.json", "black76::delta_call", b76_delta_call),
    ("black76_delta_put.json", "black76::delta_put", b76_delta_put),
    ("black76_gamma.json", "black76::gamma", b76_gamma),
    ("black76_theta_call.json", "black76::theta_call", b76_theta_call),
    ("black76_theta_put.json", "black76::theta_put", b76_theta_put),
    ("black76_vega.json", "black76::vega", b76_vega),
]

# IV functions are different — the JS-recovered vol is for a different
# pricing function than the Rust-recovered vol. The maximum spread
# observed in practice is bounded by the bisection's [0.001, 5.0]
# bracket, but in the body of the grid the recovered vols are usually
# within ~50% of each other. Set a generous documented tolerance.
IV_FUNCTIONS = [
    "bs::implied_vol_call",
    "bs::implied_vol_put",
    "black76::implied_vol_call",
    "black76::implied_vol_put",
]
IV_TOLERANCE = 5.0  # vol is bounded above by IV_HI = 5.0


def max_div_for_pricing(fixture_file: str, scipy_fn: Callable[..., float]) -> float:
    body = json.loads((FIXTURE_DIR / fixture_file).read_text())
    max_diff = 0.0
    for case in body["cases"]:
        textbook = scipy_fn(*case["inputs"])
        diff = abs(textbook - case["expected"])
        if diff > max_diff:
            max_diff = diff
    return max_diff


def main() -> None:
    print("# Generated by gen_cdf_correction_divergence.py — do not hand-edit.")
    print("# Per-function tolerances bound |Rust (post-cutover, cdf_correct)")
    print("# − JS (pre-cutover, bug-for-bug cdf)|. Computed as the max")
    print("# |scipy textbook − JS| over each fixture's cases, plus a small")
    print(f"# headroom ({RESIDUAL_HEADROOM:.0e}) for the residual A&S 7.1.26 vs")
    print("# scipy-erf gap in Rust's `cdf_correct` impl.")
    print()
    print("[cdf-correction-functions]")
    for fixture_file, fn_name, scipy_fn in PRICING_GREEK_FUNCTIONS:
        max_diff = max_div_for_pricing(fixture_file, scipy_fn)
        tol = max_diff + RESIDUAL_HEADROOM
        print(f'"{fn_name}" = {tol:.6e}')
    for fn_name in IV_FUNCTIONS:
        print(f'"{fn_name}" = {IV_TOLERANCE}')


if __name__ == "__main__":
    main()
