"""Base class for Magpie signal workers.

A worker is a long-running (or one-shot) Python process that computes
predictions and publishes them as signals. The shape every worker
extends:

.. code-block:: python

    class VolForecast(SignalWorker):
        model_id = "vol-forecast-spy-1d"
        model_version = "v3.2"
        kind = "point"
        horizon = Horizon(duration="P1D", anchor="next_close")

        def predict(self, ctx: PredictContext) -> SignalPayload | list[Signal]:
            return PointPayload(value=0.0142, unit="vol")

    if __name__ == "__main__":
        VolForecast().run_once()

The class enforces the wire-contract identity fields (``model_id``,
``model_version``, ``kind``, ``horizon``) and supplies the rest:
``asof`` from the call site (or ``now()``), ``schema_version``,
``provenance``, and the publish path. Subclasses only have to compute
the payload(s).

Two return shapes are supported from :meth:`predict`:

* A single payload — the SDK builds one :class:`Signal` from the class
  metadata + ``ctx.symbol`` and emits it.
* A list of fully-built :class:`Signal` records — the worker keeps
  full control over per-symbol payloads, ``asof``, and ``confidence``.
  (The SDK still validates each one against the class metadata.)
"""

from __future__ import annotations

import abc
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast

from quantfoundry_logging import get_logger, with_correlation_id

from quantfoundry_signals.provenance import build_provenance
from quantfoundry_signals.publisher import SignalPublisher
from quantfoundry_signals.symbol import parse_symbol
from quantfoundry_signals.types import (
    Horizon,
    Provenance,
    Signal,
    SignalAcceptResponse,
    SignalPayload,
)

_logger = get_logger("quantfoundry-signals")


@dataclass(frozen=True)
class PredictContext:
    """The state passed into a worker's :meth:`SignalWorker.predict`.

    ``symbol`` is the canonical symbol the worker is being asked about
    on this call. ``asof`` is the event-time the prediction should be
    stamped with — defaults to ``utcnow()`` when the worker is invoked
    via :meth:`SignalWorker.run_once` without an explicit asof.
    ``run_id`` is the run-id the SDK will stamp on all signals from
    this invocation; passed in so callers that build their own Signal
    list can reuse it.
    """

    symbol: str
    asof: str
    run_id: str
    worker_id: str


