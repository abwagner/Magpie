"""QF risk-gate plugin for NautilusTrader.

Implements docs/tdd/risk-gate-architecture.md §2. Loads via NT's
``RiskEngineConfig.risk_module_path`` and intercepts every strategy
order before it reaches the ExecutionEngine. Defers semantic
authority (cross-strategy aggregates, halt state, concentration) to
the QF TS server via NATS-RPC on ``orders.gate.<broker>``.

This package is greenfield in QF-312 (skeleton + NATS-RPC client +
config plumbing + unit tests against a fake QF service).
Subsequent tickets land:
  - QF-313: closes-only fail-open + classifier
  - QF-314: parent-budget per-intent evaluation + envelope handoff
"""

from magpie_risk_gate.classifier import is_strictly_closing
from magpie_risk_gate.config import QFRiskGateConfig
from magpie_risk_gate.gate import QFRiskGate, QFRiskGateRpcError

__all__ = [
    "QFRiskGate",
    "QFRiskGateConfig",
    "QFRiskGateRpcError",
    "is_strictly_closing",
]
