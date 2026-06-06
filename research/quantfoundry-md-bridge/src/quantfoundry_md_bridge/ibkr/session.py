"""Protocol abstraction over NT's `InteractiveBrokersDataClient`.

The bridge (`bridge.py`) holds a reference to an `IbkrMdSession` rather than
to NT directly so the bridge is testable without an IB Gateway. The real
NT-backed implementation lives in `nt_session.py`; tests pass a fake.

Mirrors the `IbkrSessionClient` protocol pattern in
`quantfoundry-ibkr-nt/src/quantfoundry_ibkr_nt/session.py` (QF-240).

The M13-01 spike validated that NT's IB DataClient + ibapi + paper Gateway
all line up. The four behavioral data paths covered here (snapshot quote,
chain by expiration, historical chain, streaming) are wired against that
DataClient inside `nt_session.py`. If any path fails behaviorally against
the live Gateway during M13-06 integration testing, the Q1 Mitigation A
fallback (per-path `@stoqey/ib` shim) gets implemented here in `nt_session.py`
without touching the bridge or RPC contract.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Protocol, runtime_checkable

from ..wire import Candle, Contract, L2Book, Quote, TradePrint


@runtime_checkable
class IbkrMdSession(Protocol):
    """The NT-facing surface the bridge depends on.

    Implementations:
    - `nt_session.NtIbkrMdSession` — real, backed by
      `nautilus_trader.adapters.interactive_brokers.InteractiveBrokersDataClient`
      sharing a TradingNode with QF-240's `IbkrBrokerBridge`.
    - `tests.fakes.FakeIbkrMdSession` — async generators for streaming + canned
      RPC responses for unit tests.
    """

    # ── Snapshot endpoints (RPC backing) ──────────────────────────────

    async def get_quote(self, symbol: str, *, fetched_at: str) -> Quote: ...

    async def get_expirations(self, symbol: str) -> list[str]: ...

    async def get_chain(
        self,
        symbol: str,
        expiration: str,
        *,
        fetched_at: str,
    ) -> list[Contract]: ...

    async def get_historical_chain(
        self,
        symbol: str,
        date: str,
        expiration: str,
        *,
        fetched_at: str,
    ) -> list[Contract]: ...

    async def get_candles(
        self,
        symbol: str,
        from_date: str,
        to_date: str,
        frequency: str | None = None,
    ) -> list[Candle]: ...

    # ── Streaming (the bridge fans these out onto NATS) ──────────────
    #
    # Implementations yield events for the lifetime of the subscription.
    # On Gateway disconnect / shutdown the iterators should complete cleanly
    # (the bridge breaks out of its consumer loop on StopAsyncIteration). The
    # bridge enforces idempotent unsubscribe; the session must be safe to
    # call subscribe_<x>() twice for the same symbol.

    async def subscribe_quotes(self, symbol: str) -> AsyncIterator[Quote]: ...

    async def subscribe_trades(self, symbol: str) -> AsyncIterator[TradePrint]: ...

    async def subscribe_book(self, symbol: str) -> AsyncIterator[L2Book]: ...

    async def unsubscribe_quotes(self, symbol: str) -> None: ...

    async def unsubscribe_trades(self, symbol: str) -> None: ...

    async def unsubscribe_book(self, symbol: str) -> None: ...


class IbkrMdSessionError(Exception):
    """Raised by `IbkrMdSession` impls on upstream NT/Gateway failures.

    Carries a coarse `code` so the bridge can translate to the right
    `ErrorFrame` for the NATS reply (see TDD §3.4 enum).
    """

    def __init__(self, message: str, *, code: str, detail: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail
