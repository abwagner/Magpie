"""EWMA 1-day-ahead realized-vol forecast.

Implements the RiskMetrics-style exponentially-weighted variance
estimator. With a decay factor ``lambda`` of 0.94 (the JP Morgan
default for daily data), the EWMA variance at time ``t`` is:

::

    sigma2_t = lambda * sigma2_{t-1} + (1 - lambda) * r_{t-1}^2

The model forecasts next-day variance as ``sigma2_t`` directly (a
random-walk forecast in variance space) and returns the annualised
standard-deviation forecast at ``sqrt(252 * sigma2_t)``. That's the
``vol`` units the QF wire schema's :class:`PointPayload` uses.

We deliberately avoid pulling in numpy / pandas — the EWMA loop is
~10 lines of plain Python over a list of floats. Keeps the worker's
runtime dependency footprint tiny.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

# RiskMetrics canonical decay for daily data.
DEFAULT_LAMBDA = 0.94

# Trading days per year for the standard annualisation factor.
ANNUALISATION_DAYS = 252


@dataclass(frozen=True)
class VolForecast:
    """One day's vol forecast + the inputs the estimator used.

    ``annualised_vol`` is the figure the wire signal carries; the
    rest is provenance for the worker's audit log (and a useful
    sanity check when debugging an unexpected forecast).
    """

    asof: str
    annualised_vol: float
    daily_variance: float
    sample_size: int
    lam: float


# ── Estimator ──────────────────────────────────────────────────────


def ewma_variance(
    returns: Iterable[float],
    *,
    lam: float = DEFAULT_LAMBDA,
) -> float:
    """Iterate the RiskMetrics recursion over ``returns`` (oldest-first).

    Seeds with the unweighted variance of the first window so the
    early observations don't pull the estimator toward zero. Returns
    the final ``sigma^2_t`` (daily variance, not annualised).

    Raises ``ValueError`` if the iterable is empty or ``lam`` is
    outside ``(0, 1)``.
    """
    if not 0 < lam < 1:
        raise ValueError(f"ewma_variance: lam must be in (0, 1), got {lam}")
    rs = list(returns)
    if not rs:
        raise ValueError("ewma_variance: returns iterable is empty")
    # Seed with the unweighted variance of the available history.
    n = len(rs)
    mean = sum(rs) / n
    seed = sum((r - mean) ** 2 for r in rs) / max(n - 1, 1)
    sigma2 = seed
    # Recursion: sigma2_t = lam * sigma2_{t-1} + (1 - lam) * r_{t-1}^2.
    one_minus_lam = 1.0 - lam
    for r in rs:
        sigma2 = lam * sigma2 + one_minus_lam * r * r
    return sigma2


def forecast(
    returns: Iterable[float],
    *,
    asof: str,
    lam: float = DEFAULT_LAMBDA,
    annualisation_days: int = ANNUALISATION_DAYS,
) -> VolForecast:
    """Produce a :class:`VolForecast` from the daily-return history.

    The forecast is the annualised standard deviation derived from
    the final-state EWMA variance; consumers compare it directly to
    annualised IV from the option chain.
    """
    rs = list(returns)
    sigma2 = ewma_variance(rs, lam=lam)
    annualised = math.sqrt(sigma2 * annualisation_days)
    return VolForecast(
        asof=asof,
        annualised_vol=annualised,
        daily_variance=sigma2,
        sample_size=len(rs),
        lam=lam,
    )


__all__ = [
    "ANNUALISATION_DAYS",
    "DEFAULT_LAMBDA",
    "VolForecast",
    "ewma_variance",
    "forecast",
]
