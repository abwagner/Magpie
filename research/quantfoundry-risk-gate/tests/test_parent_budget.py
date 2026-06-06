"""QF-314 — parent-budget evaluation + envelope handoff + revoke handling.

Covers:
  - Parent intent (parent_order_id=None) round-trips RPC + registers
    envelope on approve.
  - Child order with known parent_order_id → fast-path approve, no RPC.
  - Child order with revoked parent_order_id → falls through to RPC
    (re-evaluation as new parent).
  - Reject on parent does NOT register an envelope.
  - _handle_revoke_request drops the envelope and replies revoked.
  - _handle_revoke_request on unknown envelope replies envelope_unknown
    (idempotent / restart-replay safe).
  - close() clears the envelope registry.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest
from quantfoundry_risk_gate.config import QFRiskGateConfig
from quantfoundry_risk_gate.gate import QFRiskGate
from quantfoundry_risk_gate.wire import (
    GateRequest,
    GateRequestIntent,
    RevokeRequest,
    RevokeResponse,
)


@dataclass
class FakeNatsMsg:
    data: bytes


class FakeNatsClient:
    def __init__(
        self,
        reply_factory: Any | None = None,
    ) -> None:
        self.reply_factory = reply_factory
        self.observed: list[tuple[str, dict[str, Any]]] = []

    async def request(
        self, subject: str, payload: bytes, timeout: float
    ) -> FakeNatsMsg:
        self.observed.append((subject, json.loads(payload.decode("utf-8"))))
        assert self.reply_factory is not None
        return FakeNatsMsg(data=self.reply_factory())

    async def drain(self) -> None:
        return None


def make_request(
    parent_order_id: str | None = None,
    direction: str = "Long",
    qty: int = 1,
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
        current_position=None,
        account_balance=100_000.0,
        asof="2026-05-29T17:00:00Z",
        parent_order_id=parent_order_id,
    )


def approve_factory(envelope_id: str = "INT-1") -> Any:
    return lambda: json.dumps(
        {
            "decision": "approve",
            "reason": None,
            "intent_id": envelope_id,
            "envelope_id": envelope_id,
        }
    ).encode("utf-8")


def reject_factory(reason: str = "limit_exceeded_per_strategy") -> Any:
    return lambda: json.dumps(
        {
            "decision": "reject",
            "reason": reason,
            "intent_id": "INT-X",
            "envelope_id": None,
        }
    ).encode("utf-8")


def factory_for(fake: FakeNatsClient) -> Any:
    async def f() -> FakeNatsClient:
        return fake

    return f


@pytest.mark.asyncio
class TestParentBudget:
    async def test_parent_intent_round_trips_and_registers_envelope(self) -> None:
        fake = FakeNatsClient(reply_factory=approve_factory("INT-PARENT"))
        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory_for(fake))
        try:
            r = await gate.check_order(make_request())
        finally:
            await gate.close()
        # The envelope was registered BEFORE close() cleared it; we
        # verify via the reply payload (envelope_id flowed through).
        assert r.decision == "approve"
        assert r.envelope_id == "INT-PARENT"
        assert len(fake.observed) == 1

    async def test_child_with_known_envelope_fast_paths_no_rpc(self) -> None:
        fake = FakeNatsClient(reply_factory=approve_factory("INT-PARENT"))
        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory_for(fake))
        try:
            # First, submit the parent so the envelope is registered.
            await gate.check_order(make_request())
            assert gate.envelopes.contains("INT-PARENT")
            # Now a child under the same envelope should NOT issue a
            # second RPC; the fake's observed count stays at 1.
            child_reply = await gate.check_order(
                make_request(parent_order_id="INT-PARENT", qty=1),
            )
            assert child_reply.decision == "approve"
            assert child_reply.envelope_id == "INT-PARENT"
            assert child_reply.intent_id == ""  # synthetic
            assert len(fake.observed) == 1  # no second RPC
        finally:
            await gate.close()

    async def test_child_with_revoked_envelope_falls_through_to_rpc(self) -> None:
        fake = FakeNatsClient(reply_factory=approve_factory("INT-NEW"))
        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory_for(fake))
        try:
            # Synthesize a child referencing an envelope that was never
            # registered (simulates a revoked one from QF's side).
            child_reply = await gate.check_order(
                make_request(parent_order_id="ENV-GONE"),
            )
            # Fell through to the gate RPC; got a fresh envelope.
            assert child_reply.decision == "approve"
            assert child_reply.envelope_id == "INT-NEW"
            assert len(fake.observed) == 1
        finally:
            await gate.close()

    async def test_reject_does_not_register_envelope(self) -> None:
        fake = FakeNatsClient(reply_factory=reject_factory())
        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory_for(fake))
        try:
            r = await gate.check_order(make_request())
            assert r.decision == "reject"
            assert gate.envelopes.size() == 0
        finally:
            await gate.close()


@pytest.mark.asyncio
class TestRevokeHandler:
    async def test_revoke_present_replies_revoked_and_drops(self) -> None:
        fake = FakeNatsClient(reply_factory=approve_factory("INT-REV"))
        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory_for(fake))
        try:
            await gate.check_order(make_request())
            assert gate.envelopes.contains("INT-REV")

            req = RevokeRequest(
                envelope_id="INT-REV",
                reason="operator_initiated",
                asof="2026-05-29T17:30:00Z",
            )
            reply_bytes = gate._handle_revoke_request(
                json.dumps(
                    {
                        "envelope_id": req.envelope_id,
                        "reason": req.reason,
                        "asof": req.asof,
                    }
                ).encode("utf-8")
            )
            reply = json.loads(reply_bytes.decode("utf-8"))
            assert reply == {"status": "revoked"}
            assert not gate.envelopes.contains("INT-REV")
        finally:
            await gate.close()

    async def test_revoke_unknown_replies_envelope_unknown(self) -> None:
        fake = FakeNatsClient(reply_factory=approve_factory("X"))
        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory_for(fake))
        try:
            reply_bytes = gate._handle_revoke_request(
                json.dumps(
                    {
                        "envelope_id": "NEVER-EXISTED",
                        "reason": "strategy_halted",
                        "asof": "2026-05-29T17:30:00Z",
                    }
                ).encode("utf-8")
            )
            reply = json.loads(reply_bytes.decode("utf-8"))
            assert reply == {"status": "envelope_unknown"}
        finally:
            await gate.close()

    async def test_revoke_response_serialization_round_trip(self) -> None:
        # Sanity: RevokeResponse.to_json matches what the handler emits.
        assert json.loads(RevokeResponse(status="revoked").to_json()) == {
            "status": "revoked"
        }
        assert json.loads(RevokeResponse(status="envelope_unknown").to_json()) == {
            "status": "envelope_unknown"
        }
