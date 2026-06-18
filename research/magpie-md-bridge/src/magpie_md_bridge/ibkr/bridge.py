"""IBKR MD NATS bridge.

The Python side of the QF↔Python MD-bridge contract for IBKR. Layout mirrors
``schwab.bridge.SchwabMdBridge`` but the upstream is NT's
``InteractiveBrokersDataClient`` instead of a custom REST + streamer client.

**Process composition (D8).** This bridge module is intended to load into the
*same Python process* as ``magpie-ibkr-nt``'s ``IbkrBrokerBridge``
(QF-240). IB Gateway permits only one TWS-API client per client-id; the MD
bridge and the order observer must coexist in one ``TradingNode`` runtime.
The shared systemd unit is at ``systemd/ibkr-md-bridge.service`` (this PR);
the order-side ``IbkrBrokerBridge`` initializes its own subjects in the same
process. See ``docs/tdd/market-data-via-nt.md`` §7.

Wire format + subjects per ``docs/tdd/market-data-via-nt.md`` §3.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from magpie_subjects import (
    marketdata_book,
    marketdata_heartbeat,
    marketdata_quotes,
    marketdata_rpc_candles,
    marketdata_rpc_chain,
    marketdata_rpc_expirations,
    marketdata_rpc_historical_chain,
    marketdata_rpc_quote,
    marketdata_trades,
)

from ..wire import (
    CandlesReply,
    CandlesRequest,
    ChainReply,
    ChainRequest,
    ErrorFrame,
    ExpirationsReply,
    ExpirationsRequest,
    Heartbeat,
    HistoricalChainReply,
    HistoricalChainRequest,
    QuoteReply,
    QuoteRequest,
)
from .session import IbkrMdSession, IbkrMdSessionError

logger = logging.getLogger(__name__)

_BROKER = "ibkr"


# ── NATS surface (minimal Protocol; same as Schwab bridge) ──


class _NatsMessage(Protocol):
    @property
    def data(self) -> bytes: ...

    async def respond(self, payload: bytes) -> None: ...


class _NatsSubscription(Protocol):
    async def unsubscribe(self) -> None: ...


class _NatsClient(Protocol):
    async def subscribe(
        self,
        subject: str,
        cb: Callable[[_NatsMessage], Awaitable[None]],
    ) -> _NatsSubscription: ...

    async def publish(self, subject: str, payload: bytes) -> None: ...

    async def flush(self) -> None: ...


# ── Subjects ─────────────────────────────────────────────────────────


def subjects_for(broker: str) -> dict[str, str]:
    return {
        "quote": marketdata_rpc_quote(broker),
        "expirations": marketdata_rpc_expirations(broker),
        "chain": marketdata_rpc_chain(broker),
        "historical_chain": marketdata_rpc_historical_chain(broker),
        "candles": marketdata_rpc_candles(broker),
        "quotes_stream": marketdata_quotes(broker),
        "trades_stream": marketdata_trades(broker),
        "book_stream": marketdata_book(broker),
        "heartbeat": marketdata_heartbeat(broker),
    }


# ── JSON helpers ────────────────────────────────────────────────────


def _encode(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload).encode("utf-8")


def _decode(raw: bytes) -> dict[str, Any]:
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"NATS payload not a dict: {type(parsed).__name__}")
    return parsed


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _err_frame(code: str, message: str) -> ErrorFrame:
    return ErrorFrame(code=code, message=message)  # type: ignore[arg-type]


# ── Bridge ──────────────────────────────────────────────────────────


@dataclass
class _StreamHandle:
    task: asyncio.Task[None]
    symbol: str


class IbkrMdBridge:
    """NATS bridge for IBKR MD via NT's IB DataClient.

    Lifecycle::

        bridge = IbkrMdBridge(nats=nats, session=session)
        await bridge.start()
        # … bridge serves RPC + publishes heartbeats + fans out streams …
        await bridge.stop()
    """

    def __init__(
        self,
        *,
        nats: _NatsClient,
        session: IbkrMdSession,
        heartbeat_interval_s: float = 10.0,
    ) -> None:
        self._nats = nats
        self._session = session
        self._subjects = subjects_for(_BROKER)
        self._subs: list[_NatsSubscription] = []
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._heartbeat_interval_s = heartbeat_interval_s
        self._last_upstream_success_ts: str | None = None
        self._stopped = False

        # Stream subscriptions are operator-initiated (per the TS adapter
        # subscribing on demand). The bridge doesn't subscribe to anything
        # by default; the QF TS subscription manager publishes "start
        # stream for symbol X" via a future control surface — for v1 the
        # bridge exposes `start_quote_stream(symbol)` etc. as callable
        # methods that an operator script or the streamer-wiring follow-up
        # can invoke. Streams are tracked here for clean teardown.
        self._quote_streams: dict[str, _StreamHandle] = {}
        self._trade_streams: dict[str, _StreamHandle] = {}
        self._book_streams: dict[str, _StreamHandle] = {}

    async def start(self) -> None:
        await self._subscribe_rpcs()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def stop(self) -> None:
        self._stopped = True
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._heartbeat_task
        for sub in self._subs:
            with contextlib.suppress(Exception):
                await sub.unsubscribe()
        self._subs.clear()
        # Cancel any active stream tasks.
        for streams in (self._quote_streams, self._trade_streams, self._book_streams):
            for handle in list(streams.values()):
                handle.task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await handle.task
            streams.clear()

    # ── RPC wiring ──

    async def _subscribe_rpcs(self) -> None:
        # nats-py: the 2nd positional arg to subscribe() is `queue`, not the
        # callback — the handler must be passed as `cb=`.
        self._subs.append(
            await self._nats.subscribe(self._subjects["quote"], cb=self._handle_quote)
        )
        self._subs.append(
            await self._nats.subscribe(
                self._subjects["expirations"], cb=self._handle_expirations
            )
        )
        self._subs.append(
            await self._nats.subscribe(self._subjects["chain"], cb=self._handle_chain)
        )
        self._subs.append(
            await self._nats.subscribe(
                self._subjects["historical_chain"], cb=self._handle_historical_chain
            )
        )
        self._subs.append(
            await self._nats.subscribe(
                self._subjects["candles"], cb=self._handle_candles
            )
        )

    # ── RPC handlers ──

    async def _handle_quote(self, msg: _NatsMessage) -> None:
        try:
            req = QuoteRequest.from_dict(_decode(msg.data))
        except (ValueError, KeyError) as e:
            await msg.respond(
                _encode(QuoteReply(error=_err_frame("internal", str(e))).to_dict())
            )
            return
        fetched_at = _now_iso()
        try:
            quote = await self._session.get_quote(req.symbol, fetched_at=fetched_at)
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(_encode(QuoteReply(quote=quote).to_dict()))
        except IbkrMdSessionError as e:
            await msg.respond(
                _encode(QuoteReply(error=_err_frame(e.code, str(e))).to_dict())
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("ibkr-md-bridge: unexpected quote error", exc_info=e)
            await msg.respond(
                _encode(QuoteReply(error=_err_frame("internal", str(e))).to_dict())
            )

    async def _handle_expirations(self, msg: _NatsMessage) -> None:
        try:
            req = ExpirationsRequest.from_dict(_decode(msg.data))
        except (ValueError, KeyError) as e:
            await msg.respond(
                _encode(
                    ExpirationsReply(error=_err_frame("internal", str(e))).to_dict()
                )
            )
            return
        try:
            exps = await self._session.get_expirations(req.symbol)
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(
                _encode(ExpirationsReply(expirations=tuple(exps)).to_dict())
            )
        except IbkrMdSessionError as e:
            await msg.respond(
                _encode(ExpirationsReply(error=_err_frame(e.code, str(e))).to_dict())
            )

    async def _handle_chain(self, msg: _NatsMessage) -> None:
        try:
            req = ChainRequest.from_dict(_decode(msg.data))
        except (ValueError, KeyError) as e:
            await msg.respond(
                _encode(ChainReply(error=_err_frame("internal", str(e))).to_dict())
            )
            return
        fetched_at = _now_iso()
        try:
            chain = await self._session.get_chain(
                req.symbol, req.expiration, fetched_at=fetched_at
            )
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(_encode(ChainReply(chain=tuple(chain)).to_dict()))
        except IbkrMdSessionError as e:
            await msg.respond(
                _encode(ChainReply(error=_err_frame(e.code, str(e))).to_dict())
            )

    async def _handle_historical_chain(self, msg: _NatsMessage) -> None:
        try:
            req = HistoricalChainRequest.from_dict(_decode(msg.data))
        except (ValueError, KeyError) as e:
            await msg.respond(
                _encode(
                    HistoricalChainReply(error=_err_frame("internal", str(e))).to_dict()
                )
            )
            return
        fetched_at = _now_iso()
        try:
            chain = await self._session.get_historical_chain(
                req.symbol, req.date, req.expiration, fetched_at=fetched_at
            )
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(
                _encode(HistoricalChainReply(chain=tuple(chain)).to_dict())
            )
        except IbkrMdSessionError as e:
            await msg.respond(
                _encode(
                    HistoricalChainReply(error=_err_frame(e.code, str(e))).to_dict()
                )
            )

    async def _handle_candles(self, msg: _NatsMessage) -> None:
        try:
            req = CandlesRequest.from_dict(_decode(msg.data))
        except (ValueError, KeyError) as e:
            await msg.respond(
                _encode(CandlesReply(error=_err_frame("internal", str(e))).to_dict())
            )
            return
        try:
            candles = await self._session.get_candles(
                req.symbol, req.fromDate, req.toDate, frequency=req.frequency
            )
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(_encode(CandlesReply(candles=tuple(candles)).to_dict()))
        except IbkrMdSessionError as e:
            await msg.respond(
                _encode(CandlesReply(error=_err_frame(e.code, str(e))).to_dict())
            )

    # ── Streaming control ──
    #
    # The TS side subscribes per-symbol; M13-04's nt-bridge-md.ts adapter
    # opens a NATS sub on the per-symbol subject and expects events to
    # appear. For v1 the bridge exposes start/stop methods that an
    # operator script (or the streamer-wiring follow-up) calls. A future
    # ticket can add a `marketdata.rpc.subscribe.ibkr` RPC that takes a
    # symbol list — out of scope for M13-06.

    async def start_quote_stream(self, symbol: str) -> None:
        if symbol in self._quote_streams:
            return  # idempotent
        task = asyncio.create_task(self._pump_quotes(symbol))
        self._quote_streams[symbol] = _StreamHandle(task=task, symbol=symbol)

    async def stop_quote_stream(self, symbol: str) -> None:
        handle = self._quote_streams.pop(symbol, None)
        if handle is None:
            return
        handle.task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await handle.task
        await self._session.unsubscribe_quotes(symbol)

    async def start_trade_stream(self, symbol: str) -> None:
        if symbol in self._trade_streams:
            return
        task = asyncio.create_task(self._pump_trades(symbol))
        self._trade_streams[symbol] = _StreamHandle(task=task, symbol=symbol)

    async def stop_trade_stream(self, symbol: str) -> None:
        handle = self._trade_streams.pop(symbol, None)
        if handle is None:
            return
        handle.task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await handle.task
        await self._session.unsubscribe_trades(symbol)

    async def start_book_stream(self, symbol: str) -> None:
        if symbol in self._book_streams:
            return
        task = asyncio.create_task(self._pump_book(symbol))
        self._book_streams[symbol] = _StreamHandle(task=task, symbol=symbol)

    async def stop_book_stream(self, symbol: str) -> None:
        handle = self._book_streams.pop(symbol, None)
        if handle is None:
            return
        handle.task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await handle.task
        await self._session.unsubscribe_book(symbol)

    async def _pump_quotes(self, symbol: str) -> None:
        subject = f"{self._subjects['quotes_stream']}.{symbol}"
        try:
            async for quote in await self._session.subscribe_quotes(symbol):
                await self._nats.publish(subject, _encode(quote.to_dict()))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception(
                "ibkr-md-bridge: quote stream failed", extra={"symbol": symbol}
            )

    async def _pump_trades(self, symbol: str) -> None:
        subject = f"{self._subjects['trades_stream']}.{symbol}"
        try:
            async for trade in await self._session.subscribe_trades(symbol):
                await self._nats.publish(subject, _encode(trade.to_dict()))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception(
                "ibkr-md-bridge: trade stream failed", extra={"symbol": symbol}
            )

    async def _pump_book(self, symbol: str) -> None:
        subject = f"{self._subjects['book_stream']}.{symbol}"
        try:
            async for book in await self._session.subscribe_book(symbol):
                await self._nats.publish(subject, _encode(book.to_dict()))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception(
                "ibkr-md-bridge: book stream failed", extra={"symbol": symbol}
            )

    # ── Heartbeat ──

    async def _heartbeat_loop(self) -> None:
        while not self._stopped:
            try:
                hb = Heartbeat(
                    broker=_BROKER,
                    ts=_now_iso(),
                    last_upstream_success_ts=self._last_upstream_success_ts,
                )
                await self._nats.publish(
                    self._subjects["heartbeat"], _encode(hb.to_dict())
                )
            except Exception:  # noqa: BLE001
                logger.exception("ibkr-md-bridge: heartbeat publish failed")
            try:
                await asyncio.sleep(self._heartbeat_interval_s)
            except asyncio.CancelledError:
                break
