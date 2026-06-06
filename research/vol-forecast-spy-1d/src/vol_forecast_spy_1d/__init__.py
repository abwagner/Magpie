"""vol-forecast-spy-1d — SPY 1-day vol forecaster, SDK validation case.

The model worker referenced throughout the polyglot-migration TDD
as the canonical example, finally implemented. QF-113 ships it as
the end-to-end validation case for the quantfoundry-signals SDK.

Run:

.. code-block:: shell

    python -m quantfoundry_signals \\
        --worker vol_forecast_spy_1d:VolForecastSpy1D \\
        --symbols EQ:SPY
"""

from vol_forecast_spy_1d.data import (
    FIXTURE_PATH,
    DailyReturn,
    load_returns_csv,
    recent_returns,
)
from vol_forecast_spy_1d.model import (
    ANNUALISATION_DAYS,
    DEFAULT_LAMBDA,
    VolForecast,
    ewma_variance,
    forecast,
)
from vol_forecast_spy_1d.worker import (
    DEFAULT_WINDOW,
    VolForecastSpy1D,
)

__all__ = [
    "ANNUALISATION_DAYS",
    "DEFAULT_LAMBDA",
    "DEFAULT_WINDOW",
    "FIXTURE_PATH",
    "DailyReturn",
    "VolForecast",
    "VolForecastSpy1D",
    "ewma_variance",
    "forecast",
    "load_returns_csv",
    "recent_returns",
]
