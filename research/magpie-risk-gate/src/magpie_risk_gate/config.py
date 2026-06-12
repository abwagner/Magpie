"""Config shape for QFRiskGate.

Mirrors the ``config={...}`` block passed via
``RiskEngineConfig(risk_module_path=..., config={...})`` per
docs/tdd/risk-gate-architecture.md §2.
"""

from __future__ import annotations

from dataclasses import dataclass

from magpie_subjects import ORDERS_GATE_PREFIX

# Module-level defaults so a missing config field doesn't crash the
# TradingNode bootstrap. The §3.4 budget says 50ms is the gate hot-path
# RPC limit; the fail-open mode defaults to closes-only per §4.
DEFAULT_NATS_URL = "nats://localhost:4222"
# The gate subject prefix is the shared literal; the plugin appends
# `.{broker}` / `.revoke.{broker}` itself (see gate.py), so it keeps its
# configurable-prefix design and sources only the literal from here.
DEFAULT_GATE_SUBJECT_PREFIX = ORDERS_GATE_PREFIX
DEFAULT_GATE_TIMEOUT_MS = 50
DEFAULT_FAIL_OPEN_MODE = "closes_only"


@dataclass(frozen=True)
class QFRiskGateConfig:
    """Validated config for QFRiskGate.

    Builders that load from a YAML/JSON file convert the loose dict
    into this dataclass via ``from_dict`` so default values and type
    coercion happen in one place.
    """

    # The NATS server URL the plugin connects to. Same NATS the QF TS
    # server is connected to.
    nats_url: str = DEFAULT_NATS_URL
    # Subject prefix per §3.1. The full subject is
    # ``f"{gate_subject_prefix}.{broker}"`` (e.g. "orders.gate.schwab").
    gate_subject_prefix: str = DEFAULT_GATE_SUBJECT_PREFIX
    # Which broker this TradingNode is gating. Determines the trailing
    # subject suffix.
    broker: str = "schwab"
    # Per-attempt RPC timeout per §3.4. Default 50ms is ~10× headroom
    # over typical in-cluster round-trip; override per-strategy if HFT
    # budget tightens.
    gate_timeout_ms: int = DEFAULT_GATE_TIMEOUT_MS
    # Fail-open behavior on NATS timeout / connection failure. Either
    # "closes_only" (default, per §4) or "fail_closed". closes_only
    # passes closing orders through NT's local config; fail_closed
    # rejects everything until QF is reachable.
    fail_open_mode: str = DEFAULT_FAIL_OPEN_MODE

    def __post_init__(self) -> None:
        # Validate at construction so an invalid config fails fast at
        # TradingNode bootstrap instead of silently degrading at first
        # request.
        if self.fail_open_mode not in ("closes_only", "fail_closed"):
            msg = (
                f"fail_open_mode must be 'closes_only' or 'fail_closed', "
                f"got {self.fail_open_mode!r}"
            )
            raise ValueError(msg)
        if self.gate_timeout_ms <= 0:
            msg = f"gate_timeout_ms must be > 0, got {self.gate_timeout_ms!r}"
            raise ValueError(msg)
        if not self.gate_subject_prefix:
            msg = "gate_subject_prefix must be non-empty"
            raise ValueError(msg)
        if not self.broker:
            msg = "broker must be non-empty"
            raise ValueError(msg)

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> QFRiskGateConfig:
        """Build from the loose dict NT passes via RiskEngineConfig.

        Unknown keys are ignored (forward-compat with config files
        that carry extra metadata the plugin doesn't consume).
        """

        kwargs: dict[str, object] = {}
        for field_name in (
            "nats_url",
            "gate_subject_prefix",
            "broker",
            "gate_timeout_ms",
            "fail_open_mode",
        ):
            if field_name in raw:
                kwargs[field_name] = raw[field_name]
        return cls(**kwargs)  # type: ignore[arg-type]

    @property
    def gate_subject(self) -> str:
        """Full subject used for gate-RPC per §3.1."""
        return f"{self.gate_subject_prefix}.{self.broker}"
