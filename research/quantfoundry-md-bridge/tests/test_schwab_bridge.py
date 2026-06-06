"""SchwabMdBridge unit tests — fake NATS + fake RestMdClient.

Verifies RPC dispatch, error mapping, historical_chain `not_supported`
override, heartbeat publishing, and stop-cleanup.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from quantfoundry_md_bridge.schwab.bridge import SchwabMdBridge, subjects_for
from quantfoundry_md_bridge.schwab.rest_md_client import SchwabMdError
from quantfoundry_md_bridge.wire import Candle, Contract, DataMeta, Quote

# ── Fake NATS ───────────────────────────────────────────────────────


@dataclass
class _FakeMsg:
    data: bytes
    _reply_future: asyncio.Future[bytes]

    async def respond(self, payload: bytes) -> None:
        if not self._reply_future.done():
            self._reply_future.set_result(payload)


@dataclass
class _FakeSubscription:
    _unsub_callback: Callable[[], None]

    async def unsubscribe(self) -> None:
        self._unsub_callback()


@dataclass
class _FakeNats:
    handlers: dict[str, Callable[[_FakeMsg], Awaitable[None]]] = field(
        default_factory=dict
    )
    published: list[tuple[str, bytes]] = field(default_factory=list)

    async def subscribe(
        self,
        subject: str,
        cb: Callable[[_FakeMsg], Awaitable[None]],
    ) -> _FakeSubscription:
        self.handlers[subject] = cb
        return _FakeSubscription(
            _unsub_callback=lambda: self.handlers.pop(subject, None)
        )

    async def publish(self, subject: str, payload: bytes) -> None:
        self.published.append((subject, payload))

    async def flush(self) -> None:
        await asyncio.sleep(0)

    async def request(self, subject: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Helper: synchronously invoke a registered handler and return the reply."""
        handler = self.handlers[subject]
        fut: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()
        await handler(
            _FakeMsg(data=json.dumps(payload).encode("utf-8"), _reply_future=fut)
        )
        raw = await fut
        return json.loads(raw.decode("utf-8"))


# ── Fake RestMdClient ───────────────────────────────────────────────


class _FakeRest:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.next_quote: Quote | None = None
        self.next_expirations: list[str] = []
        self.next_chain: list[Contract] = []
        self.next_candles: list[Candle] = []
        self.error: SchwabMdError | None = None

    async def get_quote(self, symbol: str, *, fetched_at: str) -> Quote:
        self.calls.append(("get_quote", (symbol, fetched_at)))
        if self.error:
            raise self.error
        assert self.next_quote is not None
        return self.next_quote

    async def get_expirations(self, symbol: str) -> list[str]:
        self.calls.append(("get_expirations", (symbol,)))
        if self.error:
            raise self.error
        return self.next_expirations

    async def get_chain(
        self, symbol: str, expiration: str, *, fetched_at: str
    ) -> list[Contract]:
        self.calls.append(("get_chain", (symbol, expiration, fetched_at)))
        if self.error:
            raise self.error
        return self.next_chain

    async def get_candles(
        self,
        symbol: str,
        from_date: str,
        to_date: str,
        frequency: str | None = None,
    ) -> list[Candle]:
        self.calls.append(("get_candles", (symbol, from_date, to_date, frequency)))
        if self.error:
            raise self.error
        return self.next_candles


# ── Fixtures ────────────────────────────────────────────────────────


def _sample_quote(symbol: str = "SPY") -> Quote:
    return Quote(
        symbol=symbol,
        bid=512.34,
        ask=512.38,
        mid=512.36,
        last=512.37,
        volume=12345678.0,
        timestamp="2026-05-20T18:30:00Z",
        meta=DataMeta(
            source="schwab",
            source_timestamp="2026-05-20T18:30:00Z",
            fetched_at="2026-05-20T18:30:00.123Z",
            freshness_ms=None,
            latency_ms=0.0,
            from_cache=False,
            cache_age_ms=0.0,
            sources_tried=("schwab",),
        ),
    )


