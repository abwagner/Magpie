"""Schwab → NT `OrderStatus` mapping for the live execution path.

The mapping table lives here as a module-level dict so it's both
importable as data (tests can iterate it) and the single source of
truth for the REST exec client + ACCT_ACTIVITY parser.

Two caveats documented in `docs/research/qf-160-schwab-nt-spike.md
§Spot-check 1`:

* Schwab's ``WORKING`` covers both NT's ``ACCEPTED`` and
  ``PARTIALLY_FILLED``. Derive the partial state from
  ``filled_quantity`` via :func:`derive_order_status`, **not** the
  status string.
* Schwab's ``REPLACED`` is terminal on the OLD order; the new order
  is independent. Callers should treat ``REPLACED`` as ``CANCELED``
  at the QF intent layer and emit a fresh order event for the
  replacement (whose ``replacedOrderId`` ties it back).
"""

from __future__ import annotations

from typing import Literal

# NT's OrderStatus enum values. Kept as a Literal alias rather than
# importing the actual enum from `nautilus_trader` so this package
# stays NT-free. The NT-bound adapter ticket (follow-up) maps these
# strings to the real enum via `OrderStatus[<string>]`.
NTOrderStatus = Literal[
    "INITIALIZED",
    "DENIED",
    "EMULATED",
    "RELEASED",
    "SUBMITTED",
    "ACCEPTED",
    "REJECTED",
    "CANCELED",
    "EXPIRED",
    "TRIGGERED",
    "PENDING_UPDATE",
    "PENDING_CANCEL",
    "PARTIALLY_FILLED",
    "FILLED",
]


# ── Mapping table ─────────────────────────────────────────────────
#
# Schwab Trader API order statuses → NT OrderStatus (base).
# `derive_order_status` layers partial-fill detection on top.

ORDER_STATUS_MAPPING: dict[str, NTOrderStatus] = {
    "NEW": "INITIALIZED",
    "AWAITING_PARENT_ORDER": "PENDING_UPDATE",
    "AWAITING_CONDITION": "PENDING_UPDATE",
    "AWAITING_STOP_CONDITION": "PENDING_UPDATE",
    "AWAITING_MANUAL_REVIEW": "SUBMITTED",
    "AWAITING_RELEASE_TIME": "PENDING_UPDATE",
    "AWAITING_UR_OUT": "PENDING_CANCEL",
    "PENDING_ACTIVATION": "SUBMITTED",
    "PENDING_ACKNOWLEDGEMENT": "SUBMITTED",
    "PENDING_RECALL": "PENDING_CANCEL",
    "PENDING_CANCEL": "PENDING_CANCEL",
    "PENDING_REPLACE": "PENDING_UPDATE",
    "QUEUED": "SUBMITTED",
    "ACCEPTED": "ACCEPTED",
    "WORKING": "ACCEPTED",  # may upgrade to PARTIALLY_FILLED — see derive_order_status
    "REJECTED": "REJECTED",
    "CANCELED": "CANCELED",
    "REPLACED": "CANCELED",  # terminal on the OLD order
    "FILLED": "FILLED",
    "EXPIRED": "EXPIRED",
    "UNKNOWN": "INITIALIZED",  # log + treat as new until further events
}


# ── Helpers ───────────────────────────────────────────────────────


def derive_order_status(
    schwab_status: str,
    filled_quantity: float,
    total_quantity: float,
) -> NTOrderStatus:
    """Map a Schwab order to its NT ``OrderStatus``, including partial fills.

    A Schwab ``WORKING`` order with ``0 < filled_quantity < total_quantity``
    maps to ``PARTIALLY_FILLED`` rather than ``ACCEPTED``.

    Unknown Schwab statuses log a warning at the caller site by surfacing
    a default of ``INITIALIZED`` — same as Schwab's own ``UNKNOWN`` value.
    """
    base = ORDER_STATUS_MAPPING.get(schwab_status, "INITIALIZED")
    if base == "ACCEPTED" and 0 < filled_quantity < total_quantity:
        return "PARTIALLY_FILLED"
    return base


def is_terminal(status: NTOrderStatus) -> bool:
    """Whether the order's lifecycle ends at this state."""
    return status in {"REJECTED", "CANCELED", "EXPIRED", "FILLED", "DENIED"}


__all__ = [
    "ORDER_STATUS_MAPPING",
    "NTOrderStatus",
    "derive_order_status",
    "is_terminal",
]
