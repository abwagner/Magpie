"""NT-backed `IbkrMdSession` implementation.

Wraps NT's `InteractiveBrokersDataClient` (registered on a `TradingNode`
shared with QF-240's `IbkrBrokerBridge`). The four behavioral data paths
the M13-01 spike validated (connectivity probes only; behavior left for
this module) are exercised here:

  (a) snapshot top-of-book quote
  (b) option chain by expiration
  (c) historical chain at a past date
  (d) streaming quotes

This module is **deliberately stubbed**: the bridge + tests don't depend on
NT runtime, and integration testing against a live Gateway is best done
during the operator-led ramp described in `docs/tdd/market-data-via-nt.md`
§6. The M13-06 PR ships this scaffold so the operator filling it in has a
checklist (the four paths) plus the typed surface (`IbkrMdSession`) the
bridge expects.

If any behavioral path fails during live integration, the Q1 Mitigation A
fallback (`@stoqey/ib`-via-Python shim for the failing path) gets
implemented in this file by routing the failing method to the fallback
client without disturbing the bridge or RPC contract.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ..wire import Candle, Contract, L2Book, Quote, TradePrint
from .session import IbkrMdSession, IbkrMdSessionError


class NtIbkrMdSession(IbkrMdSession):
    """Real-NT-backed `IbkrMdSession`.

    Construct with a reference to the shared `TradingNode` (or whatever
    handle NT's API uses to register a DataClient on the running node).
    Implementation deliberately left to operator-led integration; the
    methods raise `NotImplementedError` so any inadvertent production
    use is loud rather than silently wrong.
    """

    def __init__(self, *, trading_node: Any) -> None:
        self._node = trading_node
        # Real impl will pull the DataClient handle off the node and
        # build request-correlation maps for the streaming subscribe/
        # unsubscribe flows. NT's request_id / subscription_id semantics
        # determine the exact shape — see the M13-01 spike report and
        # NT docs at the version pinned in research/uv.lock.

    async def get_quote(self, symbol: str, *, fetched_at: str) -> Quote:
        raise NotImplementedError(
            "NtIbkrMdSession.get_quote — fill in during M13-06 integration. "
            "Use the DataClient request_quote_tick API; map NT's IBQuoteTick "
            "to wire.Quote. The M13-01 spike showed nextValidId in 45ms; "
            "expect snapshot latency <2s for SPY."
        )

    async def get_expirations(self, symbol: str) -> list[str]:
        raise NotImplementedError(
            "NtIbkrMdSession.get_expirations — fill in during M13-06 integration. "
            "NT exposes contract details via InstrumentProvider; iterate "
            "OPT contracts for the underlying and dedupe by expiry."
        )

    async def get_chain(
        self,
        symbol: str,
        expiration: str,
        *,
        fetched_at: str,
    ) -> list[Contract]:
        raise NotImplementedError(
            "NtIbkrMdSession.get_chain — fill in during M13-06 integration. "
            "Combine InstrumentProvider lookup + per-strike quote snapshot. "
            "Expect ~400ms for SPY's nearest expiration per spike notes."
        )

    async def get_historical_chain(
        self,
        symbol: str,
        date: str,
        expiration: str,
        *,
        fetched_at: str,
    ) -> list[Contract]:
        # The HIGHEST-RISK path per M13-01 §11 Q1. If this raises
        # IbkrMdSessionError(code="not_supported") in practice, the
        # Mitigation A fallback gets implemented here.
        raise NotImplementedError(
            "NtIbkrMdSession.get_historical_chain — fill in during M13-06 integration. "
            "NT's IB DataClient historical depth may not cover options chains. "
            "If it fails with 'not_supported' against a real Gateway, implement "
            "Mitigation A (@stoqey/ib-via-Python fallback) in this method."
        )

    async def get_candles(
        self,
        symbol: str,
        from_date: str,
        to_date: str,
        frequency: str | None = None,
    ) -> list[Candle]:
        raise NotImplementedError(
            "NtIbkrMdSession.get_candles — fill in during M13-06 integration. "
            "Use NT's DataClient.request_bars with BarSpecification matching "
            "the QF 'daily' | 'minute' frequency."
        )

    async def subscribe_quotes(self, symbol: str) -> AsyncIterator[Quote]:
        raise NotImplementedError(
            "NtIbkrMdSession.subscribe_quotes — fill in during M13-06 integration. "
            "Subscribe to NT MessageBus for the symbol's QuoteTick events; yield "
            "wire.Quote per tick."
        )

    async def subscribe_trades(self, symbol: str) -> AsyncIterator[TradePrint]:
        raise NotImplementedError(
            "NtIbkrMdSession.subscribe_trades — fill in during M13-06 integration."
        )

    async def subscribe_book(self, symbol: str) -> AsyncIterator[L2Book]:
        raise NotImplementedError(
            "NtIbkrMdSession.subscribe_book — fill in during M13-06 integration."
        )

    async def unsubscribe_quotes(self, symbol: str) -> None:
        raise NotImplementedError

    async def unsubscribe_trades(self, symbol: str) -> None:
        raise NotImplementedError

    async def unsubscribe_book(self, symbol: str) -> None:
        raise NotImplementedError


__all__ = ["NtIbkrMdSession", "IbkrMdSessionError"]