@pytest.fixture
async def bridge() -> SchwabMdBridge:
    nats = _FakeNats()
    rest = _FakeRest()
    b = SchwabMdBridge(nats=nats, rest=rest, heartbeat_interval_s=0.05)  # type: ignore[arg-type]
    await b.start()
    # Snapshot deps onto the bridge for tests to introspect.
    b._test_nats = nats  # type: ignore[attr-defined]
    b._test_rest = rest  # type: ignore[attr-defined]
    yield b
    await b.stop()


# ── Subject layout ─────────────────────────────────────────────────


def test_subjects_for_schwab() -> None:
    s = subjects_for("schwab")
    assert s["quote"] == "marketdata.rpc.quote.schwab"
    assert s["expirations"] == "marketdata.rpc.expirations.schwab"
    assert s["chain"] == "marketdata.rpc.chain.schwab"
    assert s["historical_chain"] == "marketdata.rpc.historical_chain.schwab"
    assert s["candles"] == "marketdata.rpc.candles.schwab"
    assert s["heartbeat"] == "marketdata.schwab.heartbeat"
    assert s["quotes_stream"] == "marketdata.quotes.schwab"
    assert s["trades_stream"] == "marketdata.trades.schwab"
    assert s["book_stream"] == "marketdata.book.schwab"


# ── RPC dispatch ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_quote_handler_happy_path(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.next_quote = _sample_quote()
    reply = await nats.request("marketdata.rpc.quote.schwab", {"symbol": "SPY"})
    assert "quote" in reply
    assert reply["quote"]["symbol"] == "SPY"
    assert "error" not in reply
    assert rest.calls[0][0] == "get_quote"
    assert rest.calls[0][1][0] == "SPY"


