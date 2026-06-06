"""IBKR NT broker bridge — NATS-RPC service (QF-240).

Observation-only counterpart to QF-237's Schwab bridge. Subscribes to
NT's IB exec event stream (via :class:`IbkrSessionClient`) and
publishes :class:`BrokerExecReport` JSON on ``orders.exec_reports.ibkr``.
Serves status + positions request/reply on
``orders.status.ibkr`` / ``orders.positions.ibkr``.

Subjects (per ``docs/tdd/broker-integration.md §3``):

* ``orders.status.ibkr``       — request: ``StatusRequest`` JSON;
                                 reply: ``BrokerOrderStatus`` JSON.
* ``orders.positions.ibkr``    — request: ``{}``;
                                 reply: ``BrokerPosition[]`` JSON.
* ``orders.exec_reports.ibkr`` — one-way pub of ``BrokerExecReport``.

**No submit / cancel handlers.** NT owns the IB Gateway session by
design; QF doesn't submit IBKR orders (``docs/tdd/broker-integration.md``
§2.3). QF observes fills for orders NT placed and reconciles QF audit
state against IB Gateway via ``query_order``.

Correlation: unlike Schwab, IBKR orders never originate from a QF
submit. The bridge therefore always emits ``intent_id: null`` on its
exec reports; QF's TS observation path drops reports whose
``broker_order_id`` doesn't match a known QF audit_orders row (per the
NT-internal-orders contract in the TDD).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
from datetime import UTC, datetime
from typing import Any

import nats
from nats.aio.client import Client as NatsClient
from nats.aio.msg import Msg
from nats.aio.subscription import Subscription as NatsSubscription

# Wire types live in quantfoundry-schwab-nt because that package landed
# first. They are broker-agnostic — mirrors of src/types/order.ts. See
# this package's pyproject.toml for the dependency note + the planned
# extraction to a shared `quantfoundry-broker-wire` package.
from quantfoundry_schwab_nt.wire import (
    BrokerExecReport,
    BrokerOrderStatus,
    BrokerPosition,
    BrokerStatusStr,
    ExecFillPayload,
    ExecReportEvent,
    StatusRequest,
)

from quantfoundry_ibkr_nt.session import (
    IbkrEvent,
    IbkrOrder,
    IbkrOrderNotFoundError,
    IbkrPosition,
    IbkrSessionClient,
    IbkrSessionError,
)

logger = logging.getLogger(__name__)


# ── Subjects ──────────────────────────────────────────────────────


def subjects_for(broker: str) -> dict[str, str]:
    """The three NATS subjects this bridge owns (no submit/cancel)."""
    return {
        "status": f"orders.status.{broker}",
        "positions": f"orders.positions.{broker}",
        "exec_reports": f"orders.exec_reports.{broker}",
    }


# ── Pure helpers (unit-tested) ────────────────────────────────────


def ibkr_status_to_broker_status(ib_status: str) -> BrokerStatusStr:
    """Map IB's order status string to QF's broker-agnostic union.

    IB statuses per the API docs: ``PendingSubmit``, ``PendingCancel``,
    ``PreSubmitted``, ``Submitted``, ``ApiCancelled``, ``Cancelled``,
    ``Filled``, ``Inactive``. ``Inactive`` covers a few different
    terminal-ish states (rejected by exchange, account suspension,
    etc.) — we treat it as ``rejected`` here because the QF
    reconciliation policy only distinguishes between
    cancelled/rejected at the outcome level.
    """
    if ib_status == "Filled":
        return "filled"
    if ib_status in ("Cancelled", "ApiCancelled"):
        return "cancelled"
    if ib_status == "Inactive":
        return "rejected"
    if ib_status in ("PendingSubmit", "PreSubmitted", "Submitted"):
        return "working"
    if ib_status == "PendingCancel":
        # Mid-cancel; QF still tracks it as working since the cancel
        # may race with a fill. Reconciliation re-queries to disambiguate.
        return "working"
    return "unknown"


def derive_broker_status(order: IbkrOrder) -> BrokerStatusStr:
    """IB sometimes leaves ``status="Submitted"`` while filled_quantity
    has reached the order quantity (race between the orderStatus event
    and the execDetails event). Detect that and surface ``filled``
    rather than ``working``.
    """
    base = ibkr_status_to_broker_status(order.status)
    if base == "working" and order.quantity > 0:
        if order.filled_quantity >= order.quantity:
            return "filled"
        if order.filled_quantity > 0:
            return "partial_fill"
    return base


def ibkr_order_to_broker_status(
    order: IbkrOrder, broker_order_id: str
) -> BrokerOrderStatus:
    """Translate :class:`IbkrOrder` to TS-facing :class:`BrokerOrderStatus`."""
    return BrokerOrderStatus(
        broker_order_id=broker_order_id,
        status=derive_broker_status(order),
        filled_quantity=order.filled_quantity,
        average_fill_price=order.average_fill_price,
        rejection_reason=order.rejection_reason,
    )


def ibkr_position_to_broker_position(position: IbkrPosition) -> BrokerPosition:
    """Translate :class:`IbkrPosition` to TS-facing :class:`BrokerPosition`.

    IB tracks positions as signed quantities; QF's wire format is a
    direction enum + absolute quantity. Zero positions are dropped at
    the bridge layer (caller responsibility) so we don't surface that
    case here.
    """
    direction = "Long" if position.quantity >= 0 else "Short"
    return BrokerPosition(
        symbol=position.symbol,
        direction=direction,
        quantity=abs(position.quantity),
    )


def event_to_exec_report(
    event: IbkrEvent, *, broker: str = "ibkr"
) -> BrokerExecReport | None:
    """Translate an :class:`IbkrEvent` to a :class:`BrokerExecReport`.

    Returns ``None`` for events that don't map to QF's wire format
    (e.g. ``replaced``, ``raw``). Per the TDD's IBKR observation
    contract, ``intent_id`` is always ``None`` on the IBKR side —
    NT-initiated orders never have a QF intent_id; the TS observation
    path correlates by broker_order_id against audit_orders rows.
    """
    if event.broker_order_id is None:
        return None

    if event.kind == "submitted":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.broker_order_id,
            event="submitted",
            ts=event.ts,
            intent_id=None,
        )
    if event.kind == "rejected":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.broker_order_id,
            event="rejected",
            ts=event.ts,
            intent_id=None,
            rejection_reason=event.rejection_reason or "rejected (no reason text)",
        )
    if event.kind == "cancelled":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.broker_order_id,
            event="cancelled",
            ts=event.ts,
            intent_id=None,
        )
    if event.kind in ("filled", "partial_fill"):
        if event.fill_price is None or event.fill_quantity is None:
            logger.warning(
                "ibkr-bridge: fill event missing price/quantity; dropping",
                extra={
                    "broker_order_id": event.broker_order_id,
                    "kind": event.kind,
                },
            )
            return None
        fill_kind: ExecReportEvent = (
            "fill" if event.kind == "filled" else "partial_fill"
        )
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.broker_order_id,
            event=fill_kind,
            ts=event.ts,
            intent_id=None,
            fill=ExecFillPayload(
                fill_id=event.fill_id or _synth_fill_id(),
                price=event.fill_price,
                quantity=event.fill_quantity,
                fees=event.fill_fees,
            ),
        )
    # replaced / raw / unknown → not emitted.
    return None


def _synth_fill_id() -> str:
    """IB sometimes omits the executionId on a fill event; synthesize a
    stable-per-call id so QF's audit_fills dedup keys are honoured."""
    ts_ms = int(datetime.now(tz=UTC).timestamp() * 1000)
    return f"ibkr-fill-{ts_ms}-{secrets.token_hex(4)}"


