"""QF-335 — NATS subject builders + cross-language parity.

The fixture asserted here (``docs/tdd/nats-subjects.fixtures.json``) is the
same one the TS mirror checks (``src/types/subjects.test.ts``), so both
languages provably emit identical subject strings for identical inputs.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest
from magpie_subjects import (
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

# repo root: tests/ -> magpie-subjects/ -> research/ -> <repo>
_REPO_ROOT = Path(__file__).resolve().parents[3]
_FIXTURE = _REPO_ROOT / "docs" / "tdd" / "nats-subjects.fixtures.json"

# Builder name (as it appears in the fixture) -> callable.
DISPATCH: dict[str, Callable[..., str]] = {
    "orders.submit": orders_submit,
    "orders.cancel": orders_cancel,
    "orders.status": orders_status,
    "orders.positions": orders_positions,
    "orders.accounts": orders_accounts,
    "orders.exec_reports": orders_exec_reports,
    "orders.gate": orders_gate,
    "orders.gate.revoke": orders_gate_revoke,
    "marketdata.rpc.quote": marketdata_rpc_quote,
    "marketdata.rpc.expirations": marketdata_rpc_expirations,
    "marketdata.rpc.chain": marketdata_rpc_chain,
    "marketdata.rpc.historical_chain": marketdata_rpc_historical_chain,
    "marketdata.rpc.candles": marketdata_rpc_candles,
    "marketdata.quotes": marketdata_quotes,
    "marketdata.trades": marketdata_trades,
    "marketdata.book": marketdata_book,
    "marketdata.heartbeat": marketdata_heartbeat,
}


def _load_cases() -> list[dict[str, object]]:
    data = json.loads(_FIXTURE.read_text())
    cases = data["cases"]
    assert isinstance(cases, list)
    return cases


def test_direct_builders() -> None:
    assert orders_submit("schwab") == "orders.submit.schwab"
    assert orders_gate("ibkr") == "orders.gate.ibkr"
    assert orders_gate_revoke("schwab") == "orders.gate.revoke.schwab"
    assert marketdata_quotes("schwab") == "marketdata.quotes.schwab"
    assert marketdata_quotes("schwab", "EQ.SPY") == "marketdata.quotes.schwab.EQ.SPY"
    assert marketdata_stream("book", "ibkr", "EQ.SPY") == "marketdata.book.ibkr.EQ.SPY"
    assert marketdata_heartbeat("schwab") == "marketdata.schwab.heartbeat"


def test_fixture_covers_every_builder() -> None:
    seen = {c["builder"] for c in _load_cases()}
    missing = set(DISPATCH) - seen
    assert not missing, f"builders absent from fixture: {missing}"


def _case_id(case: dict[str, object]) -> str:
    return f"{case['builder']}/{'-'.join(case['args'])}"  # type: ignore[arg-type]


@pytest.mark.parametrize("case", _load_cases(), ids=_case_id)
def test_parity_fixture(case: dict[str, object]) -> None:
    builder = case["builder"]
    assert isinstance(builder, str)
    args = case["args"]
    assert isinstance(args, list)
    build = DISPATCH.get(builder)
    assert build is not None, f"no dispatch for {builder}"
    assert build(*args) == case["expected"]
