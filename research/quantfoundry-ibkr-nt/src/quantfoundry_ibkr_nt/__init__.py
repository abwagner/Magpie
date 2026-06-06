"""IBKR observation-only NT broker adapter for Magpie.

QF-240. Wraps NT's upstream Interactive Brokers integration and
exposes the observation half of QF's broker contract over NATS-RPC:
``orders.status.ibkr``, ``orders.positions.ibkr``, and the
``orders.exec_reports.ibkr`` publisher. No submit/cancel surface —
NT owns the IB Gateway session per
``docs/tdd/broker-integration.md`` §2.3.

Companion package: :mod:`quantfoundry_schwab_nt` (QF-237) holds the
broker-agnostic wire types this package reuses.
"""

from quantfoundry_ibkr_nt.broker_bridge import (
    IbkrBrokerBridge,
    connect_and_run,
    derive_broker_status,
    event_to_exec_report,
    ibkr_order_to_broker_status,
    ibkr_position_to_broker_position,
    ibkr_status_to_broker_status,
    subjects_for,
)
from quantfoundry_ibkr_nt.session import (
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
    "is_rejection_error_code",
    "subjects_for",
]
