"""IBKR NT broker adapter for Magpie.

QF-240 + QF-353. Wraps NT's upstream Interactive Brokers integration
and exposes QF's full broker contract over NATS-RPC: order submission
(``orders.submit.ibkr`` / ``orders.cancel.ibkr``, QF-353), the
observation half (``orders.status.ibkr`` / ``orders.positions.ibkr``),
and the ``orders.exec_reports.ibkr`` publisher. Symmetric with the
Schwab bundle per ``docs/tdd/broker-integration.md §3.1``.

Companion package: :mod:`magpie_schwab_nt` (QF-237) holds the
broker-agnostic wire types this package reuses.
"""

from magpie_ibkr_nt.broker_bridge import (
    IbkrBrokerBridge,
    connect_and_run,
    derive_broker_status,
    event_to_exec_report,
    ibkr_order_to_broker_status,
    ibkr_position_to_broker_position,
    ibkr_status_to_broker_status,
    intent_to_ibkr_body,
    subjects_for,
)
from magpie_ibkr_nt.session import (
    IBKR_REJECTION_ERROR_CODES,
    IbkrEvent,
    IbkrOrder,
    IbkrOrderNotFoundError,
    IbkrPosition,
    IbkrSessionClient,
    IbkrSessionError,
    is_rejection_error_code,
)

__all__ = [
    "IBKR_REJECTION_ERROR_CODES",
    "IbkrBrokerBridge",
    "IbkrEvent",
    "IbkrOrder",
    "IbkrOrderNotFoundError",
    "IbkrPosition",
    "IbkrSessionClient",
    "IbkrSessionError",
    "connect_and_run",
    "derive_broker_status",
    "event_to_exec_report",
    "ibkr_order_to_broker_status",
    "ibkr_position_to_broker_position",
    "ibkr_status_to_broker_status",
    "intent_to_ibkr_body",
    "is_rejection_error_code",
    "subjects_for",
]
