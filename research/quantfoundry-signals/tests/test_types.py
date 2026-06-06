"""Tests for ``quantfoundry_signals.types``.

The wire schema is the contract — verify that every dataclass renders
to the exact JSON shape declared in ``src/types/signal.ts``.
"""

from __future__ import annotations

from quantfoundry_signals.types import (
    SCHEMA_VERSION,
    ClassPayload,
    Horizon,
    PointPayload,
    Provenance,
    Signal,
    SignalBatchRequest,
    VolBuyContract,
    VolBuyDirectivePayload,
    VolBuyExit,
    VolBuyExitPayload,
)


def _provenance() -> Provenance:
    return Provenance(worker_id="vol-forecast-7c9", run_id="abc123")


def _horizon() -> Horizon:
    return Horizon(duration="P1D", anchor="next_close")


class TestHorizon:
    def test_to_wire(self) -> None:
        assert Horizon(duration="PT1H", anchor="asof").to_wire() == {
            "duration": "PT1H",
            "anchor": "asof",
            "label": None,
        }

    def test_event_anchor_carries_null_duration(self) -> None:
        h = Horizon(duration=None, anchor="event", label="vix-spike")
        assert h.to_wire() == {
            "duration": None,
            "anchor": "event",
            "label": "vix-spike",
        }


class TestProvenance:
    def test_to_wire_without_input_hash(self) -> None:
        assert _provenance().to_wire() == {
            "worker_id": "vol-forecast-7c9",
            "run_id": "abc123",
        }

    def test_to_wire_with_input_hash(self) -> None:
        p = Provenance(worker_id="w", run_id="r", input_hash="sha256:deadbeef")
        assert p.to_wire() == {
            "worker_id": "w",
            "run_id": "r",
            "input_hash": "sha256:deadbeef",
        }


class TestPayloads:
    def test_point_payload(self) -> None:
        p = PointPayload(value=0.0142, unit="vol")
        assert p.to_wire() == {"value": 0.0142, "unit": "vol"}

    def test_class_payload(self) -> None:
        p = ClassPayload(label="bull", probs={"bull": 0.7, "bear": 0.3})
        assert p.to_wire() == {"label": "bull", "probs": {"bull": 0.7, "bear": 0.3}}

    def test_vol_buy_directive_minimal(self) -> None:
        d = VolBuyDirectivePayload(
            fire=True, score=0.8, structure="straddle", size_multiplier=1.0
        )
        assert d.to_wire() == {
            "fire": True,
            "score": 0.8,
            "structure": "straddle",
            "size_multiplier": 1.0,
        }

    def test_vol_buy_directive_with_nested(self) -> None:
        d = VolBuyDirectivePayload(
            fire=True,
            score=0.8,
            structure="long_put",
            size_multiplier=0.5,
            spot=500.0,
            vix=18.5,
            exit=VolBuyExit(score_below=0.3, max_hold_days=5),
            contracts=(
                VolBuyContract(
                    side="P",
                    root="SPY",
                    strike=495.0,
                    expiration="2026-06-19",
                    dte=10,
                    mid_price=2.45,
                    bid=2.40,
                    ask=2.50,
                    iv=0.18,
                    delta=-0.30,
                    gamma=0.02,
                    theta=-0.05,
                    vega=0.12,
                ),
            ),
            score_components={"vol_term": 0.5, "skew": 0.3},
            freshness={"chain": 1.2},
        )
        wire = d.to_wire()
        assert wire["spot"] == 500.0
        assert wire["vix"] == 18.5
        assert wire["exit"] == {"score_below": 0.3, "max_hold_days": 5}
        assert wire["score_components"] == {"vol_term": 0.5, "skew": 0.3}
        assert wire["freshness"] == {"chain": 1.2}
        assert len(wire["contracts"]) == 1
        assert wire["contracts"][0]["strike"] == 495.0

    def test_vol_buy_exit(self) -> None:
        e = VolBuyExitPayload(
            directive_signal_id="sig-xyz",
            reason="max_hold_days",
            trigger_value=5.0,
            threshold=5.0,
        )
        assert e.to_wire()["reason"] == "max_hold_days"


class TestSignal:
    def test_to_wire_minimal(self) -> None:
        sig = Signal(
            model_id="vol-forecast-spy-1d",
            model_version="v3.2",
            symbol="EQ:SPY",
            asof="2026-05-15T20:00:00Z",
            horizon=_horizon(),
            kind="point",
            payload=PointPayload(value=0.0142, unit="vol"),
            provenance=_provenance(),
        )
        wire = sig.to_wire()
        assert wire["schema_version"] == SCHEMA_VERSION
        assert wire["model_id"] == "vol-forecast-spy-1d"
        assert wire["model_version"] == "v3.2"
        assert wire["symbol"] == "EQ:SPY"
        assert wire["asof"] == "2026-05-15T20:00:00Z"
        assert wire["kind"] == "point"
        assert wire["horizon"]["duration"] == "P1D"
        assert wire["payload"] == {"value": 0.0142, "unit": "vol"}
        assert wire["provenance"]["worker_id"] == "vol-forecast-7c9"
        assert "confidence" not in wire  # omitted when None

    def test_to_wire_with_confidence(self) -> None:
        sig = Signal(
            model_id="m",
            model_version="v1",
            symbol="EQ:SPY",
            asof="2026-05-15T20:00:00Z",
            horizon=_horizon(),
            kind="point",
            payload=PointPayload(value=0.0, unit="prob"),
            provenance=_provenance(),
            confidence=0.85,
        )
        assert sig.to_wire()["confidence"] == 0.85

    def test_to_wire_with_dict_payload_fallback(self) -> None:
        # A dict payload bypasses to_wire() — used for forward
        # compatibility with kinds the SDK doesn't yet model.
        sig = Signal(
            model_id="m",
            model_version="v1",
            symbol="EQ:SPY",
            asof="2026-05-15T20:00:00Z",
            horizon=_horizon(),
            kind="future_kind",
            payload={"arbitrary": True, "value": 42},
            provenance=_provenance(),
        )
        assert sig.to_wire()["payload"] == {"arbitrary": True, "value": 42}


class TestBatchRequest:
    def test_to_wire(self) -> None:
        sig = Signal(
            model_id="m",
            model_version="v1",
            symbol="EQ:SPY",
            asof="2026-05-15T20:00:00Z",
            horizon=_horizon(),
            kind="point",
            payload=PointPayload(value=0.0, unit="prob"),
            provenance=_provenance(),
        )
        body = SignalBatchRequest(signals=(sig, sig)).to_wire()
        assert "signals" in body
        assert len(body["signals"]) == 2
        assert body["signals"][0]["model_id"] == "m"

    def test_empty_batch(self) -> None:
        assert SignalBatchRequest().to_wire() == {"signals": []}
