"""Wire format for the QF↔NT NATS-RPC bridge (QF-237).

Mirrors the TypeScript shapes in ``src/types/order.ts`` so the same
field names round-trip across runtimes. The bridge uses plain
dataclasses with explicit ``to_dict`` / ``from_dict`` rather than
pydantic to avoid adding a runtime dependency the rest of this
package doesn't need; tests verify JSON round-trip parity with the
TS side via the literal field names.

Schemas correspond to ``docs/tdd/broker-integration.md §3``. Only the
fields the bridge actually consumes or produces are typed here; the
``raw_payload`` escape hatch on event types covers Schwab-specific
fields that the QF layer doesn't need to know about.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

# ── Submit / cancel request shapes ────────────────────────────────


@dataclass(frozen=True)
class SubmitOrderRequest:
    """Payload of ``orders.submit.schwab`` request.

    Mirrors the QF TS ``OrderIntent`` shape — the fields the bridge
    needs to build a Schwab REST body. Optional fields default to None
    so the same dataclass works for market and limit orders.
    """

    intent_id: str
    symbol: str
    direction: str  # "Long" | "Short" | "close"
    quantity: float
    order_type: str = "market"  # "market" | "limit"
    limit_price: float | None = None
    time_in_force: str = "day"  # "day" | "gtc" | "ioc" | "fok"

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SubmitOrderRequest:
        return cls(
            intent_id=str(d["intent_id"]),
            symbol=str(d["symbol"]),
            direction=str(d["direction"]),
            quantity=float(d["quantity"]),
            order_type=str(d.get("order_type", "market")),
            limit_price=(
                float(d["limit_price"]) if d.get("limit_price") is not None else None
            ),
            time_in_force=str(d.get("time_in_force", "day")),
        )


@dataclass(frozen=True)
class SubmitOrderReply:
    """Reply payload of ``orders.submit.schwab``."""

    broker_order_id: str | None = None
    accepted: bool = False
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"accepted": self.accepted}
        if self.broker_order_id is not None:
            out["broker_order_id"] = self.broker_order_id
        if self.error is not None:
            out["error"] = self.error
        return out


@dataclass(frozen=True)
class CancelOrderRequest:
    broker_order_id: str
    reason: str = "qf_cancel"

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CancelOrderRequest:
        return cls(
            broker_order_id=str(d["broker_order_id"]),
            reason=str(d.get("reason", "qf_cancel")),
        )


@dataclass(frozen=True)
class CancelOrderReply:
    accepted: bool = False
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"accepted": self.accepted}
        if self.error is not None:
            out["error"] = self.error
        return out


@dataclass(frozen=True)
class StatusRequest:
    broker_order_id: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StatusRequest:
        return cls(broker_order_id=str(d["broker_order_id"]))


# ── BrokerOrderStatus (status reply) ──────────────────────────────

BrokerStatusStr = Literal[
    "working", "filled", "partial_fill", "cancelled", "rejected", "unknown"
]


@dataclass(frozen=True)
class BrokerOrderStatus:
    """Reply payload of ``orders.status.<broker>``. Mirrors TS shape."""

    broker_order_id: str
    status: BrokerStatusStr
    filled_quantity: float
    average_fill_price: float | None
    rejection_reason: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "broker_order_id": self.broker_order_id,
            "status": self.status,
            "filled_quantity": self.filled_quantity,
            "average_fill_price": self.average_fill_price,
            "rejection_reason": self.rejection_reason,
        }


# ── BrokerPosition (positions reply) ──────────────────────────────


@dataclass(frozen=True)
class BrokerPosition:
    symbol: str
    direction: str  # "Long" | "Short"
    quantity: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "direction": self.direction,
            "quantity": self.quantity,
        }


# ── BrokerExecReport (exec_reports publish) ───────────────────────

ExecReportEvent = Literal["fill", "partial_fill", "cancelled", "rejected", "submitted"]


@dataclass(frozen=True)
class ExecFillPayload:
    fill_id: str
    price: float
    quantity: float
    fees: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "fill_id": self.fill_id,
            "price": self.price,
            "quantity": self.quantity,
            "fees": self.fees,
        }


@dataclass(frozen=True)
class BrokerExecReport:
    """One-way pub on ``orders.exec_reports.<broker>``."""

    broker: str
    broker_order_id: str
    event: ExecReportEvent
    ts: str  # ISO-8601
    intent_id: str | None = None
    fill: ExecFillPayload | None = None
    rejection_reason: str | None = None
    broker_reason_code: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "broker": self.broker,
            "broker_order_id": self.broker_order_id,
            "event": self.event,
            "ts": self.ts,
            "intent_id": self.intent_id,
        }
        if self.fill is not None:
            out["fill"] = self.fill.to_dict()
        if self.rejection_reason is not None:
            out["rejection_reason"] = self.rejection_reason
        if self.broker_reason_code is not None:
            out["broker_reason_code"] = self.broker_reason_code
        return out


__all__ = [
    "BrokerExecReport",
    "BrokerOrderStatus",
    "BrokerPosition",
    "CancelOrderReply",
    "CancelOrderRequest",
    "ExecFillPayload",
    "ExecReportEvent",
    "StatusRequest",
    "SubmitOrderReply",
    "SubmitOrderRequest",
]
