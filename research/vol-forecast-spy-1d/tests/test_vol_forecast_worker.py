"""Tests for ``vol_forecast_spy_1d.worker.VolForecastSpy1D``.

These are the QF-113 acceptance tests: the worker runs in Python
under the SDK, builds wire-shape signals that match
``src/types/signal.ts``, and publishes them through the SDK's
HTTP transport against a mock ingress so no real server is needed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from quantfoundry_signals import (
    SignalPublisher,
)
from vol_forecast_spy_1d.worker import (
    DEFAULT_WINDOW,
    VolForecastSpy1D,
)


def _mock_publisher(captured: list[httpx.Request]) -> SignalPublisher:
    def handler(req: httpx.Request) -> httpx.Response:
        captured.append(req)
        return httpx.Response(
            200,
            json={"accepted": 1, "ack": "fast", "batch_id": "b-1"},
        )

    return SignalPublisher(
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=5.0
        ),
        token="test-token",
    )


# ── Class-metadata + construction ──────────────────────────────────


class TestConstruction:
    def test_class_metadata_locked_to_the_model(self) -> None:
        worker = VolForecastSpy1D()
        assert worker.model_id == "vol-forecast-spy-1d"
        assert worker.kind == "point"
        assert worker.horizon.duration == "P1D"
        assert worker.horizon.anchor == "next_close"
        assert worker.model_version.startswith("0.1.0-ewma-094")

    def test_window_below_two_rejected(self) -> None:
        with pytest.raises(ValueError, match="window"):
            VolForecastSpy1D(window=1)

    def test_lam_out_of_range_rejected(self) -> None:
        with pytest.raises(ValueError, match="lam"):
            VolForecastSpy1D(lam=0.0)
        with pytest.raises(ValueError, match="lam"):
            VolForecastSpy1D(lam=1.0)


# ── Predict ─────────────────────────────────────────────────────────


class TestPredict:
    def test_rejects_non_spy_symbols(self) -> None:
        worker = VolForecastSpy1D()
        with pytest.raises(ValueError, match="only emits for EQ:SPY"):
            worker.build_signals(symbols=["EQ:QQQ"], asof="2025-03-31T20:00:00Z")

    def test_emits_one_signal_with_expected_wire_shape(self) -> None:
        worker = VolForecastSpy1D()
        sigs = worker.build_signals(symbols=["EQ:SPY"], asof="2025-03-31T20:00:00Z")
        assert len(sigs) == 1
        sig = sigs[0]
        wire = sig.to_wire()
        assert wire["schema_version"] == 1
        assert wire["model_id"] == "vol-forecast-spy-1d"
        assert wire["model_version"] == "0.1.0-ewma-094"
        assert wire["symbol"] == "EQ:SPY"
        assert wire["asof"] == "2025-03-31T20:00:00Z"
        assert wire["kind"] == "point"
        assert wire["horizon"] == {
            "duration": "P1D",
            "anchor": "next_close",
            "label": None,
        }
        payload = wire["payload"]
        assert payload["unit"] == "vol"
        # Forecast against the fixture is in a plausible vol range
        # (the fixture has ~1% daily moves with a couple of spikes).
        assert 0.10 < payload["value"] < 0.45

    def test_provenance_input_hash_is_stable(self) -> None:
        worker = VolForecastSpy1D()
        a = worker.build_signals(symbols=["EQ:SPY"], asof="2025-03-31T20:00:00Z")
        b = worker.build_signals(symbols=["EQ:SPY"], asof="2025-03-31T20:00:00Z")
        # Same inputs → same input_hash (run_ids differ).
        assert a[0].provenance.input_hash is not None
        assert a[0].provenance.input_hash == b[0].provenance.input_hash
        assert a[0].provenance.run_id != b[0].provenance.run_id

    def test_confidence_proportional_to_window_filled(self) -> None:
        # With the bundled fixture, a window of 200 (more than the
        # fixture has) drops the confidence below 1.0 since the
        # sample is short.
        worker = VolForecastSpy1D(window=200)
        sigs = worker.build_signals(symbols=["EQ:SPY"], asof="2025-03-31T20:00:00Z")
        assert sigs[0].confidence is not None
        assert 0.0 < sigs[0].confidence < 1.0

    def test_confidence_caps_at_one_with_a_full_window(self) -> None:
        # Small window vs the fixture: we have plenty of returns, so
        # confidence saturates at 1.
        worker = VolForecastSpy1D(window=10)
        sigs = worker.build_signals(symbols=["EQ:SPY"], asof="2025-03-31T20:00:00Z")
        assert sigs[0].confidence == 1.0

    def test_no_data_before_asof_raises(self, tmp_path: Path) -> None:
        # Custom fixture with no rows at or before the asof.
        empty = tmp_path / "empty.csv"
        empty.write_text("date,log_return\n2025-12-31,0.0\n")
        worker = VolForecastSpy1D(returns_path=empty)
        with pytest.raises(ValueError, match="no SPY returns available"):
            worker.build_signals(symbols=["EQ:SPY"], asof="2025-01-01T20:00:00Z")


# ── End-to-end SDK round-trip ──────────────────────────────────────


class TestEndToEndPublish:
    """The acceptance test the ticket really cares about.

    Construct the worker with a mock-transport :class:`SignalPublisher`
    so we exercise the SDK's full request-build → POST → response-
    parse path. Assertions on the HTTP body confirm the wire shape
    the TS ingress would receive.
    """

    @pytest.mark.asyncio
    async def test_run_once_posts_to_ingress_with_correct_shape(self) -> None:
        captured: list[httpx.Request] = []
        publisher = _mock_publisher(captured)
        worker = VolForecastSpy1D(publisher=publisher)
        try:
            result = await worker.run_once(
                symbols=["EQ:SPY"],
                asof="2025-03-31T20:00:00Z",
                correlation_id="cid-vol-forecast",
            )
            assert result.accepted == 1
            assert result.ack == "fast"
            assert result.batch_id == "b-1"
        finally:
            await worker.aclose()

        # Exactly one HTTP POST landed.
        assert len(captured) == 1
        req = captured[0]
        assert req.method == "POST"
        assert req.headers["Authorization"] == "Bearer test-token"
        body = req.read()
        # Body is JSON-encoded { signals: [ ... ] }.
        import json

        decoded = json.loads(body.decode("utf-8"))
        assert isinstance(decoded.get("signals"), list)
        assert len(decoded["signals"]) == 1
        wire = decoded["signals"][0]
        assert wire["model_id"] == "vol-forecast-spy-1d"
        assert wire["symbol"] == "EQ:SPY"
        assert wire["kind"] == "point"
        assert wire["payload"]["unit"] == "vol"

    def test_default_window_constant(self) -> None:
        # Pins the documented default — strategies that read the
        # constant directly shouldn't be silently retuned by a code
        # change.
        assert DEFAULT_WINDOW == 60


# ── Convenience accessors ──────────────────────────────────────────


def test_module_exports() -> None:
    """The package exposes the workers + helpers from its __init__."""
    import vol_forecast_spy_1d as pkg

    assert hasattr(pkg, "VolForecastSpy1D")
    assert hasattr(pkg, "forecast")
    assert hasattr(pkg, "ewma_variance")
    assert hasattr(pkg, "load_returns_csv")


def _unused(_x: Any) -> None: ...
