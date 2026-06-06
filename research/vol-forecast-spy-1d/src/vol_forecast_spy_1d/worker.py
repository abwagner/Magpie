""":class:`VolForecastSpy1D` — the SDK validation case.

Subclasses :class:`quantfoundry_signals.SignalWorker`, loads the
recent SPY daily-return window from the configured source, runs
:func:`model.forecast`, and emits a :class:`PointPayload` with
``unit="vol"`` and ``value`` = the annualised forecast. The SDK
auto-fills :class:`Provenance` and stamps ``schema_version``.

The wire output for ``EQ:SPY`` looks like:

.. code-block:: json

    {
      "schema_version": 1,
      "model_id": "vol-forecast-spy-1d",
      "model_version": "0.1.0-ewma-094",
      "symbol": "EQ:SPY",
      "asof": "2025-03-31T20:00:00.000000Z",
      "horizon": {"duration": "P1D", "anchor": "next_close", "label": null},
      "kind": "point",
      "payload": {"value": 0.18, "unit": "vol"},
      "provenance": {"worker_id": "...", "run_id": "..."},
      "confidence": 0.87
    }

The model's ``confidence`` field is a heuristic — proportion of the
window populated (a thin window from a fresh deploy emits with low
confidence so the strategy layer can weight accordingly).

Run it::

    python -m quantfoundry_signals \\
        --worker vol_forecast_spy_1d:VolForecastSpy1D \\
        --symbols EQ:SPY \\
        --asof 2025-03-31T20:00:00Z
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from pathlib import Path

from quantfoundry_signals import (
    Horizon,
    PointPayload,
    PredictContext,
    Provenance,
    Signal,
    SignalPayload,
    SignalPublisher,
    SignalWorker,
)

from vol_forecast_spy_1d.data import (
    FIXTURE_PATH,
    DailyReturn,
    load_returns_csv,
    recent_returns,
)
from vol_forecast_spy_1d.model import (
    DEFAULT_LAMBDA,
    VolForecast,
    forecast,
)

DEFAULT_WINDOW = 60  # trading days — ~3 months of daily history


class VolForecastSpy1D(SignalWorker):  # type: ignore[misc]  # quantfoundry-signals has no py.typed marker yet
    """Daily 1-day-ahead vol forecaster for SPY.

    Loads daily log-returns from ``returns_path`` (CSV; defaults to
    the package's bundled fixture for tests), computes the
    EWMA-variance forecast over the trailing ``window`` days, and
    emits a :class:`PointPayload` with the annualised vol estimate.
    """

    model_id = "vol-forecast-spy-1d"
    model_version = "0.1.0-ewma-094"
    kind = "point"
    horizon = Horizon(duration="P1D", anchor="next_close")
    schedule = "0 16 * * 1-5"  # 4pm ET weekdays — info only; the runner schedules

    def __init__(
        self,
        *,
        returns_path: Path | str = FIXTURE_PATH,
        window: int = DEFAULT_WINDOW,
        lam: float = DEFAULT_LAMBDA,
        publisher: SignalPublisher | None = None,
        worker_id: str | None = None,
    ) -> None:
        super().__init__(publisher=publisher, worker_id=worker_id)
        if window <= 1:
            raise ValueError(f"VolForecastSpy1D: window must be > 1, got {window}")
        if not 0 < lam < 1:
            raise ValueError(f"VolForecastSpy1D: lam must be in (0, 1), got {lam}")
        self._returns_path = Path(returns_path)
        self._window = window
        self._lam = lam

    def predict(self, ctx: PredictContext) -> SignalPayload | Sequence[Signal]:
        if ctx.symbol != "EQ:SPY":
            raise ValueError(
                f"VolForecastSpy1D only emits for EQ:SPY (got {ctx.symbol!r})"
            )
        rows = load_returns_csv(self._returns_path)
        asof_date = ctx.asof[:10]  # YYYY-MM-DD slice of RFC3339
        window = recent_returns(rows, asof=asof_date, window=self._window)
        if not window:
            raise ValueError(
                f"VolForecastSpy1D: no SPY returns available at or before "
                f"{asof_date!r} in {self._returns_path}"
            )
        result = forecast(
            (r.log_return for r in window),
            asof=asof_date,
            lam=self._lam,
        )
        # The PointPayload + an inline Signal with confidence — we
        # need the confidence field which the bare-payload return
        # path can't set, so build the Signal explicitly.
        return [
            Signal(
                model_id=self.model_id,
                model_version=self.model_version,
                symbol=ctx.symbol,
                asof=ctx.asof,
                horizon=self.horizon,
                kind=self.kind,
                payload=PointPayload(
                    value=round(result.annualised_vol, 6),
                    unit="vol",
                ),
                provenance=Provenance(
                    worker_id=ctx.worker_id,
                    run_id=ctx.run_id,
                    input_hash=_input_hash(window, self._lam),
                ),
                confidence=round(_confidence(result, self._window), 4),
            ),
        ]


# ── Helpers ────────────────────────────────────────────────────────


def _confidence(result: VolForecast, target_window: int) -> float:
    """Heuristic confidence — fraction of the target window populated.

    A short history (first few days post-deploy) emits a forecast
    with low confidence so downstream strategies can weight it
    accordingly.
    """
    return min(1.0, result.sample_size / max(target_window, 1))


def _input_hash(window: Sequence[DailyReturn], lam: float) -> str:
    """Stable hash over the input window + EWMA parameter.

    Enables reproducibility checks: re-running the model with the
    same inputs must produce the same forecast.
    """
    body = "|".join(f"{r.date}:{r.log_return:.6f}" for r in window)
    body += f"|lam={lam:.6f}"
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


__all__ = [
    "DEFAULT_WINDOW",
    "VolForecastSpy1D",
]
