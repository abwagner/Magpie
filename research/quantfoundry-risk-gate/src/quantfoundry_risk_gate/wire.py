"""Wire payload shapes for the gate RPC.

Mirrors docs/tdd/risk-gate-architecture.md §3.2 + §3.3. The TS
counterpart lives in server/risk/gate-handler.ts (QF-315) — same field
names so both runtimes share the schema.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Literal


@dataclass(frozen=True)
class GateRequestIntent:
    """Subset of NT's Order projected onto the gate wire.

    Strategies don't see this directly — the plugin extracts it from
    NT's Order at _check_order time and ships it across NATS.
    """

    symbol: str
    direction: Literal["Long", "Short"]
    quantity: int
    order_type: Literal["market", "limit"]
    # Optional for market orders. Required for limit; the plugin
    # enforces that at extraction time.
    limit_price: float | None = None
    # signal_ids may be empty when the strategy doesn't carry attribution
    # (e.g. manual-mode shadow flows during testing).
    signal_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class GateRequest:
    """Request body sent on orders.gate.<broker>.

    Both ``current_position`` and ``account_balance`` are projected
    from NT's cache at the call site — sent so the QF evaluator
    doesn't have to ask back synchronously.

    ``parent_order_id`` is the NT-side identifier (QF-314): when set,
    the plugin treats this as a child order under an already-approved
    envelope and short-circuits the RPC. When None, the order is a
    parent intent and the gate evaluates it at full impact per §2.1.
    """

    intent: GateRequestIntent
    strategy_id: str
    portfolio_id: str
    current_position: tuple[int, float] | None  # (qty, avg_price); None when flat
    account_balance: float
    asof: str  # ISO-8601 from NT's clock
    parent_order_id: str | None = None

    def to_json(self) -> bytes:
        # NATS wire is JSON for human-debuggability (same convention as
        # broker-integration.md §3). dataclass → dict; current_position
        # round-trips as a JSON array.
        d = asdict(self)
        if self.current_position is not None:
            d["current_position"] = {
                "qty": self.current_position[0],
                "avg_price": self.current_position[1],
            }
        return json.dumps(d, separators=(",", ":")).encode("utf-8")


# Reasons mirror server/risk/gate-handler.ts GateRejectionReason. Kept
# as a literal for type safety on the Python side; new reasons land
# additively as the TS evaluator grows.
GateRejectionReason = Literal[
    "limit_exceeded_per_strategy",
    "limit_exceeded_aggregate",
    "limit_exceeded_portfolio",
    "strategy_halted",
    "concentration",
    "config_invalid",
    "gate_unavailable_open_blocked",
    "gate_unavailable_nt_rejected",
]


@dataclass(frozen=True)
class GateResponse:
    """Reply body the QF server sends on the request inbox."""

    decision: Literal["approve", "reject"]
    reason: GateRejectionReason | None
    intent_id: str  # ULID minted by QF gate evaluator
    envelope_id: str | None  # set when decision='approve'; v1 == intent_id

    @classmethod
    def from_json(cls, raw: bytes) -> GateResponse:
        d = json.loads(raw.decode("utf-8"))
        return cls(
            decision=d["decision"],
            reason=d.get("reason"),
            intent_id=d.get("intent_id", ""),
            envelope_id=d.get("envelope_id"),
        )


# ── Revoke wire types (QF-314 / §3.5) ────────────────────────────────


RevokeReason = Literal[
    "portfolio_halted",
    "strategy_halted",
    "drift_hard_trip",
    "concentration_breach_other_strategy",
    "operator_initiated",
]


@dataclass(frozen=True)
class RevokeRequest:
    """Inbound from QF on orders.gate.revoke.<broker> per §3.5."""

    envelope_id: str
    reason: RevokeReason
    asof: str

    @classmethod
    def from_json(cls, raw: bytes) -> RevokeRequest:
        d = json.loads(raw.decode("utf-8"))
        return cls(
            envelope_id=d["envelope_id"],
            reason=d["reason"],
            asof=d.get("asof", ""),
        )


@dataclass(frozen=True)
class RevokeResponse:
    """Reply on the RevokeRequest inbox.

    ``revoked``         — envelope was present and dropped.
    ``envelope_unknown`` — idempotent success (restart replay safe).
    """

    status: Literal["revoked", "envelope_unknown"]

    def to_json(self) -> bytes:
        return json.dumps({"status": self.status}, separators=(",", ":")).encode(
            "utf-8"
        )