class SignalWorker(abc.ABC):
    """Subclass-and-implement-predict() base for QF signal workers."""

    # ── Class-level metadata (subclass must set these) ──────────────
    #: Stable model identity (e.g. ``"vol-forecast-spy-1d"``).
    model_id: str
    #: Opaque version string changed per training/deploy.
    model_version: str
    #: Kind registry entry — ``"point"``, ``"class"``, ``"vol_buy_directive"``,
    #: ``"vol_buy_exit"``, or a future-compatible string.
    kind: str
    #: Horizon for predictions this worker emits.
    horizon: Horizon

    def __init__(
        self,
        *,
        publisher: SignalPublisher | None = None,
        worker_id: str | None = None,
    ) -> None:
        # Make required class metadata explicit; AttributeError points
        # at the subclass with the missing attribute.
        for required in ("model_id", "model_version", "kind", "horizon"):
            if not hasattr(self, required):
                raise TypeError(
                    f"{type(self).__name__} must set class attribute {required!r}"
                )
        self._publisher = publisher
        self._owned_publisher = publisher is None
        self._worker_id_override = worker_id

    # ── Subclass hook ──────────────────────────────────────────────

    @abc.abstractmethod
    def predict(self, ctx: PredictContext) -> SignalPayload | Sequence[Signal]:
        """Compute one or more predictions.

        Return a single payload to emit one signal with the worker's
        configured ``model_id`` + ``kind`` + ``horizon`` and
        ``ctx.symbol``. Return a sequence of pre-built :class:`Signal`
        objects to control everything yourself; the SDK will still
        validate identity fields match the worker's metadata.
        """

    # ── Public API ─────────────────────────────────────────────────

    async def run_once(
        self,
        *,
        symbols: Iterable[str],
        asof: str | datetime | None = None,
        correlation_id: str | None = None,
    ) -> SignalAcceptResponse:
        """Run :meth:`predict` once per symbol and publish the batch.

        Returns the :class:`SignalAcceptResponse` from the ingress.
        Use :meth:`build_signals` if you want the typed batch without
        the publish round-trip.
        """
        signals = self.build_signals(symbols=symbols, asof=asof)
        publisher = self._ensure_publisher()
        cid_ctx = (
            with_correlation_id(correlation_id)
            if correlation_id is not None
            else _NullContext()
        )
        with cid_ctx:
            _logger.info(
                "worker.run_once",
                payload={
                    "model_id": self.model_id,
                    "model_version": self.model_version,
                    "kind": self.kind,
                    "symbol_count": len(signals),
                },
            )
            return await publisher.publish(signals)

    def build_signals(
        self,
        *,
        symbols: Iterable[str],
        asof: str | datetime | None = None,
    ) -> list[Signal]:
        """Build the :class:`Signal` records the worker would publish.

        Mirrors :meth:`run_once` minus the HTTP call — useful for
        tests, dry-runs, and the backfill driver (deferred to PR-2).
        """
        asof_s = _coerce_asof(asof)
        prov = build_provenance(worker_id=self._worker_id_override)
        ctx_factory_kwargs = {
            "asof": asof_s,
            "run_id": prov.run_id,
            "worker_id": prov.worker_id,
        }

        out: list[Signal] = []
        for symbol in symbols:
            # Canonical-symbol enforcement: bad shapes blow up here
            # rather than at the server, so workers see the error in
            # their own logs.
            parse_symbol(symbol)
            ctx = PredictContext(symbol=symbol, **ctx_factory_kwargs)
            result = self.predict(ctx)
            if isinstance(result, list | tuple):
                # Worker handed back fully-built signals — validate
                # identity matches the worker's metadata.
                for sig in result:
                    self._check_identity(sig)
                    out.append(sig)
            else:
                # Narrow off Sequence[Signal] for the type-checker;
                # `isinstance(result, list | tuple)` above is the runtime gate.
                out.append(self._wrap_payload(ctx, cast("SignalPayload", result), prov))
        return out

    async def aclose(self) -> None:
        """Close the owned publisher, if any."""
        if self._owned_publisher and self._publisher is not None:
            await self._publisher.aclose()

    async def __aenter__(self) -> SignalWorker:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    # ── Internals ──────────────────────────────────────────────────

    def _ensure_publisher(self) -> SignalPublisher:
        if self._publisher is None:
            self._publisher = SignalPublisher()
        return self._publisher

    def _wrap_payload(
        self,
        ctx: PredictContext,
        payload: SignalPayload,
        prov: Provenance,
    ) -> Signal:
        return Signal(
            model_id=self.model_id,
            model_version=self.model_version,
            symbol=ctx.symbol,
            asof=ctx.asof,
            horizon=self.horizon,
            kind=self.kind,
            payload=payload,
            provenance=prov,
        )

    def _check_identity(self, sig: Signal) -> None:
        if sig.model_id != self.model_id:
            raise ValueError(
                f"predict() returned signal with model_id={sig.model_id!r}, "
                f"expected {self.model_id!r}"
            )
        if sig.model_version != self.model_version:
            raise ValueError(
                f"predict() returned signal with model_version="
                f"{sig.model_version!r}, expected {self.model_version!r}"
            )
        if sig.kind != self.kind:
            raise ValueError(
                f"predict() returned signal with kind={sig.kind!r}, "
                f"expected {self.kind!r}"
            )


# ── Helpers ────────────────────────────────────────────────────────


def _coerce_asof(asof: str | datetime | None) -> str:
    """Return an RFC-3339 UTC ``asof`` string. ``None`` → ``utcnow()``."""
    if asof is None:
        return (
            datetime.now(tz=UTC)
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z")
        )
    if isinstance(asof, datetime):
        if asof.tzinfo is None:
            raise ValueError("asof datetime must be timezone-aware (use UTC)")
        return (
            asof.astimezone(UTC)
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z")
        )
    # str: trust the caller knows RFC-3339; the server will reject if not.
    return asof


class _NullContext:
    """Stand-in for ``with_correlation_id`` when no correlation ID was set."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, *_: object) -> None:
        return None


__all__ = [
    "PredictContext",
    "SignalWorker",
]
