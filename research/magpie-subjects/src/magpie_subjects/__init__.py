"""``magpie_subjects`` — NATS subject builders for Magpie (Python).

Mirror of ``src/types/subjects.ts``. Import the builders directly:

.. code-block:: python

    from magpie_subjects import orders_submit, marketdata_quotes

    orders_submit("schwab")            # "orders.submit.schwab"
    marketdata_quotes("schwab", "EQ.SPY")  # "marketdata.quotes.schwab.EQ.SPY"

See ``docs/tdd/nats-subjects.md`` for the canonical registry.
"""

from __future__ import annotations

from magpie_subjects.subjects import (
    ORDERS_GATE_PREFIX,
    MdStream,
    lifecycle,
    marketdata_book,
    marketdata_heartbeat,
    marketdata_quotes,
    marketdata_rpc_candles,
    marketdata_rpc_chain,
    marketdata_rpc_expirations,
    marketdata_rpc_historical_chain,
    marketdata_rpc_quote,
    marketdata_stream,
    marketdata_trades,
    orders_accounts,
    orders_cancel,
    orders_exec_reports,
    orders_gate,
    orders_gate_revoke,
    orders_positions,
    orders_status,
    orders_submit,
)

__all__ = [
    "ORDERS_GATE_PREFIX",
    "MdStream",
    "lifecycle",
    "marketdata_book",
    "marketdata_heartbeat",
    "marketdata_quotes",
    "marketdata_rpc_candles",
    "marketdata_rpc_chain",
    "marketdata_rpc_expirations",
    "marketdata_rpc_historical_chain",
    "marketdata_rpc_quote",
    "marketdata_stream",
    "marketdata_trades",
    "orders_accounts",
    "orders_cancel",
    "orders_exec_reports",
    "orders_gate",
    "orders_gate_revoke",
    "orders_positions",
    "orders_status",
    "orders_submit",
]
