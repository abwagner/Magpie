"""Tests for ``quantfoundry_signals.publisher`` via ``httpx.MockTransport``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest
from quantfoundry_signals.exceptions import (
    SignalAuthError,
    SignalRateLimitError,
    SignalServerError,
    SignalTransportError,
    SignalValidationError,
)
from quantfoundry_signals.publisher import (
    DEFAULT_INGRESS_URL,
    SignalPublisher,
)
from quantfoundry_signals.types import (
    Horizon,
    PointPayload,
    Provenance,
    Signal,
)


def _mock_client(
    handler: Callable[[httpx.Request], httpx.Response],
) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=5.0)


def _signal(symbol: str = "EQ:SPY") -> Signal:
    return Signal(
        model_id="vol-forecast-spy-1d",
        model_version="v3.2",
        symbol=symbol,
        asof="2026-05-15T20:00:00Z",
        horizon=Horizon(duration="P1D", anchor="next_close"),
        kind="point",
        payload=PointPayload(value=0.0142, unit="vol"),
        provenance=Provenance(worker_id="w", run_id="r"),
    )


@pytest.fixture(autouse=True)
def _fast_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """No real sleeps — replace ``asyncio.sleep`` with a no-op."""

    async def _noop(_: float) -> None:
        return None

    monkeypatch.setattr("quantfoundry_signals.publisher.asyncio.sleep", _noop)


# ── 200 happy path ──────────────────────────────────────────────────


class TestPublishOK:
    @pytest.mark.asyncio
    async def test_200_returns_parsed_accept(self) -> None:
        captured: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                200,
                json={"accepted": 1, "ack": "durable", "batch_id": "batch-001"},
            )

        async with SignalPublisher(
            http_client=_mock_client(handler), token="tok-1"
        ) as pub:
            result = await pub.publish([_signal()])

        assert result.accepted == 1
        assert result.ack == "durable"
        assert result.batch_id == "batch-001"
        assert captured[0].method == "POST"
        assert captured[0].url == DEFAULT_INGRESS_URL
        assert captured[0].headers["Authorization"] == "Bearer tok-1"

    @pytest.mark.asyncio
    async def test_empty_batch_raises(self) -> None:
        async with SignalPublisher(
            http_client=_mock_client(lambda _: httpx.Response(200))
        ) as pub:
            with pytest.raises(SignalValidationError, match="non-empty"):
                await pub.publish([])

    @pytest.mark.asyncio
    async def test_oversized_batch_raises(self) -> None:
        async with SignalPublisher(
            http_client=_mock_client(lambda _: httpx.Response(200))
        ) as pub:
            with pytest.raises(SignalValidationError, match="1000-signal cap"):
                await pub.publish([_signal()] * 1001)

    @pytest.mark.asyncio
    async def test_no_token_emits_no_auth_header(self) -> None:
        captured: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                200,
                json={"accepted": 1, "ack": "fast", "batch_id": "b"},
            )

        async with SignalPublisher(http_client=_mock_client(handler), token="") as pub:
            await pub.publish([_signal()])
        assert "Authorization" not in captured[0].headers


# ── Auth / Validation ──────────────────────────────────────────────


class TestPublishAuth:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [401, 403])
    async def test_auth_status_raises_signal_auth_error(self, status: int) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(status, json={"error": "unauthorized"})

        async with SignalPublisher(
            http_client=_mock_client(handler), token="bad"
        ) as pub:
            with pytest.raises(SignalAuthError) as exc:
                await pub.publish([_signal()])
        assert exc.value.status_code == status

    @pytest.mark.asyncio
    async def test_400_raises_validation_with_index_field(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                json={
                    "error": "validation_error",
                    "index": 2,
                    "field": "payload.value",
                    "message": "value must be finite",
                },
            )

        async with SignalPublisher(http_client=_mock_client(handler)) as pub:
            with pytest.raises(SignalValidationError) as exc:
                await pub.publish([_signal()])
        assert exc.value.index == 2
        assert exc.value.field == "payload.value"
        assert "value must be finite" in str(exc.value)


# ── Rate-limit (retry then surface) ────────────────────────────────


class TestPublishRateLimit:
    @pytest.mark.asyncio
    async def test_429_then_200_succeeds(self) -> None:
        attempts: list[int] = []

        def handler(_: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) < 2:
                return httpx.Response(
                    429,
                    headers={"Retry-After": "0"},
                    json={"error": "rate_limit", "model_id": "m", "retry_after_ms": 0},
                )
            return httpx.Response(
                200, json={"accepted": 1, "ack": "fast", "batch_id": "b"}
            )

        async with SignalPublisher(
            http_client=_mock_client(handler), max_retries=3
        ) as pub:
            result = await pub.publish([_signal()])
        assert result.accepted == 1
        assert len(attempts) == 2

    @pytest.mark.asyncio
    async def test_429_exhausts_retries(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                429,
                json={"error": "rate_limit", "retry_after_ms": 100, "model_id": "m"},
            )

        async with SignalPublisher(
            http_client=_mock_client(handler), max_retries=2
        ) as pub:
            with pytest.raises(SignalRateLimitError) as exc:
                await pub.publish([_signal()])
        assert exc.value.retry_after_ms == 100
        assert exc.value.model_id == "m"


# ── 5xx + transport (retry then surface) ──────────────────────────


class TestPublish5xxAndTransport:
    @pytest.mark.asyncio
    async def test_5xx_then_200_succeeds(self) -> None:
        attempts: list[int] = []

        def handler(_: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) < 2:
                return httpx.Response(503)
            return httpx.Response(
                200, json={"accepted": 1, "ack": "fast", "batch_id": "b"}
            )

        async with SignalPublisher(
            http_client=_mock_client(handler), max_retries=3
        ) as pub:
            result = await pub.publish([_signal()])
        assert result.accepted == 1
        assert len(attempts) == 2

    @pytest.mark.asyncio
    async def test_5xx_exhausts_retries(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        async with SignalPublisher(
            http_client=_mock_client(handler), max_retries=2
        ) as pub:
            with pytest.raises(SignalServerError) as exc:
                await pub.publish([_signal()])
        assert exc.value.status_code == 500

    @pytest.mark.asyncio
    async def test_transport_error_retries_then_surfaces(self) -> None:
        attempts: list[int] = []

        def handler(_: httpx.Request) -> httpx.Response:
            attempts.append(1)
            raise httpx.ConnectError("connect failed")

        async with SignalPublisher(
            http_client=_mock_client(handler), max_retries=2
        ) as pub:
            with pytest.raises(SignalTransportError):
                await pub.publish([_signal()])
        assert len(attempts) == 2

    @pytest.mark.asyncio
    async def test_other_4xx_raises_server_error(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(418, json={"error": "i_am_a_teapot"})

        async with SignalPublisher(http_client=_mock_client(handler)) as pub:
            with pytest.raises(SignalServerError) as exc:
                await pub.publish([_signal()])
        assert exc.value.status_code == 418


# ── Response parsing edge cases ────────────────────────────────────


class TestResponseParsing:
    @pytest.mark.asyncio
    async def test_200_missing_fields_raises(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"accepted": 1})  # no ack/batch_id

        async with SignalPublisher(http_client=_mock_client(handler)) as pub:
            with pytest.raises(SignalServerError, match="missing required fields"):
                await pub.publish([_signal()])

    @pytest.mark.asyncio
    async def test_200_unknown_ack_raises(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"accepted": 1, "ack": "weird", "batch_id": "b"}
            )

        async with SignalPublisher(http_client=_mock_client(handler)) as pub:
            with pytest.raises(SignalServerError, match="unknown ack mode"):
                await pub.publish([_signal()])


class TestConfig:
    def test_max_retries_below_1_raises(self) -> None:
        with pytest.raises(ValueError, match="max_retries"):
            SignalPublisher(max_retries=0)

    @pytest.mark.asyncio
    async def test_compute_retry_after_prefers_larger_value(self) -> None:
        # Header says 1s, body says 5000ms → publisher should sleep 5s.
        captured: list[float] = []

        async def _capturing_sleep(s: float) -> None:
            captured.append(s)

        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                429,
                headers={"Retry-After": "1"},
                json={"retry_after_ms": 5000, "model_id": "m"},
            )

        # Patch sleep just for this test (the autouse fixture replaced
        # it module-wide with a no-op; restore something that records).
        import quantfoundry_signals.publisher as pub_mod

        original = pub_mod.asyncio.sleep
        pub_mod.asyncio.sleep = _capturing_sleep  # type: ignore[assignment]
        try:
            async with SignalPublisher(
                http_client=_mock_client(handler), max_retries=2
            ) as pub:
                with pytest.raises(SignalRateLimitError):
                    await pub.publish([_signal()])
        finally:
            pub_mod.asyncio.sleep = original  # type: ignore[assignment]

        assert captured  # at least one sleep ran
        assert captured[0] >= 5.0  # body's 5000ms beats header's 1s


def _ignored(_: Any) -> None:
    """Suppress unused-import nags."""