# ── Bridge ────────────────────────────────────────────────────────


class IbkrBrokerBridge:
    """NATS-RPC service translating IB session events into QF wire format.

    Observation-only: subscribes to ``orders.status.ibkr`` and
    ``orders.positions.ibkr`` (request/reply), and reads from an
    ``asyncio.Queue[IbkrEvent]`` feeding from NT's exec-event stream
    to publish ``orders.exec_reports.ibkr``.

    Construct once per deployment with the session client + open NATS
    connection, then ``await bridge.start()``. ``stop()`` cleanly
    unsubscribes everything; idempotent.

    Not thread-safe — runs inside a single asyncio event loop.
    """

    def __init__(
        self,
        *,
        nc: NatsClient,
        session: IbkrSessionClient,
        event_queue: asyncio.Queue[IbkrEvent] | None = None,
        broker: str = "ibkr",
    ) -> None:
        self._nc = nc
        self._session = session
        self._event_queue = event_queue
        self._broker = broker
        self._subjects = subjects_for(broker)
        self._subs: list[NatsSubscription] = []
        self._event_task: asyncio.Task[None] | None = None
        self._started = False

    async def start(self) -> None:
        """Subscribe to status + positions request subjects and (if a
        queue was provided) the exec-event fan-out task."""
        if self._started:
            return
        self._subs.append(
            await self._nc.subscribe(self._subjects["status"], cb=self._on_status)
        )
        self._subs.append(
            await self._nc.subscribe(self._subjects["positions"], cb=self._on_positions)
        )
        if self._event_queue is not None:
            self._event_task = asyncio.create_task(self._event_loop())
        self._started = True
        logger.info(
            "IbkrBrokerBridge started",
            extra={"broker": self._broker, "subjects": list(self._subjects.values())},
        )

    async def stop(self) -> None:
        """Drain subscriptions + halt the event loop. Idempotent."""
        if not self._started:
            return
        for sub in self._subs:
            try:
                await sub.unsubscribe()
            except Exception as e:  # noqa: BLE001 — best-effort cleanup
                logger.warning("unsubscribe failed: %s", e)
        self._subs.clear()
        if self._event_task is not None:
            self._event_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):  # noqa: BLE001
                await self._event_task
            self._event_task = None
        self._started = False
        logger.info("IbkrBrokerBridge stopped", extra={"broker": self._broker})

    # ── NATS handlers ──

    async def _reply(
        self, msg: Msg, payload: dict[str, Any] | list[dict[str, Any]]
    ) -> None:
        if msg.reply:
            await self._nc.publish(msg.reply, json.dumps(payload).encode("utf-8"))

    async def _on_status(self, msg: Msg) -> None:
        try:
            data = json.loads(msg.data)
            req = StatusRequest.from_dict(data)
        except Exception as e:  # noqa: BLE001
            await self._reply(
                msg,
                BrokerOrderStatus(
                    broker_order_id="",
                    status="unknown",
                    filled_quantity=0.0,
                    average_fill_price=None,
                    rejection_reason=f"malformed request: {e}",
                ).to_dict(),
            )
            return
        try:
            order: IbkrOrder = await self._session.query_order(req.broker_order_id)
        except IbkrOrderNotFoundError:
            # Per the reconciliation contract: IB doesn't recognize the
            # order → reply with status="unknown". QF leaves it in
            # submitted and increments the broker_reconcile_unknown_total
            # metric.
            await self._reply(
                msg,
                BrokerOrderStatus(
                    broker_order_id=req.broker_order_id,
                    status="unknown",
                    filled_quantity=0.0,
                    average_fill_price=None,
                    rejection_reason=None,
                ).to_dict(),
            )
            return
        except IbkrSessionError as e:
            await self._reply(
                msg,
                BrokerOrderStatus(
                    broker_order_id=req.broker_order_id,
                    status="unknown",
                    filled_quantity=0.0,
                    average_fill_price=None,
                    rejection_reason=f"ibkr: {e}",
                ).to_dict(),
            )
            return
        status = ibkr_order_to_broker_status(order, req.broker_order_id)
        await self._reply(msg, status.to_dict())

    async def _on_positions(self, msg: Msg) -> None:
        try:
            positions = await self._session.list_positions()
        except IbkrSessionError as e:
            await self._reply(msg, {"error": f"list_positions failed: {e}"})
            return
        # Drop zero-quantity rows; they're IB book-keeping noise.
        out = [
            ibkr_position_to_broker_position(p).to_dict()
            for p in positions
            if p.quantity != 0
        ]
        await self._reply(msg, out)

    # ── exec-event stream → exec_reports.ibkr ──

    async def _event_loop(self) -> None:
        """Consume :class:`IbkrEvent` from the queue, translate to
        BrokerExecReport, publish. Runs until cancelled.
        """
        assert self._event_queue is not None
        while True:
            try:
                event = await self._event_queue.get()
            except asyncio.CancelledError:
                return
            try:
                report = event_to_exec_report(event, broker=self._broker)
                if report is None:
                    continue
                await self._publish_exec_report(report)
            except Exception as e:  # noqa: BLE001 — never let a bad event kill the loop
                logger.warning("ibkr-bridge: event translation failed: %s", e)

    async def _publish_exec_report(self, report: BrokerExecReport) -> None:
        try:
            payload = json.dumps(report.to_dict()).encode("utf-8")
            await self._nc.publish(self._subjects["exec_reports"], payload)
        except Exception as e:  # noqa: BLE001 — log + drop
            logger.warning("ibkr-bridge: exec_report publish failed: %s", e)


