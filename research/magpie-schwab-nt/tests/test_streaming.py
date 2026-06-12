"""Tests for ``magpie_schwab_nt.streaming``.

Strategy: inject a `FakeWebSocket` via the `ws_factory` parameter. The
fake's `inject()` simulates Schwab pushing a frame; its `sent` list
captures what the client sent. The token store is also mocked so no
real Schwab API calls happen.

Covers:
- SchwabStreamerInfo.from_user_preference happy + missing-field paths.
- start() → LOGIN → ACK happy path.
- Login rejection → StreamerLoginError.
- subscribe() sends a SUBS envelope; data frames arrive in the queue.
- Per-key dispatch routes content rows to the right subscription.
- drop_oldest backpressure: when queue is full, oldest item is
  discarded and drop_count increments.
- Reconnect: simulated disconnect triggers a reconnect + replays the
  existing subscription.
- Heartbeat timeout fires reconnect.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from magpie_schwab_nt.auth import SchwabTokenStore
from magpie_schwab_nt.streaming import (
    SchwabStreamerClient,
    SchwabStreamerInfo,
    StreamerLoginError,
)

# ── Fixtures ──────────────────────────────────────────────────────


STREAMER_INFO = SchwabStreamerInfo(
    streamer_socket_url="wss://streamer.example/ws",
    schwab_client_customer_id="cust-1",
    schwab_client_correl_id="correl-1",
    schwab_client_channel="ch-1",
    schwab_client_function_id="fn-1",
)


class FakeWebSocket:
    """Async-iterable WS double driven by test code via `.inject()`."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self.closed = False

    async def send(self, msg: str) -> None:
        self.sent.append(msg)

    async def recv(self) -> str:
        item = await self._incoming.get()
        if item is None:
            # Simulate the WS being closed by the peer.
            from websockets.exceptions import ConnectionClosedOK

            raise ConnectionClosedOK(None, None)
        return item

    async def close(self) -> None:
        self.closed = True
        # Signal recv() that the connection is done.
        await self._incoming.put(None)

    # Test-side helpers.
    def inject(self, msg: dict[str, Any] | str) -> None:
        if isinstance(msg, dict):
            msg = json.dumps(msg)
        self._incoming.put_nowait(msg)

    def inject_close(self) -> None:
        self._incoming.put_nowait(None)


class FakeFactory:
    """Reusable factory — yields a sequence of FakeWebSockets so tests
    can model reconnects (each connect attempt produces a fresh fake)."""

    def __init__(self) -> None:
        self.connections: list[FakeWebSocket] = []
        self._pending: list[FakeWebSocket] = []
        self.next_call_waiters: list[asyncio.Event] = []

    def queue(self, ws: FakeWebSocket) -> None:
        self._pending.append(ws)

    @asynccontextmanager
    async def __call__(self, url: str) -> Any:
        # Default: fresh WS each connect; tests can pre-queue specific
        # FakeWebSocket instances via `.queue(...)` to model reconnects.
        ws = self._pending.pop(0) if self._pending else FakeWebSocket()
        self.connections.append(ws)
        for ev in self.next_call_waiters:
            ev.set()
        self.next_call_waiters.clear()
        try:
            yield ws
        finally:
            await ws.close()


def _login_ack() -> dict[str, Any]:
    return {
        "response": [
            {
                "service": "ADMIN",
                "command": "LOGIN",
                "content": {"code": 0, "msg": "ok"},
            }
        ]
    }


