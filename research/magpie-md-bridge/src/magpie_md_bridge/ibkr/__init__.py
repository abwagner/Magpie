"""IBKR MD bridge.

NT-backed market-data service. Wraps NT's `InteractiveBrokersDataClient` via
the `IbkrMdSession` protocol abstraction (mirrors the
`IbkrSessionClient` pattern in `magpie-ibkr-nt`).

**Process composition** (per `docs/tdd/market-data-via-nt.md` §7): the
combined `ibkr-md-bridge.service` systemd unit loads QF-240's
`IbkrBrokerBridge` (orders) and this module's `IbkrMdBridge` (market data)
into one `TradingNode` runtime, sharing a single IB Gateway TWS-API client.

NATS subjects:
- `marketdata.rpc.{quote,expirations,chain,historical_chain,candles}.ibkr`
- `marketdata.{quotes,trades,book}.ibkr.<SYMBOL>`
- `marketdata.ibkr.heartbeat`
"""

from .bridge import IbkrMdBridge, subjects_for
from .nt_session import NtIbkrMdSession
from .session import IbkrMdSession, IbkrMdSessionError

__all__ = [
    "IbkrMdBridge",
    "IbkrMdSession",
    "IbkrMdSessionError",
    "NtIbkrMdSession",
    "subjects_for",
]