# ── Public API for service runners ────────────────────────────────


async def connect_and_run(
    *,
    nats_url: str,
    session: IbkrSessionClient,
    event_queue: asyncio.Queue[IbkrEvent] | None,
    broker: str = "ibkr",
) -> IbkrBrokerBridge:
    """Convenience runner: open a NATS connection + start the bridge.

    Returns the started bridge so the caller can await its lifetime
    (e.g. ``await asyncio.Event().wait()``) and ``stop()`` on shutdown.

    Wiring the actual NT IB adapter to produce the ``event_queue`` +
    implement :class:`IbkrSessionClient` is a deploy-time concern. A
    follow-up ticket adds the NT-side bindings (subscribes to
    ``MessageBus`` for ``OrderEvent`` / ``ExecutionReport`` and pushes
    into the queue).
    """
    nc = await nats.connect(nats_url)
    bridge = IbkrBrokerBridge(
        nc=nc,
        session=session,
        event_queue=event_queue,
        broker=broker,
    )
    await bridge.start()
    return bridge


__all__ = [
    "IbkrBrokerBridge",
    "connect_and_run",
    "derive_broker_status",
    "event_to_exec_report",
    "ibkr_order_to_broker_status",
    "ibkr_position_to_broker_position",
    "ibkr_status_to_broker_status",
    "subjects_for",
]