def _data_frame(service: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {"data": [{"service": service, "content": rows}]}


async def _make_token_store(tmp_path: Path) -> SchwabTokenStore:
    """Build a token store that returns a fixed access token without HTTP."""
    SchwabTokenStore.bootstrap(tmp_path / "tokens.json", "ref")

    # Override `get_access_token` to skip the HTTP refresh path. The
    # streamer doesn't care that it's bypassed; it just wants a string.
    class _StubStore(SchwabTokenStore):
        async def get_access_token(self) -> str:  # type: ignore[override]
            return "stub-access-token"

    return _StubStore(
        app_key="k",
        app_secret="s",
        store_path=tmp_path / "tokens.json",
    )


# ── SchwabStreamerInfo ────────────────────────────────────────────


class TestStreamerInfo:
    def test_from_user_preference_happy(self) -> None:
        prefs = {
            "streamerInfo": [
                {
                    "streamerSocketUrl": "wss://x",
                    "schwabClientCustomerId": "c",
                    "schwabClientCorrelId": "k",
                    "schwabClientChannel": "ch",
                    "schwabClientFunctionId": "fn",
                }
            ]
        }
        info = SchwabStreamerInfo.from_user_preference(prefs)
        assert info.streamer_socket_url == "wss://x"
        assert info.schwab_client_channel == "ch"

    def test_missing_streamer_info_raises(self) -> None:
        with pytest.raises(ValueError, match="streamerInfo"):
            SchwabStreamerInfo.from_user_preference({})

    def test_missing_field_raises(self) -> None:
        with pytest.raises(ValueError, match="missing fields"):
            SchwabStreamerInfo.from_user_preference(
                {"streamerInfo": [{"streamerSocketUrl": "wss://x"}]}
            )


# ── LOGIN ────────────────────────────────────────────────────────


class TestLogin:
    @pytest.mark.asyncio
    async def test_start_sends_login_and_waits_for_ack(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws = FakeWebSocket()
        factory.queue(ws)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
        )

        async def feeder() -> None:
            # Wait until LOGIN has been sent, then ack.
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            ws.inject(_login_ack())

        feeder_task = asyncio.create_task(feeder())
        try:
            await client.start()
            sent = json.loads(ws.sent[0])
            login = sent["requests"][0]
            assert login["service"] == "ADMIN"
            assert login["command"] == "LOGIN"
            assert login["parameters"]["Authorization"] == "stub-access-token"
            assert login["parameters"]["SchwabClientChannel"] == "ch-1"
            assert login["SchwabClientCustomerId"] == "cust-1"
        finally:
            await feeder_task
            await client.stop()

    @pytest.mark.asyncio
    async def test_login_rejected_raises(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws = FakeWebSocket()
        factory.queue(ws)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
            heartbeat_timeout_s=2.0,
        )

        async def feeder() -> None:
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            ws.inject(
                {
                    "response": [
                        {
                            "service": "ADMIN",
                            "command": "LOGIN",
                            "content": {"code": 3, "msg": "bad token"},
                        }
                    ]
                }
            )

        feeder_task = asyncio.create_task(feeder())
        try:
            with pytest.raises(StreamerLoginError):
                await client.start()
        finally:
            await feeder_task


# ── SUBS dispatch ────────────────────────────────────────────────


class TestSubsDispatch:
    @pytest.mark.asyncio
    async def test_subscribe_sends_subs_envelope(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws = FakeWebSocket()
        factory.queue(ws)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
        )

        async def feeder() -> None:
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            ws.inject(_login_ack())

        feeder_task = asyncio.create_task(feeder())
        try:
            await client.start()
            await client.subscribe(
                service="LEVELONE_OPTIONS",
                keys=["AAPL  2026", "SPY  2026"],
                fields="0,1,2,3",
            )
            # First sent is LOGIN; second is SUBS.
            assert len(ws.sent) >= 2
            subs = json.loads(ws.sent[1])["requests"][0]
            assert subs["service"] == "LEVELONE_OPTIONS"
            assert subs["command"] == "SUBS"
            assert subs["parameters"]["keys"] == "AAPL  2026,SPY  2026"
            assert subs["parameters"]["fields"] == "0,1,2,3"
        finally:
            await feeder_task
            await client.stop()

    @pytest.mark.asyncio
    async def test_data_frame_routes_to_subscription_queue(
        self, tmp_path: Path
    ) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws = FakeWebSocket()
        factory.queue(ws)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
        )

        async def feeder() -> None:
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            ws.inject(_login_ack())

        feeder_task = asyncio.create_task(feeder())
        try:
            await client.start()
            sub = await client.subscribe(
                service="LEVELONE_OPTIONS",
                keys=["SPY"],
                fields="0,1,2,3",
            )
            # Inject a data frame with one matching row.
            ws.inject(
                _data_frame("LEVELONE_OPTIONS", [{"key": "SPY", "1": 1.23, "2": 4.56}])
            )
            row = await asyncio.wait_for(sub.queue.get(), timeout=1.0)
            assert row["key"] == "SPY"
            assert row["1"] == 1.23
        finally:
            await feeder_task
            await client.stop()

    @pytest.mark.asyncio
    async def test_per_key_routing(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws = FakeWebSocket()
        factory.queue(ws)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
        )

        async def feeder() -> None:
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            ws.inject(_login_ack())

        feeder_task = asyncio.create_task(feeder())
        try:
            await client.start()
            sub_a = await client.subscribe(
                service="LEVELONE_OPTIONS", keys=["AAPL"], fields="0,1"
            )
            sub_b = await client.subscribe(
                service="LEVELONE_OPTIONS", keys=["SPY"], fields="0,1"
            )
            ws.inject(
                _data_frame(
                    "LEVELONE_OPTIONS",
                    [{"key": "AAPL", "1": 100.0}, {"key": "SPY", "1": 200.0}],
                )
            )
            row_a = await asyncio.wait_for(sub_a.queue.get(), timeout=1.0)
            row_b = await asyncio.wait_for(sub_b.queue.get(), timeout=1.0)
            assert row_a["key"] == "AAPL"
            assert row_b["key"] == "SPY"
            # Each queue got only its matching row.
            assert sub_a.queue.empty()
            assert sub_b.queue.empty()
        finally:
            await feeder_task
            await client.stop()


# ── Backpressure ─────────────────────────────────────────────────


