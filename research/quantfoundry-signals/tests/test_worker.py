"""Tests for ``quantfoundry_signals.worker.SignalWorker``.

The base class is intentionally small: enforce class metadata, run
``predict()`` per symbol, stamp provenance, validate identity on
worker-built signals. These tests cover each of those.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import httpx
import pytest
from quantfoundry_signals.publisher import SignalPublisher
from quantfoundry_signals.types import (
    Horizon,
    PointPayload,
    Provenance,
    Signal,
    SignalPayload,
)
from quantfoundry_signals.worker import PredictContext, SignalWorker


class _MinimalWorker(SignalWorker):
    """The smallest valid worker — returns a payload, SDK wraps it."""

    model_id = "vol-forecast-spy-1d"
    model_version = "v3.2"
    kind = "point"
    horizon = Horizon(duration="P1D", anchor="next_close")

    def predict(self, ctx: PredictContext) -> SignalPayload | Sequence[Signal]:
        return PointPayload(value=0.0142, unit="vol")


class _MultiWorker(SignalWorker):
    """A worker that returns a list of fully-built signals — exercises
    the second predict() return shape."""

    model_id = "multi-signal-emitter"
    model_version = "v1"
    kind = "point"
    horizon = Horizon(duration="P1D", anchor="next_close")

    def predict(self, ctx: PredictContext) -> SignalPayload | Sequence[Signal]:
        return [
            Signal(
                model_id=self.model_id,
                model_version=self.model_version,
                symbol=ctx.symbol,
                asof=ctx.asof,
                horizon=self.horizon,
                kind=self.kind,
                payload=PointPayload(value=1.0, unit="prob"),
                provenance=Provenance(worker_id=ctx.worker_id, run_id=ctx.run_id),
            ),
            Signal(
                model_id=self.model_id,
                model_version=self.model_version,
                symbol=ctx.symbol,
                asof=ctx.asof,
                horizon=self.horizon,
                kind=self.kind,
                payload=PointPayload(value=2.0, unit="prob"),
                provenance=Provenance(worker_id=ctx.worker_id, run_id=ctx.run_id),
            ),
        ]


def _mock_publisher(
    handler: Callable[[httpx.Request], httpx.Response],
) -> SignalPublisher:
    return SignalPublisher(
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=5.0
        )
    )


# ── Class-metadata enforcement ─────────────────────────────────────


class TestClassMetadata:
    def test_missing_attr_raises(self) -> None:
        class _NoModelId(SignalWorker):
            # model_id intentionally missing
            model_version = "v1"
            kind = "point"
            horizon = Horizon(duration="P1D", anchor="next_close")

            def predict(self, ctx: PredictContext) -> SignalPayload | Sequence[Signal]:
                return PointPayload(value=0.0, unit="prob")

        with pytest.raises(TypeError, match="model_id"):
            _NoModelId()


# ── build_signals ───────────────────────────────────────────────────


class TestBuildSignals:
    def test_payload_return_path(self) -> None:
        worker = _MinimalWorker()
        sigs = worker.build_signals(
            symbols=["EQ:SPY", "EQ:QQQ"], asof="2026-05-15T20:00:00Z"
        )
        assert len(sigs) == 2
        assert sigs[0].symbol == "EQ:SPY"
        assert sigs[1].symbol == "EQ:QQQ"
        assert sigs[0].model_id == "vol-forecast-spy-1d"
        assert sigs[0].kind == "point"
        assert sigs[0].horizon.duration == "P1D"
        # Provenance auto-filled; identical run_id across the batch.
        assert sigs[0].provenance.run_id == sigs[1].provenance.run_id
        # worker_id non-empty (resolves via env / hostname).
        assert sigs[0].provenance.worker_id

    def test_signal_list_return_path(self) -> None:
        worker = _MultiWorker()
        sigs = worker.build_signals(symbols=["EQ:SPY"], asof="2026-05-15T20:00:00Z")
        # 1 symbol × 2 signals from predict() = 2 total.
        assert len(sigs) == 2
        assert all(s.symbol == "EQ:SPY" for s in sigs)

    def test_invalid_symbol_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown symbol class"):
            _MinimalWorker().build_signals(symbols=["WAT:SPY"])

    def test_asof_datetime_coerced_to_rfc3339_z(self) -> None:
        from datetime import UTC, datetime

        dt = datetime(2026, 5, 15, 20, 0, 0, tzinfo=UTC)
        sigs = _MinimalWorker().build_signals(symbols=["EQ:SPY"], asof=dt)
        assert sigs[0].asof.endswith("Z")
        assert "2026-05-15" in sigs[0].asof

    def test_asof_naive_datetime_raises(self) -> None:
        from datetime import datetime

        with pytest.raises(ValueError, match="timezone-aware"):
            _MinimalWorker().build_signals(
                symbols=["EQ:SPY"], asof=datetime(2026, 5, 15, 20, 0, 0)
            )

    def test_identity_mismatch_raises(self) -> None:
        class _BadWorker(SignalWorker):
            model_id = "real-model"
            model_version = "v1"
            kind = "point"
            horizon = Horizon(duration="P1D", anchor="next_close")

            def predict(self, ctx: PredictContext) -> SignalPayload | Sequence[Signal]:
                return [
                    Signal(
                        model_id="wrong-model",  # mismatch!
                        model_version="v1",
                        symbol=ctx.symbol,
                        asof=ctx.asof,
                        horizon=self.horizon,
                        kind=self.kind,
                        payload=PointPayload(value=0.0, unit="prob"),
                        provenance=Provenance(
                            worker_id=ctx.worker_id, run_id=ctx.run_id
                        ),
                    )
                ]

        with pytest.raises(ValueError, match="model_id=.*wrong-model"):
            _BadWorker().build_signals(symbols=["EQ:SPY"])


# ── run_once integration with publisher ────────────────────────────


class TestRunOnce:
    @pytest.mark.asyncio
    async def test_publishes_via_supplied_publisher(self) -> None:
        captured: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                200, json={"accepted": 1, "ack": "fast", "batch_id": "b-1"}
            )

        worker = _MinimalWorker(publisher=_mock_publisher(handler))
        try:
            result = await worker.run_once(symbols=["EQ:SPY"])
            assert result.accepted == 1
            assert result.batch_id == "b-1"
            assert len(captured) == 1
        finally:
            await worker.aclose()

    @pytest.mark.asyncio
    async def test_propagates_correlation_id_in_logs(self) -> None:
        # Just ensure the correlation_id contextmanager doesn't error;
        # log capture would require a structlog test rig.
        worker = _MinimalWorker(
            publisher=_mock_publisher(
                lambda _: httpx.Response(
                    200, json={"accepted": 1, "ack": "fast", "batch_id": "b"}
                )
            )
        )
        try:
            await worker.run_once(symbols=["EQ:SPY"], correlation_id="cid-xyz")
        finally:
            await worker.aclose()
