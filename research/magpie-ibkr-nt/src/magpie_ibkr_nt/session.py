"""IBKR session abstraction (QF-240, QF-353).

NT's upstream ``nautilus_trader.adapters.interactive_brokers`` does the
heavy lifting against IB Gateway. This module defines the small surface
the QF broker bridge actually consumes from that adapter so the bridge
can be unit-tested without pulling NT in, and production wires the real
NT adapter behind the Protocol.

Mirrors ``magpie-schwab-nt``'s split: data + Protocol here, the
NATS service in :mod:`magpie_ibkr_nt.broker_bridge`.

QF-353 added the order-submission surface (``submit_order`` /
``cancel_order``) so the IBKR bundle is symmetric with Schwab — every
broker bundle owns every ``orders.*`` subject per
``docs/tdd/broker-integration.md §3.1``. The session client wraps NT's
``InteractiveBrokersExecutionClient`` (production) or a fake (tests).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# IBKR event-stream kinds the bridge maps to QF's BrokerExecReport. The
# Protocol's event source yields rows with one of these `kind` values;
# unknown kinds get dropped by the bridge with a warning.
IbkrEventKind = (
    "submitted | filled | partial_fill | cancelled | rejected | replaced | raw"
)


# ── Data shapes ───────────────────────────────────────────────────


@dataclass(frozen=True)
class IbkrOrder:
    """Normalized view of an IB order, returned by ``query_order``.

    Pulled out of NT's upstream order shape so the bridge code doesn't
    depend on NT's internals. NT-specific fields the bridge doesn't
    need stay in ``raw``.
    """

    broker_order_id: str
    # IBKR's order status string — one of "Submitted", "PreSubmitted",
    # "PendingSubmit", "PendingCancel", "Cancelled", "Filled",
    # "ApiCancelled", "Inactive". The bridge maps these to the
    # broker-agnostic BrokerOrderStatus union in wire.py.
    status: str
    quantity: float
    filled_quantity: float
    average_fill_price: float | None = None
    rejection_reason: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class IbkrPosition:
    """Normalized view of an IB position, returned by ``list_positions``."""

    # IB instrument identifier. IB has multiple symbol formats
    # (conid, localSymbol, symbol); the bridge expects ``symbol`` here
    # to be the same string QF uses when correlating positions with
    # audit_orders. NT typically exposes ``Instrument.id.symbol``.
    symbol: str
    quantity: float  # Signed: positive = long, negative = short.
    average_cost: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class IbkrEvent:
    """One row from the IB exec-event stream.

    NT's IB adapter exposes order events via ``MessageBus`` /
    ``OrderEvent`` callbacks. The session client (production) translates
    those into IbkrEvent rows that the bridge consumes asynchronously.

    For fill events, ``fill_*`` fields are populated; for rejection
    events, ``rejection_reason`` carries the IB ``errorString``.
    """

    kind: str  # one of IbkrEventKind values
    broker_order_id: str | None
    ts: str  # ISO-8601 from the IB event
    # Fill payload (set when kind ∈ {"filled", "partial_fill"})
    fill_id: str | None = None
    fill_price: float | None = None
    fill_quantity: float | None = None
    fill_fees: float | None = None
    # Rejection payload (set when kind == "rejected")
    rejection_reason: str | None = None
    ib_error_code: int | None = None
    # IBKR's full raw event; bridge consumers don't read it but
    # debugging and tests can inspect it.
    raw_payload: dict[str, Any] = field(default_factory=dict)


# ── Errors ────────────────────────────────────────────────────────


class IbkrSessionError(Exception):
    """Raised by IbkrSessionClient on transport / protocol failures."""


class IbkrOrderNotFoundError(IbkrSessionError):
    """Raised by ``query_order`` when IB doesn't recognize the id.

    The bridge translates this to ``BrokerOrderStatus(status="unknown")``
    per the reconciliation contract in
    ``docs/tdd/broker-integration.md §5``.
    """


# ── Protocol ──────────────────────────────────────────────────────


class IbkrSessionClient(Protocol):
    """The surface the bridge consumes from NT's IB adapter.

    Production constructs this around ``nautilus_trader.adapters.interactive_brokers``;
    tests pass a fake. Covers both the submission half (``submit_order`` /
    ``cancel_order``, added in QF-353) and the observation half
    (``query_order`` / ``list_positions``), keeping the IBKR bundle
    symmetric with Schwab per ``docs/tdd/broker-integration.md §3.1``.
    """

    async def submit_order(self, body: dict[str, Any]) -> str:
        """Place an order on IB Gateway and return its broker order id.

        ``body`` is the normalized order spec produced by
        :func:`magpie_ibkr_nt.broker_bridge.intent_to_ibkr_body`;
        the session client translates it into an NT ``Order`` +
        ``Contract`` and submits via NT's execution client. Raises
        :class:`IbkrSessionError` on transport / API failure."""
        ...

    async def cancel_order(self, broker_order_id: str) -> None:
        """Request cancellation of a working order. Idempotent: cancelling
        an already-terminal order is a no-op. Raises
        :class:`IbkrSessionError` on transport / API failure."""
        ...

    async def query_order(self, broker_order_id: str) -> IbkrOrder:
        """Return the IB-side state of an order. Raises
        :class:`IbkrOrderNotFoundError` for unknown ids."""
        ...

    async def list_positions(self) -> list[IbkrPosition]:
        """Snapshot of IB Gateway's current positions for the
        gateway-logged-in account."""
        ...


# ── IBKR errorCode filter (rejection-class) ───────────────────────

# IB's ``errorMsg(reqId, errorCode, errorString)`` covers everything
# from informational notices to fatal rejection. The bridge only emits
# BrokerExecReport(event="rejected") for codes that are actually
# rejection-class. Source: IB API documentation "errorCodes" reference.
#
# We keep the list narrow and explicit rather than exhaustive — IB has
# 1000+ codes and many are connection / data warnings. New codes can
# be added when operator forensics show an unhandled rejection.
IBKR_REJECTION_ERROR_CODES: frozenset[int] = frozenset(
    {
        201,  # Order rejected — reason in errorString
        202,  # Order cancelled — reason in errorString (operator/system)
        203,  # The security <X> is not available or allowed for this account
        382,  # Order size <X> is smaller than the minimum lot size <Y>
        383,  # Order size <X> exceeds the maximum lot size <Y>
        388,  # Order quantity is below the minimum requirement
        434,  # The order size cannot be zero
        478,  # Buy attempt failed: invalid order side
        2148,  # Order quantity rounds to zero — IB rejected
    }
)


def is_rejection_error_code(error_code: int) -> bool:
    """Filter for IB ``errorMsg`` events: True iff the code is
    rejection-class. Non-rejection codes (market-data farm disconnect,
    historical data warning, etc.) get dropped by the bridge."""
    return error_code in IBKR_REJECTION_ERROR_CODES


__all__ = [
    "IBKR_REJECTION_ERROR_CODES",
    "IbkrEvent",
    "IbkrOrder",
    "IbkrOrderNotFoundError",
    "IbkrPosition",
    "IbkrSessionClient",
    "IbkrSessionError",
    "is_rejection_error_code",
]
