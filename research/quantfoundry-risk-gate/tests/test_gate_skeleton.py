"""QF-312 — QFRiskGate skeleton unit tests.

Covers:
  - QFRiskGateConfig validation (fail-open mode, positive timeout)
  - GateRequest JSON serialization round-trips current_position
  - GateResponse.from_json parses both approve + reject shapes
  - QFRiskGate._qf_gate_rpc round-trip via a fake NATS factory
  - RPC timeout raises QFRiskGateRpcError
  - Connection failure raises QFRiskGateRpcError
  - Malformed reply raises QFRiskGateRpcError
  - close() drains the underlying NATS connection

The fake NATS client mirrors the surface of nats.aio.client.Client
that gate.py touches: ``request(subject, payload, timeout)`` and
``drain()``. Tests instantiate QFRiskGate with a factory closure that
returns the fake.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest
from quantfoundry_risk_gate.config import QFRiskGateConfig
from quantfoundry_risk_gate.gate import QFRiskGate, QFRiskGateRpcError
from quantfoundry_risk_gate.wire import GateRequest, GateRequestIntent, GateResponse

# ── Fake NATS client ──────────────────────────────────────────────────


@dataclass
class FakeNatsMsg:
    data: bytes


class FakeNatsClient:
    """Mirrors the subset of nats.aio.client.Client gate.py touches."""

    def __init__(
        self,
        reply_factory: Any | None = None,
        raise_on_request: type[BaseException] | None = None,
        timeout_on_request: bool = False,
    ) -> None:
        self.reply_factory = reply_factory
        self.raise_on_request = raise_on_request
        self.timeout_on_request = timeout_on_request
        self.observed: list[tuple[str, dict[str, Any]]] = []
        self.drained = False

    async def request(
        self, subject: str, payload: bytes, timeout: float
    ) -> FakeNatsMsg:
        self.observed.append((subject, json.loads(payload.decode("utf-8"))))
        if self.timeout_on_request:
            raise TimeoutError()
        if self.raise_on_request is not None:
            raise self.raise_on_request("simulated connection failure")
        assert self.reply_factory is not None
        reply = self.reply_factory()
        return FakeNatsMsg(data=reply)

    async def drain(self) -> None:
        self.drained = True


def make_request() -> GateRequest:
    return GateRequest(
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


# ── Config tests ──────────────────────────────────────────────────────


class TestConfig:
    def test_defaults_validate(self) -> None:
        cfg = QFRiskGateConfig()
        assert cfg.fail_open_mode == "closes_only"
        assert cfg.gate_timeout_ms == 50
        assert cfg.gate_subject == "orders.gate.schwab"

    def test_invalid_fail_open_mode_raises(self) -> None:
        with pytest.raises(ValueError, match="fail_open_mode"):
            QFRiskGateConfig(fail_open_mode="bogus")

    def test_zero_or_negative_timeout_raises(self) -> None:
        with pytest.raises(ValueError, match="gate_timeout_ms"):
            QFRiskGateConfig(gate_timeout_ms=0)
        with pytest.raises(ValueError, match="gate_timeout_ms"):
            QFRiskGateConfig(gate_timeout_ms=-1)

    def test_empty_prefix_or_broker_raises(self) -> None:
        with pytest.raises(ValueError, match="gate_subject_prefix"):
            QFRiskGateConfig(gate_subject_prefix="")
        with pytest.raises(ValueError, match="broker"):
            QFRiskGateConfig(broker="")

    def test_from_dict_ignores_unknown_keys(self) -> None:
        cfg = QFRiskGateConfig.from_dict(
            {
                "gate_timeout_ms": 100,
                "broker": "ibkr",
                "unknown_future_field": True,
            }
        )
        assert cfg.gate_timeout_ms == 100
        assert cfg.broker == "ibkr"
        assert cfg.gate_subject == "orders.gate.ibkr"


# ── Wire tests ────────────────────────────────────────────────────────


class TestWire:
    def test_request_serializes_current_position_as_object(self) -> None:
        req = GateRequest(
            intent=GateRequestIntent(
                symbol="SPY",
                direction="Short",
                quantity=2,
                order_type="limit",
                limit_price=420.0,
            ),
            strategy_id="s-1",
            portfolio_id="main",
            current_position=(10, 415.5),
            account_balance=50_000.0,
            asof="2026-05-29T17:00:00Z",
        )
        parsed = json.loads(req.to_json().decode("utf-8"))
        assert parsed["current_position"] == {"qty": 10, "avg_price": 415.5}

    def test_request_serializes_no_current_position_as_null(self) -> None:
        parsed = json.loads(make_request().to_json().decode("utf-8"))
        assert parsed["current_position"] is None

    def test_response_parses_approve(self) -> None:
        raw = json.dumps(
            {
                "decision": "approve",
                "reason": None,
                "intent_id": "INT-1",
                "envelope_id": "INT-1",
            }
        ).encode("utf-8")
        r = GateResponse.from_json(raw)
        assert r.decision == "approve"
        assert r.intent_id == "INT-1"
        assert r.envelope_id == "INT-1"

    def test_response_parses_reject(self) -> None:
        raw = json.dumps(
            {
                "decision": "reject",
                "reason": "limit_exceeded_per_strategy",
                "intent_id": "INT-2",
                "envelope_id": None,
            }
        ).encode("utf-8")
        r = GateResponse.from_json(raw)
        assert r.decision == "reject"
        assert r.reason == "limit_exceeded_per_strategy"
        assert r.envelope_id is None


# ── Gate tests ────────────────────────────────────────────────────────


@pytest.mark.asyncio
class TestGate:
    async def test_check_order_round_trip(self) -> None:
        fake_nats = FakeNatsClient(
            reply_factory=lambda: json.dumps(
                {
                    "decision": "approve",
                    "reason": None,
                    "intent_id": "INT-1",
                    "envelope_id": "INT-1",
                }
            ).encode("utf-8"),
        )

        async def factory() -> FakeNatsClient:
            return fake_nats

        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory)
        try:
            reply = await gate.check_order(make_request())
        finally:
            await gate.close()

        assert reply.decision == "approve"
        assert reply.intent_id == "INT-1"
        assert len(fake_nats.observed) == 1
        subject, payload = fake_nats.observed[0]
        assert subject == "orders.gate.schwab"
        assert payload["strategy_id"] == "s-1"

    async def test_timeout_raises_rpc_error(self) -> None:
        fake_nats = FakeNatsClient(timeout_on_request=True)

        async def factory() -> FakeNatsClient:
            return fake_nats

        gate = QFRiskGate(QFRiskGateConfig(gate_timeout_ms=10), nats_factory=factory)
        try:
            # QF-313 wraps check_order with fail-open; test the inner
            # _qf_gate_rpc which still raises on timeout.
            with pytest.raises(QFRiskGateRpcError, match="timed out"):
                await gate._qf_gate_rpc(make_request())
        finally:
            await gate.close()

    async def test_connection_failure_raises_rpc_error(self) -> None:
        fake_nats = FakeNatsClient(raise_on_request=ConnectionError)

        async def factory() -> FakeNatsClient:
            return fake_nats

        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory)
        try:
            with pytest.raises(QFRiskGateRpcError, match="connection failure"):
                await gate._qf_gate_rpc(make_request())
        finally:
            await gate.close()

    async def test_malformed_reply_raises_rpc_error(self) -> None:
        fake_nats = FakeNatsClient(reply_factory=lambda: b"not json")

        async def factory() -> FakeNatsClient:
            return fake_nats

        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory)
        try:
            with pytest.raises(QFRiskGateRpcError, match="payload parse"):
                await gate._qf_gate_rpc(make_request())
        finally:
            await gate.close()

    async def test_close_drains_connection(self) -> None:
        fake_nats = FakeNatsClient(
            reply_factory=lambda: json.dumps(
                {
                    "decision": "approve",
                    "reason": None,
                    "intent_id": "INT-1",
                    "envelope_id": "INT-1",
                }
            ).encode("utf-8"),
        )

        async def factory() -> FakeNatsClient:
            return fake_nats

        gate = QFRiskGate(QFRiskGateConfig(), nats_factory=factory)
        await gate.check_order(make_request())
        await gate.close()

        assert fake_nats.drained is True
        # Subsequent calls fail (closed).
        with pytest.raises(RuntimeError, match="closed"):
            await gate.check_order(make_request())
