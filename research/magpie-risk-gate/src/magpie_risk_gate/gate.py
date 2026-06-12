"""QFRiskGate — NT RiskEngine subclass that consults QF over NATS-RPC.

Skeleton for QF-312:
  - subclass NT's RiskEngine and override ``_check_order``
  - NATS-RPC client wired to orders.gate.<broker> per §3.1
  - Config plumbing via QFRiskGateConfig
  - Connection management (connect on first use, close on shutdown)

Out of scope for this ticket (separate Plane tickets cover):
  - Closes-only fail-open + classifier (QF-313)
  - Parent-budget per-intent evaluation + envelope handoff (QF-314)
  - Bundle launcher wiring (depends on this skeleton + the parent-budget
    work landing; lives in the bundle-launcher tickets)

The current ``_check_order`` returns ``approve`` only when the gate
RPC returns approve. On RPC timeout or connection failure, this v1
skeleton returns ``reject`` — QF-313 swaps in the closes-only
fail-open path that gives NT the chance to evaluate closing orders
against its local config when QF is unreachable.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from magpie_risk_gate.config import QFRiskGateConfig
from magpie_risk_gate.wire import GateRequest, GateResponse

if TYPE_CHECKING:
    from nats.aio.client import Client as NatsClient


_LOGGER = logging.getLogger(__name__)


class QFRiskGateRpcError(Exception):
    """Raised when the gate RPC fails (timeout, connection, payload)."""


class QFRiskGate:
    """Skeleton for the NT RiskEngine subclass.

    The real production class will inherit from
    ``nautilus_trader.live.risk.LiveRiskEngine`` (or the equivalent
    extension point — confirmed at QF-314 wiring time when the bundle
    launcher integration lands). The skeleton stays decoupled from
    NT's concrete RiskEngine type so tests can exercise the RPC
    behavior without a running TradingNode.
    """

    def __init__(
        self,
        config: QFRiskGateConfig,
        nats_factory: Any | None = None,
    ) -> None:
        """Initialize with config + optional NATS factory.

        ``nats_factory`` is a callable returning an awaitable that
        resolves to a connected ``nats.aio.client.Client``. Tests pass
        a fake; production code passes the real ``nats.connect``
        factory bound with the configured URL.
        """

        from magpie_risk_gate.envelopes import EnvelopeRegistry

        self._config = config
        self._nats_factory = nats_factory
        self._nats: NatsClient | None = None
        self._connect_lock = asyncio.Lock()
        self._closed = False
        # QF-314 — in-memory registry of approved envelopes for the
        # parent-budget fast-path. populated on approve, drained on
        # revoke (see _handle_revoke_request) or close.
        self._envelopes = EnvelopeRegistry()
        # QF-314 — task tracking the revoke subscriber so close() can
        # cancel it cleanly.
        self._revoke_sub_task: asyncio.Task[None] | None = None

    @property
    def config(self) -> QFRiskGateConfig:
        return self._config

    @property
    def is_connected(self) -> bool:
        return self._nats is not None and not self._closed

    @property
    def envelopes(self) -> Any:
        """Test introspection on the envelope registry (QF-314)."""
        return self._envelopes

    async def _ensure_connected(self) -> NatsClient:
        # Single-flight connection: only one connect attempt at a time.
        async with self._connect_lock:
            if self._closed:
                msg = "QFRiskGate is closed; create a new instance"
                raise RuntimeError(msg)
            if self._nats is not None:
                return self._nats
            if self._nats_factory is None:
                # Lazy import so test environments without nats-py
                # installed can still import the module for type-only
                # purposes. Real bundles always have nats-py.
                import nats

                self._nats = await nats.connect(self._config.nats_url)
            else:
                self._nats = await self._nats_factory()
            return self._nats

    async def close(self) -> None:
        """Close the NATS connection if open."""
        self._closed = True
        if self._revoke_sub_task is not None:
            self._revoke_sub_task.cancel()
            try:
                await self._revoke_sub_task
            except (asyncio.CancelledError, Exception):
                _LOGGER.debug("QFRiskGate: revoke task ended on close", exc_info=True)
            finally:
                self._revoke_sub_task = None
        if self._nats is not None:
            try:
                await self._nats.drain()
            except Exception:
                _LOGGER.debug("QFRiskGate: drain failed; closing anyway", exc_info=True)
            finally:
                self._nats = None
        self._envelopes.clear()

    async def _qf_gate_rpc(self, request: GateRequest) -> GateResponse:
        """Send the gate request over NATS-RPC and return the parsed reply.

        Raises:
            QFRiskGateRpcError: on timeout, connection failure, or
                malformed reply. Callers decide how to interpret the
                failure (QF-313 wires the fail-open / fail-closed
                branches).
        """

        nc = await self._ensure_connected()
        timeout_sec = self._config.gate_timeout_ms / 1000.0
        try:
            msg = await nc.request(
                self._config.gate_subject,
                request.to_json(),
                timeout=timeout_sec,
            )
        except TimeoutError as exc:
            raise QFRiskGateRpcError(
                f"gate RPC timed out after {self._config.gate_timeout_ms}ms"
            ) from exc
        except Exception as exc:
            # ConnectionClosed and friends from nats-py land here.
            raise QFRiskGateRpcError(f"gate RPC connection failure: {exc}") from exc
        try:
            return GateResponse.from_json(msg.data)
        except Exception as exc:
            raise QFRiskGateRpcError(f"gate RPC payload parse failure: {exc}") from exc

    async def start_revoke_subscriber(self) -> None:
        """Subscribe to orders.gate.revoke.<broker> (QF-314 / §3.5).

        The subscription handler drops the named envelope from the
        local registry and replies with ``revoked`` or
        ``envelope_unknown``. Idempotent: a duplicate revoke on an
        unknown envelope succeeds.

        Production wires this once at TradingNode startup. Tests can
        call it directly when they want the live subscription path
        instead of driving _handle_revoke_request synthetically.
        """

        if self._revoke_sub_task is not None:
            return
        nc = await self._ensure_connected()
        subject = f"{self._config.gate_subject_prefix}.revoke.{self._config.broker}"
        sub = await nc.subscribe(subject)

        async def consume() -> None:
            async for msg in sub.messages:
                try:
                    reply = self._handle_revoke_request(msg.data)
                except Exception:
                    _LOGGER.exception("QFRiskGate: revoke handler threw")
                    continue
                if msg.reply:
                    try:
                        await nc.publish(msg.reply, reply)
                    except Exception:
                        _LOGGER.exception("QFRiskGate: revoke reply publish failed")

        self._revoke_sub_task = asyncio.create_task(consume())

    def _handle_revoke_request(self, raw: bytes) -> bytes:
        """Parse + apply a RevokeRequest; return the RevokeResponse bytes.

        Pulled out as a sync method so unit tests can exercise the
        registry-mutation logic without spinning up a NATS subscription.
        """
        # Lazy import keeps wire.py off the hot-path import graph and
        # lets the revoke types live alongside the gate request types.
        from magpie_risk_gate.wire import RevokeRequest, RevokeResponse

        req = RevokeRequest.from_json(raw)
        existed = self._envelopes.revoke(req.envelope_id)
        if existed:
            _LOGGER.info(
                "gate.envelope.revoked",
                extra={
                    "event": "gate.envelope.revoked",
                    "broker": self._config.broker,
                    "envelope_id": req.envelope_id,
                    "reason": req.reason,
                },
            )
            return RevokeResponse(status="revoked").to_json()
        _LOGGER.info(
            "gate.envelope.revoke_unknown",
            extra={
                "event": "gate.envelope.revoke_unknown",
                "broker": self._config.broker,
                "envelope_id": req.envelope_id,
                "reason": req.reason,
            },
        )
        return RevokeResponse(status="envelope_unknown").to_json()

    async def check_order(self, request: GateRequest) -> GateResponse:
        """Public ``_check_order`` analogue with §4 fail-open path.

        QF-313 wires the closes-only fail-open path here. Behavior:

          1. Try the gate RPC.
          2. On success → return the QF verdict verbatim.
          3. On QFRiskGateRpcError (timeout / connection failure /
             malformed reply):
             a. fail_open_mode == "fail_closed" → return reject
                (gate_unavailable_open_blocked).
             b. Else (closes_only): classify the order via §4.1's
                closing classifier. If strictly closing → synthetic
                approve so NT submits the close. Otherwise → reject
                (gate_unavailable_open_blocked).

        The fail-open path produces a synthetic GateResponse with
        ``intent_id=""`` since QF didn't mint one. NT's local-config
        floor (§4.2) is the real safety net for closes during the
        outage — the production subclass will call
        ``super()._check_order`` in this branch to apply NT's
        mechanical limits. QF-313 doesn't have the NT base class yet
        (skeleton), so the structural log marks the fail-open decision
        and operators see it via QF-314's alert wiring.
        """

        # QF-314 — child orders under an already-approved envelope
        # bypass the gate RPC entirely. The plugin still applies NT's
        # mechanical floor (rate / per-order qty / notional / balance)
        # via super()._check_order in the production subclass; this
        # skeleton fast-paths to approve and lets the integrating
        # bundle wire the floor in.
        if request.parent_order_id is not None and self._envelopes.contains(
            request.parent_order_id
        ):
            _LOGGER.debug(
                "gate.child.fast_path",
                extra={
                    "event": "gate.child.fast_path",
                    "broker": self._config.broker,
                    "envelope_id": request.parent_order_id,
                },
            )
            return GateResponse(
                decision="approve",
                reason=None,
                intent_id="",
                envelope_id=request.parent_order_id,
            )
        # A child whose envelope is no longer known (revoked) falls
        # through to a fresh RPC so QF re-evaluates as a new parent.
        # The plugin's child will get a new envelope_id if approved.
        try:
            response = await self._qf_gate_rpc(request)
        except QFRiskGateRpcError as exc:
            return self._apply_fail_open(request, exc)
        # QF-314 — register the envelope on parent approvals so
        # subsequent children fast-path. Child orders that fell
        # through (revoked envelope) also re-register here.
        if response.decision == "approve" and response.envelope_id:
            self._envelopes.add(response.envelope_id)
        return response

    def _apply_fail_open(
        self, request: GateRequest, exc: QFRiskGateRpcError
    ) -> GateResponse:
        """Synthesize a GateResponse when the QF RPC failed (§4)."""

        from magpie_risk_gate.classifier import is_strictly_closing

        if self._config.fail_open_mode == "fail_closed":
            _LOGGER.warning(
                "gate.fail_open.blocked_open",
                extra={
                    "event": "gate.fail_open.blocked_open",
                    "mode": "fail_closed",
                    "broker": self._config.broker,
                    "strategy_id": request.strategy_id,
                    "error": str(exc),
                },
            )
            return GateResponse(
                decision="reject",
                reason="gate_unavailable_open_blocked",
                intent_id="",
                envelope_id=None,
            )

        position_qty = (
            request.current_position[0] if request.current_position is not None else 0
        )
        closing = is_strictly_closing(
            current_position_qty=position_qty,
            side=request.intent.direction,
            order_qty=request.intent.quantity,
        )
        if closing:
            _LOGGER.warning(
                "gate.fail_open.allowed_close",
                extra={
                    "event": "gate.fail_open.allowed_close",
                    "mode": "closes_only",
                    "broker": self._config.broker,
                    "strategy_id": request.strategy_id,
                    "current_position_qty": position_qty,
                    "side": request.intent.direction,
                    "order_qty": request.intent.quantity,
                    "error": str(exc),
                },
            )
            return GateResponse(
                decision="approve",
                reason=None,
                intent_id="",
                envelope_id=None,
            )
        _LOGGER.warning(
            "gate.fail_open.blocked_open",
            extra={
                "event": "gate.fail_open.blocked_open",
                "mode": "closes_only",
                "broker": self._config.broker,
                "strategy_id": request.strategy_id,
                "current_position_qty": position_qty,
                "side": request.intent.direction,
                "order_qty": request.intent.quantity,
                "error": str(exc),
            },
        )
        return GateResponse(
            decision="reject",
            reason="gate_unavailable_open_blocked",
            intent_id="",
            envelope_id=None,
        )
