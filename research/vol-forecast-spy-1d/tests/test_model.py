"""Tests for ``vol_forecast_spy_1d.model``."""

from __future__ import annotations

import math

import pytest
from vol_forecast_spy_1d.model import (
    ANNUALISATION_DAYS,
    DEFAULT_LAMBDA,
    ewma_variance,
    forecast,
)


class TestEwmaVariance:
    def test_constant_returns_have_zero_variance(self) -> None:
        # A series of identical returns has zero unweighted variance,
        # and the EWMA recursion never injects any either.
        sigma2 = ewma_variance([0.0] * 10)
        assert sigma2 == pytest.approx(0.0, abs=1e-12)

    def test_higher_returns_increase_variance(self) -> None:
        small = ewma_variance([0.001, -0.001] * 30)
        big = ewma_variance([0.05, -0.05] * 30)
        assert big > small

    def test_lam_clamped_to_open_interval(self) -> None:
        with pytest.raises(ValueError, match="lam must be in"):
            ewma_variance([0.01], lam=0.0)
        with pytest.raises(ValueError, match="lam must be in"):
            ewma_variance([0.01], lam=1.0)
        with pytest.raises(ValueError, match="lam must be in"):
            ewma_variance([0.01], lam=-0.5)

    def test_empty_input_raises(self) -> None:
        with pytest.raises(ValueError, match="empty"):
            ewma_variance([])

    def test_single_return_returns_finite_seed(self) -> None:
        # With one return the unweighted variance falls back to 0,
        # then the recursion picks up r^2 * (1 - lam).
        sigma2 = ewma_variance([0.01], lam=0.9)
        # 0.9 * 0 + 0.1 * 0.01^2 = 1e-5
        assert sigma2 == pytest.approx(0.1 * 1e-4, rel=1e-9)


class TestForecast:
    def test_returns_vol_forecast_with_expected_shape(self) -> None:
        # Generate a series with known unconditional vol ~1% daily.
        returns = [0.01, -0.01] * 30
        result = forecast(returns, asof="2025-01-31")
        assert result.asof == "2025-01-31"
        assert result.sample_size == 60
        assert result.daily_variance > 0
        # Annualised vol from ~1% daily ≈ 0.01 * sqrt(252) ≈ 0.159.
        assert 0.10 < result.annualised_vol < 0.20
        # Round-trip the annualisation factor.
        recovered = result.annualised_vol**2 / ANNUALISATION_DAYS
        assert recovered == pytest.approx(result.daily_variance)

    def test_lam_default_matches_riskmetrics(self) -> None:
        result = forecast([0.01], asof="2025-01-01")
        assert result.lam == DEFAULT_LAMBDA
        assert result.lam == pytest.approx(0.94)

    def test_explicit_lam_propagated_through(self) -> None:
        result = forecast([0.01, -0.02, 0.005], asof="2025-01-01", lam=0.5)
        assert result.lam == 0.5

    def test_annualised_vol_is_finite_and_positive(self) -> None:
        result = forecast([0.005, -0.003, 0.001, -0.0008], asof="2025-01-01")
        assert math.isfinite(result.annualised_vol)
        assert result.annualised_vol > 0