class TestBackpressure:
    @pytest.mark.asyncio
    async def test_drop_oldest_pops_oldest_when_full(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws = FakeWebSocket()
        factory.queue(ws)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
        )

        async def feeder() -> None:
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            ws.inject(_login_ack())

        feeder_task = asyncio.create_task(feeder())
        try:
            await client.start()
            sub = await client.subscribe(
                service="LEVELONE_OPTIONS",
                keys=["SPY"],
                fields="0,1",
                backpressure="drop_oldest",
                max_queue=2,
            )
            # Push three rows without draining; queue holds only the
            # last two; drop_count == 1.
            ws.inject(_data_frame("LEVELONE_OPTIONS", [{"key": "SPY", "n": 1}]))
            ws.inject(_data_frame("LEVELONE_OPTIONS", [{"key": "SPY", "n": 2}]))
            ws.inject(_data_frame("LEVELONE_OPTIONS", [{"key": "SPY", "n": 3}]))
            # Give the read loop a beat to process all three.
            for _ in range(100):
                if sub.drop_count >= 1 and sub.queue.qsize() == 2:
                    break
                await asyncio.sleep(0.005)
            assert sub.drop_count == 1
            assert sub.queue.qsize() == 2
            kept_one = await sub.queue.get()
            kept_two = await sub.queue.get()
            # Oldest (n=1) was dropped; we kept (n=2, n=3).
            assert kept_one["n"] == 2
            assert kept_two["n"] == 3
        finally:
            await feeder_task
            await client.stop()


# ── Reconnect + resubscribe ───────────────────────────────────────


class TestReconnect:
    @pytest.mark.asyncio
    async def test_reconnect_replays_subscriptions(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws1 = FakeWebSocket()
        ws2 = FakeWebSocket()
        factory.queue(ws1)
        factory.queue(ws2)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
            backoff_initial_s=0.01,
            backoff_cap_s=0.01,
        )

        async def feed_login(ws: FakeWebSocket) -> None:
            for _ in range(100):
                if ws.sent:
                    break
                await asyncio.sleep(0.005)
            ws.inject(_login_ack())

        # First login.
        login1 = asyncio.create_task(feed_login(ws1))
        try:
            await client.start()
            await login1
            await client.subscribe(
                service="LEVELONE_OPTIONS",
                keys=["SPY"],
                fields="0,1",
            )
            # ws1 saw LOGIN + SUBS.
            assert len(ws1.sent) == 2

            # Simulate a disconnect; supervisor reconnects to ws2.
            login2 = asyncio.create_task(feed_login(ws2))
            ws1.inject_close()

            # Wait until ws2 has at least 2 sends (LOGIN + replayed SUBS).
            for _ in range(200):
                if len(ws2.sent) >= 2:
                    break
                await asyncio.sleep(0.01)
            await login2

            # ws2 saw LOGIN and a replayed SUBS for SPY.
            assert len(ws2.sent) == 2
            replayed_subs = json.loads(ws2.sent[1])["requests"][0]
            assert replayed_subs["command"] == "SUBS"
            assert replayed_subs["service"] == "LEVELONE_OPTIONS"
            assert replayed_subs["parameters"]["keys"] == "SPY"
        finally:
            await client.stop()

    @pytest.mark.asyncio
    async def test_heartbeat_timeout_triggers_reconnect(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws1 = FakeWebSocket()
        ws2 = FakeWebSocket()
        factory.queue(ws1)
        factory.queue(ws2)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
            backoff_initial_s=0.01,
            backoff_cap_s=0.01,
            heartbeat_timeout_s=0.05,
        )

        async def feed_login(ws: FakeWebSocket) -> None:
            for _ in range(100):
                if ws.sent:
                    break
                await asyncio.sleep(0.005)
            ws.inject(_login_ack())

        try:
            login1 = asyncio.create_task(feed_login(ws1))
            await client.start()
            await login1

            # Now silently let the heartbeat timeout fire; supervisor
            # should disconnect ws1 and dial ws2.
            login2 = asyncio.create_task(feed_login(ws2))
            for _ in range(500):
                if len(factory.connections) >= 2:
                    break
                await asyncio.sleep(0.01)
            await login2
            assert len(factory.connections) >= 2
        finally:
            await client.stop()


# ── Unsubscribe ──────────────────────────────────────────────────


class TestUnsubscribe:
    @pytest.mark.asyncio
    async def test_unsubscribe_sends_unsubs(self, tmp_path: Path) -> None:
        tokens = await _make_token_store(tmp_path)
        factory = FakeFactory()
        ws = FakeWebSocket()
        factory.queue(ws)
        client = SchwabStreamerClient(
            token_store=tokens,
            streamer_info=STREAMER_INFO,
            ws_factory=factory,
        )

        async def feeder() -> None:
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            ws.inject(_login_ack())

        feeder_task = asyncio.create_task(feeder())
        try:
            await client.start()
            sub = await client.subscribe(
                service="LEVELONE_OPTIONS", keys=["SPY"], fields="0,1"
            )
            # ws.sent: [LOGIN, SUBS]
            await client.unsubscribe(sub)
            # ws.sent: [LOGIN, SUBS, UNSUBS]
            assert len(ws.sent) == 3
            unsubs = json.loads(ws.sent[2])["requests"][0]
            assert unsubs["command"] == "UNSUBS"
            assert unsubs["service"] == "LEVELONE_OPTIONS"
            assert unsubs["parameters"]["keys"] == "SPY"
        finally:
            await feeder_task
            await client.stop()
