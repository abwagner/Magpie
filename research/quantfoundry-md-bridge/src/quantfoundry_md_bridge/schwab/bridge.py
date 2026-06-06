"""Schwab MD NATS bridge.

The Python side of the QF↔Python MD-bridge contract for Schwab. Mirrors the
order-side ``SchwabBrokerBridge`` (QF-237) layout:

- NATS RPC subscribers (one per verb), translated to ``SchwabRestMdClient``
  calls.
- Heartbeat publisher loop.
- Streamer fan-out (quotes / trades / book) wired through the existing
  QF-164/165/166 parsers in ``quantfoundry_schwab_nt`` — full streamer
  bring-up is left to M13-05 streaming follow-up; this module exposes the
  publisher API that the streamer wiring will call.

Wire format + subjects per ``docs/tdd/market-data-via-nt.md`` §3.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from ..wire import (
    CandleFrequency,
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
from .rest_md_client import SchwabMdError, SchwabRestMdClient

logger = logging.getLogger(__name__)

_BROKER = "schwab"


# ── NATS surface (minimal protocol for testability) ──


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
    """All NATS subjects this bridge owns for a broker."""
    return {
        "quote": f"marketdata.rpc.quote.{broker}",
        "expirations": f"marketdata.rpc.expirations.{broker}",
        "chain": f"marketdata.rpc.chain.{broker}",
        "historical_chain": f"marketdata.rpc.historical_chain.{broker}",
        "candles": f"marketdata.rpc.candles.{broker}",
        "quotes_stream": f"marketdata.quotes.{broker}",
        "trades_stream": f"marketdata.trades.{broker}",
        "book_stream": f"marketdata.book.{broker}",
        "heartbeat": f"marketdata.{broker}.heartbeat",
    }


# ── Helpers — JSON wire encoding ──────────────────────────────────


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


class SchwabMdBridge:
    """NATS bridge for Schwab MD.

    Lifecycle::

        bridge = SchwabMdBridge(nats=nats, rest=rest)
        await bridge.start()
        # … bridge serves RPC + publishes heartbeats …
        await bridge.stop()
    """

    def __init__(
        self,
        *,
        nats: _NatsClient,
        rest: SchwabRestMdClient,
        heartbeat_interval_s: float = 10.0,
    ) -> None:
        self._nats = nats
        self._rest = rest
        self._subjects = subjects_for(_BROKER)
        self._subs: list[_NatsSubscription] = []
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._heartbeat_interval_s = heartbeat_interval_s
        self._last_upstream_success_ts: str | None = None
        self._stopped = False

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

    # ── RPC subscription wiring ──

    async def _subscribe_rpcs(self) -> None:
        self._subs.append(
            await self._nats.subscribe(self._subjects["quote"], self._handle_quote)
        )
        self._subs.append(
            await self._nats.subscribe(
                self._subjects["expirations"], self._handle_expirations
            )
        )
        self._subs.append(
            await self._nats.subscribe(self._subjects["chain"], self._handle_chain)
        )
        self._subs.append(
            await self._nats.subscribe(
                self._subjects["historical_chain"], self._handle_historical_chain
            )
        )
        self._subs.append(
            await self._nats.subscribe(self._subjects["candles"], self._handle_candles)
        )

    # ── Handlers ──

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
            quote = await self._rest.get_quote(req.symbol, fetched_at=fetched_at)
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(_encode(QuoteReply(quote=quote).to_dict()))
        except SchwabMdError as e:
            await msg.respond(
                _encode(QuoteReply(error=_err_frame(_classify(e), str(e))).to_dict())
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("schwab-md-bridge: unexpected quote error", exc_info=e)
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
            exps = await self._rest.get_expirations(req.symbol)
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(
                _encode(ExpirationsReply(expirations=tuple(exps)).to_dict())
            )
        except SchwabMdError as e:
            await msg.respond(
                _encode(
                    ExpirationsReply(error=_err_frame(_classify(e), str(e))).to_dict()
                )
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
            chain = await self._rest.get_chain(
                req.symbol, req.expiration, fetched_at=fetched_at
            )
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(_encode(ChainReply(chain=tuple(chain)).to_dict()))
        except SchwabMdError as e:
            await msg.respond(
                _encode(ChainReply(error=_err_frame(_classify(e), str(e))).to_dict())
            )

    async def _handle_historical_chain(self, msg: _NatsMessage) -> None:
        # Q4: Schwab REST does not expose historical chains. Return
        # not_supported so the TS service layer falls through to the
        # MarketData.app adapter per the existing routing.
        try:
            _ = HistoricalChainRequest.from_dict(_decode(msg.data))
        except (ValueError, KeyError) as e:
            await msg.respond(
                _encode(
                    HistoricalChainReply(error=_err_frame("internal", str(e))).to_dict()
                )
            )
            return
        await msg.respond(
            _encode(
                HistoricalChainReply(
                    error=_err_frame(
                        "not_supported",
                        "Schwab REST does not expose date-keyed historical chains",
                    )
                ).to_dict()
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
            freq: CandleFrequency | None = req.frequency
            candles = await self._rest.get_candles(
                req.symbol,
                req.fromDate,
                req.toDate,
                frequency=freq,
            )
            self._last_upstream_success_ts = _now_iso()
            await msg.respond(_encode(CandlesReply(candles=tuple(candles)).to_dict()))
        except SchwabMdError as e:
            await msg.respond(
                _encode(CandlesReply(error=_err_frame(_classify(e), str(e))).to_dict())
            )

    # ── Streamer fan-out (publisher API) ──
    #
    # The bridge exposes pure publisher methods that the streamer wiring
    # (a follow-on inside M13-05) calls when it parses Schwab streamer
    # frames using the QF-164/165/166 parsers in quantfoundry_schwab_nt.
    # Keeping them as instance methods means the streamer integration
    # only needs a reference to this bridge, not direct NATS coupling.

    async def publish_quote(self, symbol: str, quote_payload: dict[str, Any]) -> None:
        await self._nats.publish(
            f"{self._subjects['quotes_stream']}.{symbol}",
            _encode(quote_payload),
        )

    async def publish_trade(self, symbol: str, trade_payload: dict[str, Any]) -> None:
        await self._nats.publish(
            f"{self._subjects['trades_stream']}.{symbol}",
            _encode(trade_payload),
        )

    async def publish_book(self, symbol: str, book_payload: dict[str, Any]) -> None:
        await self._nats.publish(
            f"{self._subjects['book_stream']}.{symbol}",
            _encode(book_payload),
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
                logger.exception("schwab-md-bridge: heartbeat publish failed")
            try:
                await asyncio.sleep(self._heartbeat_interval_s)
            except asyncio.CancelledError:
                break


def _classify(e: SchwabMdError) -> str:
    """Map Schwab REST errors onto the ErrorFrame enum."""
    code = e.status_code
    if code == 401 or code == 403:
        return "auth_failed"
    if code == 429:
        return "rate_limited"
    if 500 <= code < 600:
        return "upstream_unavailable"
    return "internal"