@pytest.mark.asyncio
async def test_quote_handler_maps_401_to_auth_failed(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.error = SchwabMdError("unauthorized", status_code=401, body={"err": "x"})
    reply = await nats.request("marketdata.rpc.quote.schwab", {"symbol": "SPY"})
    assert reply["error"]["code"] == "auth_failed"


@pytest.mark.asyncio
async def test_quote_handler_maps_429_to_rate_limited(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.error = SchwabMdError("rate limited", status_code=429, body={})
    reply = await nats.request("marketdata.rpc.quote.schwab", {"symbol": "SPY"})
    assert reply["error"]["code"] == "rate_limited"


@pytest.mark.asyncio
async def test_quote_handler_maps_5xx_to_upstream_unavailable(
    bridge: SchwabMdBridge,
) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.error = SchwabMdError("server error", status_code=503, body={})
    reply = await nats.request("marketdata.rpc.quote.schwab", {"symbol": "SPY"})
    assert reply["error"]["code"] == "upstream_unavailable"


@pytest.mark.asyncio
async def test_quote_handler_returns_error_on_missing_symbol(
    bridge: SchwabMdBridge,
) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    reply = await nats.request("marketdata.rpc.quote.schwab", {})
    assert "quote" not in reply
    assert reply["error"]["code"] == "internal"


@pytest.mark.asyncio
async def test_expirations_handler(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.next_expirations = ["2026-05-23", "2026-06-20"]
    reply = await nats.request("marketdata.rpc.expirations.schwab", {"symbol": "SPY"})
    assert reply["expirations"] == ["2026-05-23", "2026-06-20"]


@pytest.mark.asyncio
async def test_chain_handler(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.next_chain = [
        Contract(
            symbol="SPY  260620C00515000",
            underlying="SPY",
            expiration="2026-06-20",
            side="call",
            strike=515.0,
            dte=31,
            bid=8.55,
            ask=8.7,
            mid=8.625,
            last=8.6,
            volume=4321,
            openInterest=15234,
            underlyingPrice=512.36,
            iv=0.187,
            delta=0.42,
            gamma=0.018,
            theta=-0.21,
            vega=0.53,
        )
    ]
    reply = await nats.request(
        "marketdata.rpc.chain.schwab",
        {"symbol": "SPY", "expiration": "2026-06-20"},
    )
    assert len(reply["chain"]) == 1
    assert reply["chain"][0]["strike"] == 515.0


@pytest.mark.asyncio
async def test_historical_chain_returns_not_supported(bridge: SchwabMdBridge) -> None:
    """Q4: Schwab REST has no historical chain endpoint — must answer not_supported."""
    nats = bridge._test_nats  # type: ignore[attr-defined]
    reply = await nats.request(
        "marketdata.rpc.historical_chain.schwab",
        {"symbol": "SPY", "date": "2026-05-13", "expiration": "2026-06-20"},
    )
    assert reply["error"]["code"] == "not_supported"


@pytest.mark.asyncio
async def test_candles_handler(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.next_candles = [
        Candle(
            date="2026-05-20",
            open=510.12,
            high=513.45,
            low=509.88,
            close=512.37,
            volume=78123456,
        ),
    ]
    reply = await nats.request(
        "marketdata.rpc.candles.schwab",
        {
            "symbol": "SPY",
            "from": "2026-05-15",
            "to": "2026-05-20",
            "frequency": "daily",
        },
    )
    assert len(reply["candles"]) == 1
    assert reply["candles"][0]["date"] == "2026-05-20"


# ── Heartbeat ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_heartbeat_publishes_periodically() -> None:
    nats = _FakeNats()
    rest = _FakeRest()
    b = SchwabMdBridge(nats=nats, rest=rest, heartbeat_interval_s=0.02)  # type: ignore[arg-type]
    await b.start()
    try:
        await asyncio.sleep(0.07)
        heartbeats = [
            p for (s, p) in nats.published if s == "marketdata.schwab.heartbeat"
        ]
        assert len(heartbeats) >= 2
        first = json.loads(heartbeats[0].decode("utf-8"))
        assert first["broker"] == "schwab"
        assert "ts" in first
    finally:
        await b.stop()


@pytest.mark.asyncio
async def test_heartbeat_records_upstream_success_ts_after_a_call(
    bridge: SchwabMdBridge,
) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    rest: _FakeRest = bridge._test_rest  # type: ignore[attr-defined]
    rest.next_expirations = ["2026-05-23"]
    await nats.request("marketdata.rpc.expirations.schwab", {"symbol": "SPY"})
    # Wait long enough for at least one heartbeat AFTER the call.
    await asyncio.sleep(0.08)
    heartbeats = [
        json.loads(p.decode("utf-8"))
        for (s, p) in nats.published
        if s == "marketdata.schwab.heartbeat"
    ]
    has_upstream = [hb for hb in heartbeats if hb.get("last_upstream_success_ts")]
    assert has_upstream, (
        f"no heartbeat carried last_upstream_success_ts; saw {heartbeats}"
    )


# ── Streamer publishers ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_publish_quote_uses_per_symbol_subject(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    await bridge.publish_quote("EQ:SPY", {"symbol": "EQ:SPY", "bid": 1.0})
    matching = [
        (s, json.loads(p.decode("utf-8")))
        for (s, p) in nats.published
        if s.startswith("marketdata.quotes.schwab.")
    ]
    assert matching == [
        ("marketdata.quotes.schwab.EQ:SPY", {"symbol": "EQ:SPY", "bid": 1.0})
    ]


@pytest.mark.asyncio
async def test_publish_trade_and_book_route_correctly(bridge: SchwabMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    await bridge.publish_trade("EQ:SPY", {"ts": "t", "price": 1.0, "size": 1.0})
    await bridge.publish_book("EQ:SPY", {"ts": "t", "bids": [], "asks": []})
    subjects = [s for (s, _) in nats.published]
    assert "marketdata.trades.schwab.EQ:SPY" in subjects
    assert "marketdata.book.schwab.EQ:SPY" in subjects


# ── Stop tears down subscriptions ─────────────────────────────────


@pytest.mark.asyncio
async def test_stop_unsubscribes_all_rpc_handlers() -> None:
    nats = _FakeNats()
    rest = _FakeRest()
    b = SchwabMdBridge(nats=nats, rest=rest, heartbeat_interval_s=0.05)  # type: ignore[arg-type]
    await b.start()
    assert (
        len(nats.handlers) == 5
    )  # quote, expirations, chain, historical_chain, candles
    await b.stop()
    assert len(nats.handlers) == 0
