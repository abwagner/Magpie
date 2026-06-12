"""QF-313 — fail-open branches in QFRiskGate.check_order.

Covers:
  - RPC success → returns the gate verdict verbatim (regression)
  - RPC timeout + closes_only + strictly-closing → synthetic approve
  - RPC timeout + closes_only + opening → reject(gate_unavailable_open_blocked)
  - RPC timeout + fail_closed → reject regardless of side/qty
  - RPC connection failure → same fail-open branches as timeout
  - The synthetic GateResponse on fail-open carries empty intent_id
    and null envelope_id (QF didn't mint one)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest
from magpie_risk_gate.config import QFRiskGateConfig
from magpie_risk_gate.gate import QFRiskGate
from magpie_risk_gate.wire import GateRequest, GateRequestIntent


@dataclass
class FakeNatsMsg:
    data: bytes


class FakeNatsClient:
    def __init__(
        self,
        reply_factory: Any | None = None,
        timeout_on_request: bool = False,
        connection_failure: bool = False,
    ) -> None:
        self.reply_factory = reply_factory
        self.timeout_on_request = timeout_on_request
        self.connection_failure = connection_failure

    async def request(
        self, subject: str, payload: bytes, timeout: float
    ) -> FakeNatsMsg:
        if self.timeout_on_request:
            raise TimeoutError()
        if self.connection_failure:
            raise ConnectionError("simulated")
        assert self.reply_factory is not None
        return FakeNatsMsg(data=self.reply_factory())

    async def drain(self) -> None:
        return None


def make_request(
    direction: str = "Short",
    qty: int = 5,
    current_qty: int = 5,
) -> GateRequest:
    return GateRequest(
        intent=GateRequestIntent(
            symbol="SPY",
            direction=direction,  # type: ignore[arg-type]
            quantity=qty,
            order_type="market",
        ),
        strategy_id="s-1",
        portfolio_id="main",
        current_position=(current_qty, 100.0),
        account_balance=100_000.0,
        asof="2026-05-29T17:00:00Z",
    )


def factory_for(fake: FakeNatsClient) -> Any:
    async def f() -> FakeNatsClient:
        return fake

    return f


@pytest.mark.asyncio
class TestFailOpen:
    async def test_rpc_success_passes_verdict_through(self) -> None:
        # Regression check from QF-312: success path still returns QF verdict.
        fake = FakeNatsClient(
            reply_factory=lambda: json.dumps(
                {
                    "decision": "approve",
                    "reason": None,
                    "intent_id": "INT-1",
                    "envelope_id": "INT-1",
                }
            ).encode("utf-8"),
        )
        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory_for(fake))
        try:
            r = await gate.check_order(make_request())
        finally:
            await gate.close()
        assert r.decision == "approve"
        assert r.intent_id == "INT-1"

    async def test_timeout_closes_only_strictly_closing_returns_approve(self) -> None:
        fake = FakeNatsClient(timeout_on_request=True)
        gate = QFRiskGate(
            QFRiskGateConfig(fail_open_mode="closes_only", gate_timeout_ms=10),
            nats_factory=factory_for(fake),
        )
        try:
            # Long 5 position, sell 3 = strictly closing → synthetic approve.
            r = await gate.check_order(
                make_request(direction="Short", qty=3, current_qty=5),
            )
        finally:
            await gate.close()
        assert r.decision == "approve"
        assert r.intent_id == ""
        assert r.envelope_id is None

    async def test_timeout_closes_only_opening_returns_reject(self) -> None:
        fake = FakeNatsClient(timeout_on_request=True)
        gate = QFRiskGate(
            QFRiskGateConfig(fail_open_mode="closes_only", gate_timeout_ms=10),
            nats_factory=factory_for(fake),
        )
        try:
            # Long 5 position, BUY 3 = adding → reject.
            r = await gate.check_order(
                make_request(direction="Long", qty=3, current_qty=5),
            )
        finally:
            await gate.close()
        assert r.decision == "reject"
        assert r.reason == "gate_unavailable_open_blocked"
        assert r.envelope_id is None

    async def test_timeout_closes_only_flat_position_returns_reject(self) -> None:
        fake = FakeNatsClient(timeout_on_request=True)
        gate = QFRiskGate(
            QFRiskGateConfig(fail_open_mode="closes_only", gate_timeout_ms=10),
            nats_factory=factory_for(fake),
        )
        try:
            r = await gate.check_order(
                make_request(direction="Long", qty=1, current_qty=0),
            )
        finally:
            await gate.close()
        assert r.decision == "reject"
        assert r.reason == "gate_unavailable_open_blocked"

    async def test_timeout_fail_closed_returns_reject_regardless_of_classification(
        self,
    ) -> None:
        fake = FakeNatsClient(timeout_on_request=True)
        gate = QFRiskGate(
            QFRiskGateConfig(fail_open_mode="fail_closed", gate_timeout_ms=10),
            nats_factory=factory_for(fake),
        )
        try:
            # Strictly closing — but fail_closed mode rejects everything.
            r = await gate.check_order(
                make_request(direction="Short", qty=3, current_qty=5),
            )
        finally:
            await gate.close()
        assert r.decision == "reject"
        assert r.reason == "gate_unavailable_open_blocked"

    async def test_connection_failure_takes_fail_open_branch_too(self) -> None:
        # ConnectionError from nats-py reaches us as QFRiskGateRpcError;
        # the fail-open branch should fire identically to a timeout.
        fake = FakeNatsClient(connection_failure=True)
        gate = QFRiskGate(
            QFRiskGateConfig(fail_open_mode="closes_only"),
            nats_factory=factory_for(fake),
        )
        try:
            r = await gate.check_order(
                make_request(direction="Short", qty=3, current_qty=5),
            )
        finally:
            await gate.close()
        assert r.decision == "approve"
        assert r.intent_id == ""

    async def test_none_current_position_treated_as_flat(self) -> None:
        # NT might send current_position=None for never-traded symbols.
        fake = FakeNatsClient(timeout_on_request=True)
        gate = QFRiskGate(
            QFRiskGateConfig(fail_open_mode="closes_only"),
            nats_factory=factory_for(fake),
        )
        try:
            req = GateRequest(
                intent=GateRequestIntent(
                    symbol="SPY",
                    direction="Long",
                    quantity=1,
                    order_type="market",
                ),
                strategy_id="s-1",
                portfolio_id="main",
                current_position=None,
                account_balance=100_000.0,
                asof="2026-05-29T17:00:00Z",
            )
            r = await gate.check_order(req)
        finally:
            await gate.close()
        # Flat + opening Long → reject (no position to close).
        assert r.decision == "reject"
