"""Parse Schwab ACCT_ACTIVITY streamer frames into typed exec events.

QF-162's streaming lifecycle delivers `data` frames into a
:class:`Subscription` queue; this module converts each frame into a
typed :class:`OrderEvent` the NT exec layer can route. Pure parsing,
no I/O — the consumer reads the subscription queue and feeds rows
through :func:`parse_account_activity_row`.

Schwab's ACCT_ACTIVITY contract (per the QF-160 spike):
- Field "1": account number (plain, not the hash)
- Field "2": message type — see :data:`ACCT_ACTIVITY_MESSAGE_TYPES`
- Field "3": message data — JSON string (decoded by this module if it
  comes through as a string) carrying the order/fill payload

Message types are documented in the Schwab developer portal. We model
the order-lifecycle ones here; unknown types fall through to
:class:`RawActivityEvent` so the consumer can log + diagnose without
the parser short-circuiting.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

from quantfoundry_schwab_nt.order_status import NTOrderStatus, derive_order_status

# Message types we recognise. Other types still surface, just via
# :class:`RawActivityEvent` rather than a typed dataclass.
ACCT_ACTIVITY_MESSAGE_TYPES = frozenset(
    {
        "SUBSCRIBED",  # subscription confirmation, not order-related
        "ERROR",
        "OrderEntryRequest",
        "OrderActivation",
        "OrderFill",
        "OrderPartialFill",
        "OrderRejection",
        "OrderCancelRequest",
        "OrderCancelReplaceRequest",
        "OrderRouteMessage",
        "BrokenTrade",
        "ManualExecution",
        "TooLateToCancel",
        "UROUT",
    }
)

OrderEventKind = Literal[
    "submitted",
    "accepted",
    "partial_fill",
    "filled",
    "canceled",
    "rejected",
    "replaced",
    "raw",
    "subscribed",
    "error",
]


# ── Event types ───────────────────────────────────────────────────


@dataclass(frozen=True)
class OrderEvent:
    """Base for parsed ACCT_ACTIVITY events.

    ``kind`` is the narrowest classification the parser can give; the
    NT adapter uses it to dispatch to NT's typed event constructors
    (`OrderSubmitted`, `OrderFilled`, …).
    """

    kind: OrderEventKind
    account_number: str
    message_type: str
    order_id: str | None = None
    raw_payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class FillEvent(OrderEvent):
    """`OrderFill` / `OrderPartialFill` event with the fill details."""

    fill_quantity: float = 0.0
    fill_price: float = 0.0
    cumulative_filled: float = 0.0
    remaining_quantity: float = 0.0
    derived_status: NTOrderStatus = "FILLED"  # FILLED or PARTIALLY_FILLED


@dataclass(frozen=True)
class CancelReplaceEvent(OrderEvent):
    """`OrderCancelReplaceRequest` — replacement of an existing order.

    Schwab's contract: the OLD order goes terminal (CANCELED/REPLACED);
    a NEW order is created with a fresh orderId.
    """

    new_order_id: str | None = None
    old_order_id: str | None = None


@dataclass(frozen=True)
class RawActivityEvent(OrderEvent):
    """Fallback for unknown or unparseable message types."""

    error: str | None = None


# ── Parser ────────────────────────────────────────────────────────


def parse_account_activity_row(row: dict[str, Any]) -> OrderEvent:
    """Parse one ACCT_ACTIVITY content row into a typed event.

    ``row`` is one element of the ``data[i].content[]`` array QF-162's
    streamer delivers. Unknown shapes return a :class:`RawActivityEvent`
    rather than raising — the consumer logs + skips, never blocks.
    """
    account_number = str(row.get("1") or "")
    message_type = str(row.get("2") or "")
    message_data_raw = row.get("3")

    payload = _parse_payload(message_data_raw)

    if message_type == "SUBSCRIBED":
        return OrderEvent(
            kind="subscribed",
            account_number=account_number,
            message_type=message_type,
            raw_payload=payload if isinstance(payload, dict) else {},
        )
    if message_type == "ERROR":
        text = (
            payload.get("error") if isinstance(payload, dict) else str(message_data_raw)
        )
        return RawActivityEvent(
            kind="error",
            account_number=account_number,
            message_type=message_type,
            raw_payload=payload if isinstance(payload, dict) else {},
            error=str(text) if text is not None else None,
        )

    if not isinstance(payload, dict):
        return RawActivityEvent(
            kind="raw",
            account_number=account_number,
            message_type=message_type,
            raw_payload={},
            error="message_data not a JSON object",
        )

    order_id = _first_str(payload, ["orderId", "OrderId", "order_id"])

    if message_type == "OrderEntryRequest":
        return OrderEvent(
            kind="submitted",
            account_number=account_number,
            message_type=message_type,
            order_id=order_id,
            raw_payload=payload,
        )
    if message_type == "OrderActivation":
        return OrderEvent(
            kind="accepted",
            account_number=account_number,
            message_type=message_type,
            order_id=order_id,
            raw_payload=payload,
        )
    if message_type == "OrderRejection":
        return OrderEvent(
            kind="rejected",
            account_number=account_number,
            message_type=message_type,
            order_id=order_id,
            raw_payload=payload,
        )
    if message_type in ("OrderCancelRequest", "TooLateToCancel", "UROUT"):
        # TooLateToCancel + UROUT both surface as "tried to cancel, ended
        # up canceled (or already filled — distinguish via subsequent
        # OrderFill). We map all three to `canceled` and let the
        # downstream reconciler decide if it needs a different label.
        return OrderEvent(
            kind="canceled",
            account_number=account_number,
            message_type=message_type,
            order_id=order_id,
            raw_payload=payload,
        )
    if message_type == "OrderCancelReplaceRequest":
        return CancelReplaceEvent(
            kind="replaced",
            account_number=account_number,
            message_type=message_type,
            order_id=order_id,
            raw_payload=payload,
            new_order_id=_first_str(
                payload, ["newOrderId", "replacementOrderId", "new_order_id"]
            ),
            old_order_id=order_id,
        )
    if message_type in ("OrderFill", "OrderPartialFill"):
        qty_filled = _first_float(
            payload, ["executionQuantity", "fillQuantity", "quantity"]
        )
        price = _first_float(payload, ["executionPrice", "fillPrice", "price"])
        cum_filled = _first_float(
            payload, ["cumulativeFilledQuantity", "cumulativeQuantity"]
        )
        total_qty = _first_float(payload, ["totalQuantity", "orderQuantity"])
        remaining = total_qty - cum_filled if total_qty else 0.0
        derived = (
            derive_order_status("FILLED", cum_filled, total_qty)
            if total_qty and cum_filled >= total_qty
            else derive_order_status("WORKING", cum_filled, total_qty)
        )
        return FillEvent(
            kind="filled" if message_type == "OrderFill" else "partial_fill",
            account_number=account_number,
            message_type=message_type,
            order_id=order_id,
            raw_payload=payload,
            fill_quantity=qty_filled,
            fill_price=price,
            cumulative_filled=cum_filled,
            remaining_quantity=remaining,
            derived_status=derived,
        )

    # Unknown message type — surface for diagnosis, don't crash.
    return RawActivityEvent(
        kind="raw",
        account_number=account_number,
        message_type=message_type,
        order_id=order_id,
        raw_payload=payload,
        error=f"unknown ACCT_ACTIVITY message_type: {message_type}",
    )


# ── Internals ─────────────────────────────────────────────────────


def _parse_payload(message_data: Any) -> Any:
    """ACCT_ACTIVITY field 3 may arrive as a JSON-encoded string or
    as a parsed dict, depending on whether the streamer layer already
    decoded it. Be tolerant of both."""
    if isinstance(message_data, dict):
        return message_data
    if isinstance(message_data, str):
        try:
            return json.loads(message_data)
        except json.JSONDecodeError:
            return None
    return None


def _first_str(payload: dict[str, Any], keys: list[str]) -> str | None:
    for k in keys:
        v = payload.get(k)
        if v is not None:
            return str(v)
    return None


def _first_float(payload: dict[str, Any], keys: list[str]) -> float:
    for k in keys:
        v = payload.get(k)
        if v is None:
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return 0.0


__all__ = [
    "ACCT_ACTIVITY_MESSAGE_TYPES",
    "CancelReplaceEvent",
    "FillEvent",
    "OrderEvent",
    "OrderEventKind",
    "RawActivityEvent",
    "parse_account_activity_row",
]
