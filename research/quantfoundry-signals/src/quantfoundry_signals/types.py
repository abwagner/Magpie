"""Wire-contract types for the Signal Ingress Plane.

These mirror the TypeScript declarations in ``src/types/signal.ts``
byte-for-byte at the JSON layer — what the SDK serialises must match
what the TS sidecar at ``/signals`` parses. The Python-side authoritative
schema reference is still the TS file; this module is a typed mirror.

A signal carries:

* identity (``model_id`` + ``model_version`` + ``symbol`` + ``asof``)
* a ``horizon`` describing how far the prediction reaches
* a ``kind`` selecting the payload variant
* a ``payload`` with the actual model output
* ``provenance`` describing which worker run produced it

The four payload variants defined in TS today are :class:`PointPayload`,
:class:`ClassPayload`, :class:`VolBuyDirectivePayload`, and
:class:`VolBuyExitPayload`; arbitrary dict payloads are allowed for
forward compatibility (the TS ``Record<string, unknown>`` fallback).

Reference: ``docs/tdd/signal-ingress.md`` §2 (Wire Contract).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

SCHEMA_VERSION = 1

# ── Horizon ──────────────────────────────────────────────────────

HorizonAnchor = Literal["asof", "next_open", "next_close", "event"]


@dataclass(frozen=True)
class Horizon:
    """When the prediction lands relative to ``asof``.

    ``duration`` is an ISO-8601 duration ("P1D", "PT1H", ...) anchored
    by ``anchor``. ``anchor="event"`` means a non-fixed reference point
    (described by ``label``) and ``duration`` is null.
    """

    duration: str | None
    anchor: HorizonAnchor
    label: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {"duration": self.duration, "anchor": self.anchor, "label": self.label}


# ── Payload variants ─────────────────────────────────────────────

PointUnit = Literal["log_return", "price", "vol", "prob"]


@dataclass(frozen=True)
class PointPayload:
    """Scalar point forecast — used by ``kind="point"``."""

    value: float
    unit: PointUnit

    def to_wire(self) -> dict[str, Any]:
        return {"value": self.value, "unit": self.unit}


@dataclass(frozen=True)
class ClassPayload:
    """Discrete classification with class probabilities — used by ``kind="class"``."""

    label: str
    probs: dict[str, float]

    def to_wire(self) -> dict[str, Any]:
        return {"label": self.label, "probs": dict(self.probs)}


VolBuyStructure = Literal["long_put", "long_call", "straddle"]


@dataclass(frozen=True)
class VolBuyContract:
    """One option contract leg in a vol-buy directive payload."""

    side: Literal["P", "C"]
    root: str
    strike: float
    expiration: str
    dte: int
    mid_price: float
    bid: float
    ask: float
    iv: float
    delta: float
    gamma: float
    theta: float
    vega: float

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class VolBuyExit:
    """Exit policy for a vol-buy directive — nested inside the directive payload."""

    score_below: float | None = None
    max_hold_days: int | None = None
    close_before_expiry_days: int | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.score_below is not None:
            out["score_below"] = self.score_below
        if self.max_hold_days is not None:
            out["max_hold_days"] = self.max_hold_days
        if self.close_before_expiry_days is not None:
            out["close_before_expiry_days"] = self.close_before_expiry_days
        return out


@dataclass(frozen=True)
class VolBuyDirectivePayload:
    """Vol-buy directive — used by ``kind="vol_buy_directive"``."""

    fire: bool
    score: float
    structure: VolBuyStructure
    size_multiplier: float
    score_components: dict[str, float] | None = None
    spot: float | None = None
    vix: float | None = None
    exit: VolBuyExit | None = None
    contracts: tuple[VolBuyContract, ...] | None = None
    freshness: dict[str, float] | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "fire": self.fire,
            "score": self.score,
            "structure": self.structure,
            "size_multiplier": self.size_multiplier,
        }
        if self.score_components is not None:
            out["score_components"] = dict(self.score_components)
        if self.spot is not None:
            out["spot"] = self.spot
        if self.vix is not None:
            out["vix"] = self.vix
        if self.exit is not None:
            out["exit"] = self.exit.to_wire()
        if self.contracts is not None:
            out["contracts"] = [c.to_wire() for c in self.contracts]
        if self.freshness is not None:
            out["freshness"] = dict(self.freshness)
        return out


@dataclass(frozen=True)
class VolBuyExitPayload:
    """Exit signal for an open vol-buy directive — used by ``kind="vol_buy_exit"``."""

    directive_signal_id: str
    reason: Literal["score_below", "max_hold_days", "close_before_expiry"]
    trigger_value: float
    threshold: float

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)


# Payload union type — the four typed variants plus an arbitrary dict for
# forward compatibility (the TS ``Record<string, unknown>`` fallback).
SignalPayload = (
    PointPayload
    | ClassPayload
    | VolBuyDirectivePayload
    | VolBuyExitPayload
    | dict[str, Any]
)


# ── Provenance ──────────────────────────────────────────────────


@dataclass(frozen=True)
class Provenance:
    """Worker-run identity attached to every emitted signal.

    The SDK auto-fills ``worker_id`` and ``run_id``; the worker may set
    ``input_hash`` if it computes a hash over its model inputs (enables
    "given the same inputs, does the model still produce the same
    output?" replay).
    """

    worker_id: str
    run_id: str
    input_hash: str | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"worker_id": self.worker_id, "run_id": self.run_id}
        if self.input_hash is not None:
            out["input_hash"] = self.input_hash
        return out


# ── Signal ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Signal:
    """One signal emitted by a worker.

    All fields are required except ``confidence``. The SDK takes care
    of ``schema_version`` (always :data:`SCHEMA_VERSION`) and
    ``provenance`` (auto-filled); the worker provides everything else.
    """

    model_id: str
    model_version: str
    symbol: str
    asof: str
    horizon: Horizon
    kind: str
    payload: SignalPayload
    provenance: Provenance
    confidence: float | None = None
    schema_version: int = SCHEMA_VERSION

    def to_wire(self) -> dict[str, Any]:
        """Render to the JSON shape the ingress sidecar expects."""
        wire: dict[str, Any] = {
            "schema_version": self.schema_version,
            "model_id": self.model_id,
            "model_version": self.model_version,
            "symbol": self.symbol,
            "asof": self.asof,
            "horizon": self.horizon.to_wire(),
            "kind": self.kind,
            "payload": _payload_to_wire(self.payload),
            "provenance": self.provenance.to_wire(),
        }
        if self.confidence is not None:
            wire["confidence"] = self.confidence
        return wire


def _payload_to_wire(payload: SignalPayload) -> dict[str, Any]:
    """Coerce any payload variant into its wire-JSON dict form."""
    if isinstance(payload, dict):
        return payload
    return payload.to_wire()


# ── Batch envelope + responses ──────────────────────────────────


@dataclass(frozen=True)
class SignalBatchRequest:
    """The ``POST /signals`` request body — ``{"signals": [...]}``."""

    signals: tuple[Signal, ...] = field(default_factory=tuple)

    def to_wire(self) -> dict[str, Any]:
        return {"signals": [s.to_wire() for s in self.signals]}


AckMode = Literal["durable", "fast"]


@dataclass(frozen=True)
class SignalAcceptResponse:
    """Parsed 200 response from a successful batch submit."""

    accepted: int
    ack: AckMode
    batch_id: str


@dataclass(frozen=True)
class SignalErrorResponse:
    """Parsed 4xx/5xx response. ``error`` is the machine-readable code;
    ``message`` is the human-readable explanation when present."""

    error: str
    message: str | None = None
    index: int | None = None
    field: str | None = None
    model_id: str | None = None
    retry_after_ms: int | None = None
    batch_id: str | None = None


__all__ = [
    "SCHEMA_VERSION",
    "AckMode",
    "ClassPayload",
    "Horizon",
    "HorizonAnchor",
    "PointPayload",
    "PointUnit",
    "Provenance",
    "Signal",
    "SignalAcceptResponse",
    "SignalBatchRequest",
    "SignalErrorResponse",
    "SignalPayload",
    "VolBuyContract",
    "VolBuyDirectivePayload",
    "VolBuyExit",
    "VolBuyExitPayload",
    "VolBuyStructure",
]
