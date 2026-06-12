"""NATS subject builders — Python mirror of ``src/types/subjects.ts``.

Single source of truth for every NATS subject string the Python side
constructs (broker bridges, MD bridges, risk-gate plugin). The canonical
registry — owners, payloads, grammar — lives in
``docs/tdd/nats-subjects.md``; this module is its executable form.

Pure refactor (QF-335): no new subjects are introduced here. Every
builder reproduces a literal that previously lived inline at a callsite.
Parity with the TS module is enforced by
``docs/tdd/nats-subjects.fixtures.json`` (see ``tests/test_subjects.py``
here and ``src/types/subjects.test.ts`` on the TS side).

``broker`` is the bundle suffix bound to ``config/brokers.json`` — its
value space (``schwab`` | ``ibkr``) is documented in
``docs/tdd/nats-subjects.md`` §1; kept as a plain ``str`` so callers that
read it from config need no cast.
"""

from __future__ import annotations

from typing import Literal

# Streaming market-data families — the first token after ``marketdata.``
# for per-symbol pub/sub streams.
MdStream = Literal["quotes", "trades", "book"]

# ── Orders (OPL ↔ broker bridge) — §2.1 ──


def orders_submit(broker: str) -> str:
    return f"orders.submit.{broker}"


def orders_cancel(broker: str) -> str:
    return f"orders.cancel.{broker}"


def orders_status(broker: str) -> str:
    return f"orders.status.{broker}"


def orders_positions(broker: str) -> str:
    return f"orders.positions.{broker}"


def orders_accounts(broker: str) -> str:
    return f"orders.accounts.{broker}"


def orders_exec_reports(broker: str) -> str:
    return f"orders.exec_reports.{broker}"


# ── Risk gate (NT plugin ↔ QF gate evaluator) — §2.2 ──

# Subject prefix for the gate family. The risk-gate plugin treats this as
# a configurable default (``QFRiskGateConfig.gate_subject_prefix``) and
# appends ``.{broker}`` / ``.revoke.{broker}`` itself, so it imports the
# literal from here rather than the full builders below.
ORDERS_GATE_PREFIX = "orders.gate"


def orders_gate(broker: str) -> str:
    return f"{ORDERS_GATE_PREFIX}.{broker}"


def orders_gate_revoke(broker: str) -> str:
    return f"{ORDERS_GATE_PREFIX}.revoke.{broker}"


# ── Market data (MD bridge ↔ TS MD service) — §2.3 ──


def marketdata_rpc_quote(broker: str) -> str:
    return f"marketdata.rpc.quote.{broker}"


def marketdata_rpc_expirations(broker: str) -> str:
    return f"marketdata.rpc.expirations.{broker}"


def marketdata_rpc_chain(broker: str) -> str:
    return f"marketdata.rpc.chain.{broker}"


def marketdata_rpc_historical_chain(broker: str) -> str:
    return f"marketdata.rpc.historical_chain.{broker}"


def marketdata_rpc_candles(broker: str) -> str:
    return f"marketdata.rpc.candles.{broker}"


def marketdata_stream(stream: MdStream, broker: str, symbol: str | None = None) -> str:
    """Streaming pub/sub subject.

    With ``symbol`` → the per-symbol subject the bridge publishes to / a
    consumer subscribes to; without → the broker-level base (e.g. for
    ownership logging or a wildcard subscription root).
    """
    if symbol is None:
        return f"marketdata.{stream}.{broker}"
    return f"marketdata.{stream}.{broker}.{symbol}"


def marketdata_quotes(broker: str, symbol: str | None = None) -> str:
    return marketdata_stream("quotes", broker, symbol)


def marketdata_trades(broker: str, symbol: str | None = None) -> str:
    return marketdata_stream("trades", broker, symbol)


def marketdata_book(broker: str, symbol: str | None = None) -> str:
    return marketdata_stream("book", broker, symbol)


def marketdata_heartbeat(broker: str) -> str:
    """Liveness — §2.3. Every 10s; drives the data-quality gate."""
    return f"marketdata.{broker}.heartbeat"


# ── Strategy lifecycle (QF registry → prod bundle launchers) — §2.5 ──


def lifecycle(strategy_id: str, action: str) -> str:
    """Lifecycle event subject.

    Strategy_id is the kebab-case strategy identifier (e.g. 'cl-scalp').
    Action is one of 'start' | 'halt' (see nats-subjects.md §1 for why
    only these two are published to prod launchers).

    Payload: serialized TransitionEvent { from, to, action, ts, actor, reason? }.
    """
    return f"lifecycle.{strategy_id}.{action}"
