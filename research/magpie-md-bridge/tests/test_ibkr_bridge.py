"""IbkrMdBridge unit tests — fake NATS + fake IbkrMdSession.

Mirrors the SchwabMdBridge test layout (M13-05) but exercises the NT-backed
shape: a session that raises typed `IbkrMdSessionError` on upstream failures
and yields events on the streaming methods.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
from magpie_md_bridge.ibkr.bridge import IbkrMdBridge, subjects_for
from magpie_md_bridge.ibkr.session import IbkrMdSession, IbkrMdSessionError
from magpie_md_bridge.wire import (
    Candle,
    Contract,
    DataMeta,
    L2Book,
    L2Level,
    Quote,
    TradePrint,
)

# ── Fake NATS (same shape as the Schwab bridge tests) ──


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
        handler = self.handlers[subject]
        fut: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()
        await handler(
            _FakeMsg(data=json.dumps(payload).encode("utf-8"), _reply_future=fut)
        )
        raw = await fut
        return json.loads(raw.decode("utf-8"))


# ── Fake IbkrMdSession ──


class _FakeSession(IbkrMdSession):
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.next_quote: Quote | None = None
        self.next_expirations: list[str] = []
        self.next_chain: list[Contract] = []
        self.next_historical_chain: list[Contract] = []
        self.next_candles: list[Candle] = []
        self.error: IbkrMdSessionError | None = None
        # Async queues backing the streaming subscriptions.
        self._quote_q: dict[str, asyncio.Queue[Quote | None]] = {}
        self._trade_q: dict[str, asyncio.Queue[TradePrint | None]] = {}
        self._book_q: dict[str, asyncio.Queue[L2Book | None]] = {}

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

    async def get_historical_chain(
        self,
        symbol: str,
        date: str,
        expiration: str,
        *,
        fetched_at: str,
    ) -> list[Contract]:
        self.calls.append(
            ("get_historical_chain", (symbol, date, expiration, fetched_at))
        )
        if self.error:
            raise self.error
        return self.next_historical_chain

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

    # Streaming — async iterators backed by per-symbol queues; tests push
    # via `push_quote(symbol, q)`, then close with `close_quote(symbol)`.

    async def subscribe_quotes(self, symbol: str) -> AsyncIterator[Quote]:
        q = self._quote_q.setdefault(symbol, asyncio.Queue())
        return _drain_queue(q)

    async def subscribe_trades(self, symbol: str) -> AsyncIterator[TradePrint]:
        q = self._trade_q.setdefault(symbol, asyncio.Queue())
        return _drain_queue(q)

    async def subscribe_book(self, symbol: str) -> AsyncIterator[L2Book]:
        q = self._book_q.setdefault(symbol, asyncio.Queue())
        return _drain_queue(q)

    async def unsubscribe_quotes(self, symbol: str) -> None:
        q = self._quote_q.get(symbol)
        if q is not None:
            await q.put(None)

    async def unsubscribe_trades(self, symbol: str) -> None:
        q = self._trade_q.get(symbol)
        if q is not None:
            await q.put(None)

    async def unsubscribe_book(self, symbol: str) -> None:
        q = self._book_q.get(symbol)
        if q is not None:
            await q.put(None)

    # Test pushes
    async def push_quote(self, symbol: str, quote: Quote) -> None:
        q = self._quote_q.setdefault(symbol, asyncio.Queue())
        await q.put(quote)

    async def push_trade(self, symbol: str, trade: TradePrint) -> None:
        q = self._trade_q.setdefault(symbol, asyncio.Queue())
        await q.put(trade)

    async def push_book(self, symbol: str, book: L2Book) -> None:
        q = self._book_q.setdefault(symbol, asyncio.Queue())
        await q.put(book)


async def _drain_queue(q: asyncio.Queue[Any]) -> AsyncIterator[Any]:
    while True:
        item = await q.get()
        if item is None:
            return
        yield item


# ── Fixtures ──


def _sample_quote(symbol: str = "IBKR:SPY") -> Quote:
    return Quote(
        symbol=symbol,
        bid=512.34,
        ask=512.38,
        mid=512.36,
        last=512.37,
        volume=12345678.0,
        timestamp="2026-05-21T13:00:00Z",
        meta=DataMeta(
            source="ibkr",
            source_timestamp="2026-05-21T13:00:00Z",
            fetched_at="2026-05-21T13:00:00.123Z",
            freshness_ms=None,
            latency_ms=0.0,
            from_cache=False,
            cache_age_ms=0.0,
            sources_tried=("ibkr",),
        ),
    )


@pytest.fixture
async def bridge() -> IbkrMdBridge:
    nats = _FakeNats()
    session = _FakeSession()
    b = IbkrMdBridge(nats=nats, session=session, heartbeat_interval_s=0.05)  # type: ignore[arg-type]
    await b.start()
    b._test_nats = nats  # type: ignore[attr-defined]
    b._test_session = session  # type: ignore[attr-defined]
    yield b
    await b.stop()


# ── Subjects ──


def test_subjects_for_ibkr() -> None:
    s = subjects_for("ibkr")
    assert s["quote"] == "marketdata.rpc.quote.ibkr"
    assert s["historical_chain"] == "marketdata.rpc.historical_chain.ibkr"
    assert s["heartbeat"] == "marketdata.ibkr.heartbeat"
    assert s["quotes_stream"] == "marketdata.quotes.ibkr"


# ── RPC dispatch ──


@pytest.mark.asyncio
async def test_quote_handler_happy_path(bridge: IbkrMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    session: _FakeSession = bridge._test_session  # type: ignore[attr-defined]
    session.next_quote = _sample_quote()
    reply = await nats.request("marketdata.rpc.quote.ibkr", {"symbol": "IBKR:SPY"})
    assert "quote" in reply
    assert reply["quote"]["bid"] == 512.34


@pytest.mark.asyncio
async def test_quote_handler_maps_session_error_to_frame(bridge: IbkrMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    session: _FakeSession = bridge._test_session  # type: ignore[attr-defined]
    session.error = IbkrMdSessionError(
        "gateway disconnected", code="upstream_unavailable"
    )
    reply = await nats.request("marketdata.rpc.quote.ibkr", {"symbol": "IBKR:SPY"})
    assert reply["error"]["code"] == "upstream_unavailable"


@pytest.mark.asyncio
async def test_historical_chain_uses_session_implementation(
    bridge: IbkrMdBridge,
) -> None:
    """IBKR does support historical chains (NT IB DataClient — pending live verify).
    Unlike Schwab, this verb is NOT hard-coded to not_supported. The session
    decides; if NT proves unable to serve, Mitigation A in nt_session.py.
    """
    nats = bridge._test_nats  # type: ignore[attr-defined]
    session: _FakeSession = bridge._test_session  # type: ignore[attr-defined]
    session.next_historical_chain = [
        Contract(
            symbol="OPT:SPY:2026-06-20:C:515",
            underlying="SPY",
            expiration="2026-06-20",
            side="call",
            strike=515.0,
            dte=31,
            bid=8.5,
            ask=8.7,
            mid=8.6,
            last=8.6,
            volume=100.0,
            openInterest=1000.0,
            underlyingPrice=512.0,
            iv=0.18,
            delta=0.42,
            gamma=0.018,
            theta=-0.21,
            vega=0.53,
        )
    ]
    reply = await nats.request(
        "marketdata.rpc.historical_chain.ibkr",
        {"symbol": "IBKR:SPY", "date": "2026-05-13", "expiration": "2026-06-20"},
    )
    assert "chain" in reply
    assert len(reply["chain"]) == 1


@pytest.mark.asyncio
async def test_historical_chain_returns_not_supported_when_session_says_so(
    bridge: IbkrMdBridge,
) -> None:
    """Mitigation A path: if nt_session decides historical chain is unreachable,
    it raises IbkrMdSessionError(code='not_supported'); the bridge surfaces it."""
    nats = bridge._test_nats  # type: ignore[attr-defined]
    session: _FakeSession = bridge._test_session  # type: ignore[attr-defined]
    session.error = IbkrMdSessionError(
        "NT IB DataClient lacks historical chains", code="not_supported"
    )
    reply = await nats.request(
        "marketdata.rpc.historical_chain.ibkr",
        {"symbol": "IBKR:SPY", "date": "2026-05-13", "expiration": "2026-06-20"},
    )
    assert reply["error"]["code"] == "not_supported"


@pytest.mark.asyncio
async def test_candles_handler(bridge: IbkrMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    session: _FakeSession = bridge._test_session  # type: ignore[attr-defined]
    session.next_candles = [
        Candle(
            date="2026-05-20",
            open=510.0,
            high=513.0,
            low=509.0,
            close=512.0,
            volume=1_000_000,
        ),
    ]
    reply = await nats.request(
        "marketdata.rpc.candles.ibkr",
        {
            "symbol": "IBKR:SPY",
            "from": "2026-05-15",
            "to": "2026-05-20",
            "frequency": "daily",
        },
    )
    assert len(reply["candles"]) == 1
    assert reply["candles"][0]["close"] == 512.0


@pytest.mark.asyncio
async def test_expirations_handler(bridge: IbkrMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    session: _FakeSession = bridge._test_session  # type: ignore[attr-defined]
    session.next_expirations = ["2026-05-23", "2026-06-20"]
    reply = await nats.request(
        "marketdata.rpc.expirations.ibkr", {"symbol": "IBKR:SPY"}
    )
    assert reply["expirations"] == ["2026-05-23", "2026-06-20"]


@pytest.mark.asyncio
async def test_handler_internal_error_on_malformed_request(
    bridge: IbkrMdBridge,
) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    reply = await nats.request("marketdata.rpc.quote.ibkr", {})  # missing symbol
    assert reply["error"]["code"] == "internal"


# ── Heartbeat ──


@pytest.mark.asyncio
async def test_heartbeat_publishes_periodically() -> None:
    nats = _FakeNats()
    session = _FakeSession()
    b = IbkrMdBridge(nats=nats, session=session, heartbeat_interval_s=0.02)  # type: ignore[arg-type]
    await b.start()
    try:
        await asyncio.sleep(0.07)
        heartbeats = [
            p for (s, p) in nats.published if s == "marketdata.ibkr.heartbeat"
        ]
        assert len(heartbeats) >= 2
        first = json.loads(heartbeats[0].decode("utf-8"))
        assert first["broker"] == "ibkr"
    finally:
        await b.stop()


# ── Streaming ──


@pytest.mark.asyncio
async def test_start_quote_stream_publishes_per_symbol(bridge: IbkrMdBridge) -> None:
    nats = bridge._test_nats  # type: ignore[attr-defined]
    session: _FakeSession = bridge._test_session  # type: ignore[attr-defined]
    await bridge.start_quote_stream("IBKR:SPY")
    await session.push_quote("IBKR:SPY", _sample_quote("IBKR:SPY"))
    # Let the pump task run.
    for _ in range(5):
        await asyncio.sleep(0)
    quote_pubs = [
        (s, json.loads(p.decode("utf-8")))
        for (s, p) in nats.published
        if s.startswith("marketdata.quotes.ibkr.")
    ]
    assert quote_pubs, f"no quote events published; saw {nats.published}"
    subject, body = quote_pubs[0]
    assert subject == "marketdata.quotes.ibkr.IBKR:SPY"
    assert body["bid"] == 512.34


@pytest.mark.asyncio
async def test_start_quote_stream_is_idempotent(bridge: IbkrMdBridge) -> None:
    await bridge.start_quote_stream("IBKR:SPY")
    await bridge.start_quote_stream("IBKR:SPY")  # second call should no-op
    # Internal: only one stream task should exist.
    assert len(bridge._quote_streams) == 1  # noqa: SLF001


@pytest.mark.asyncio
async def test_stop_quote_stream_cancels_task_and_unsubscribes(
    bridge: IbkrMdBridge,
) -> None:
    await bridge.start_quote_stream("IBKR:SPY")
    assert "IBKR:SPY" in bridge._quote_streams  # noqa: SLF001
    await bridge.stop_quote_stream("IBKR:SPY")
    assert "IBKR:SPY" not in bridge._quote_streams  # noqa: SLF001


@pytest.mark.asyncio
async def test_trade_and_book_streams() -> None:
    nats = _FakeNats()
    session = _FakeSession()
    b = IbkrMdBridge(nats=nats, session=session, heartbeat_interval_s=999)  # type: ignore[arg-type]
    await b.start()
    try:
        await b.start_trade_stream("IBKR:SPY")
        await b.start_book_stream("IBKR:SPY")
        await session.push_trade(
            "IBKR:SPY", TradePrint(ts="2026-05-21T13:00:00Z", price=512.5, size=10)
        )
        await session.push_book(
            "IBKR:SPY",
            L2Book(
                ts="2026-05-21T13:00:00Z",
                bids=(L2Level(price=512.3, size=100),),
                asks=(L2Level(price=512.4, size=80),),
            ),
        )
        for _ in range(5):
            await asyncio.sleep(0)
        subjects = [s for (s, _) in nats.published]
        assert "marketdata.trades.ibkr.IBKR:SPY" in subjects
        assert "marketdata.book.ibkr.IBKR:SPY" in subjects
    finally:
        await b.stop()


# ── Stop ──


@pytest.mark.asyncio
async def test_stop_clears_all_subscriptions_and_streams() -> None:
    nats = _FakeNats()
    session = _FakeSession()
    b = IbkrMdBridge(nats=nats, session=session, heartbeat_interval_s=0.05)  # type: ignore[arg-type]
    await b.start()
    assert len(nats.handlers) == 5
    await b.start_quote_stream("IBKR:SPY")
    await b.stop()
    assert len(nats.handlers) == 0
    assert len(b._quote_streams) == 0  # noqa: SLF001
