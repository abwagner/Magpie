"""IBKR NT broker bridge — NATS-RPC service (QF-240, QF-353).

Symmetric counterpart to QF-237's Schwab bridge. The QF TS server sends
order intents over NATS request/reply; this module translates them to
IB orders (via :class:`IbkrSessionClient`, which wraps NT's
``InteractiveBrokersExecutionClient``) and publishes
:class:`BrokerExecReport` JSON on ``orders.exec_reports.ibkr``.

Subjects (per ``docs/tdd/broker-integration.md §3.1`` — every broker
bundle owns every ``orders.*`` subject; Schwab and IBKR are symmetric):

* ``orders.submit.ibkr``       — request: ``SubmitOrderRequest`` JSON;
                                 reply: ``SubmitOrderReply`` JSON.
* ``orders.cancel.ibkr``       — request: ``CancelOrderRequest`` JSON;
                                 reply: ``CancelOrderReply`` JSON.
* ``orders.status.ibkr``       — request: ``StatusRequest`` JSON;
                                 reply: ``BrokerOrderStatus`` JSON.
* ``orders.positions.ibkr``    — request: ``{}``;
                                 reply: ``BrokerPosition[]`` JSON.
* ``orders.exec_reports.ibkr`` — one-way pub of ``BrokerExecReport``.

Correlation: ``intent_id`` round-trips through the bridge on every exec
report originating from a QF submit (QF-353 added the bounded intent
cache that records ``broker_order_id → intent_id`` on submit). Orders
that originate inside NT — strategy-placed, not QF submits — have no
cached intent and get ``intent_id: null``; QF's TS observation path
drops those whose ``broker_order_id`` doesn't match a known
``audit_orders`` row (the NT-internal-orders contract in the TDD).

The bridge is intentionally I/O thin: it brokers messages, it doesn't
own retry policy or state — the QF TS server is the audit + retry
authority. A session error surfaces as an error reply; QF transitions
the order to ``submission_failed`` and the operator decides.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any

import nats

# Wire types live in magpie-schwab-nt because that package landed
# first. They are broker-agnostic — mirrors of src/types/order.ts. See
# this package's pyproject.toml for the dependency note + the planned
# extraction to a shared `magpie-broker-wire` package.
from magpie_schwab_nt.wire import (
    BrokerExecReport,
    BrokerOrderStatus,
    BrokerPosition,
    BrokerStatusStr,
    CancelOrderReply,
    CancelOrderRequest,
    ExecFillPayload,
    ExecReportEvent,
    StatusRequest,
    SubmitOrderReply,
    SubmitOrderRequest,
)
from magpie_subjects import (
    orders_cancel,
    orders_exec_reports,
    orders_positions,
    orders_status,
    orders_submit,
)
from nats.aio.client import Client as NatsClient
from nats.aio.msg import Msg
from nats.aio.subscription import Subscription as NatsSubscription

from magpie_ibkr_nt.session import (
    IbkrEvent,
    IbkrOrder,
    IbkrOrderNotFoundError,
    IbkrPosition,
    IbkrSessionClient,
    IbkrSessionError,
)

logger = logging.getLogger(__name__)

# Max number of (broker_order_id → intent_id) entries kept around so we
# can correlate exec-stream events back to the originating QF intent.
# LRU eviction past this — older orders fall back to `intent_id: None`
# (the TS observation path drops them per the NT-internal-orders
# contract). Mirrors magpie-schwab-nt's bridge cache.
_DEFAULT_INTENT_CACHE_SIZE = 4096


# ── Subjects ──────────────────────────────────────────────────────


def subjects_for(broker: str) -> dict[str, str]:
    """The five NATS subjects this bridge owns for a given broker.

    Symmetric with Schwab per ``docs/tdd/broker-integration.md §3.1`` —
    QF-353 added ``submit`` / ``cancel`` to the original observation-only
    (``status`` / ``positions`` / ``exec_reports``) set.
    """
    return {
        "submit": orders_submit(broker),
        "cancel": orders_cancel(broker),
        "status": orders_status(broker),
        "positions": orders_positions(broker),
        "exec_reports": orders_exec_reports(broker),
    }


# ── Pure helpers (unit-tested) ────────────────────────────────────


def intent_to_ibkr_body(req: SubmitOrderRequest) -> dict[str, Any]:
    """Translate a QF :class:`SubmitOrderRequest` to a normalized IB order spec.

    The IBKR session client (production) turns this dict into an NT
    ``Order`` + ``Contract`` and submits via NT's
    ``InteractiveBrokersExecutionClient`` — unlike Schwab there is no
    REST body, so the contract is "fields the NT side needs to build the
    order", named after IB / NT's own taxonomy:

    * ``action``      — ``BUY`` | ``SELL`` (IB has no separate short
                        instruction; a short is just a ``SELL`` that nets
                        the position negative).
    * ``orderType``   — ``MKT`` | ``LMT``.
    * ``quantity``    — order size (NT ``Quantity``).
    * ``lmtPrice``    — present only for ``LMT`` orders.
    * ``tif``         — ``DAY`` | ``GTC`` | ``IOC`` | ``FOK``.
    * ``symbol``      — the QF symbol; the session client resolves it to
                        an IB contract (conId / SMART routing).

    v1 scope: single-leg equity-style orders — the only shape the QF TS
    Execution Layer emits today (see ``server/execution/decide-price.ts``).
    Raises ``ValueError`` for shapes it doesn't recognize so the bridge
    surfaces a clear error reply instead of fabricating one.
    """
    if req.order_type not in ("market", "limit"):
        raise ValueError(f"unsupported order_type: {req.order_type}")
    if req.order_type == "limit" and req.limit_price is None:
        raise ValueError("order_type=limit requires limit_price")

    if req.is_combo:
        return _combo_body(req)

    body: dict[str, Any] = {
        "action": _direction_to_ib_action(req.direction),
        "orderType": "LIMIT" if req.order_type == "limit" else "MARKET",
        "quantity": req.quantity,
        "tif": _tif_to_ib_tif(req.time_in_force),
        "symbol": req.symbol,
    }
    if req.order_type == "limit":
        body["lmtPrice"] = req.limit_price
    return body


def _combo_body(req: SubmitOrderRequest) -> dict[str, Any]:
    """Multi-leg combo (QF-363) → IB BAG/spread order spec.

    Per the verified NT IBKR API a combo is ONE order against a ``BAG``
    (``OptionSpread``) instrument with ``comboLegs``, priced at the net
    ``lmtPrice``. The session client builds the ``OptionSpread`` + the
    ``ComboLeg`` list from this spec, resolving each leg's ``conId`` from
    right/strike/expiration when not pre-supplied. ``quantity`` is the
    number of combo units; per-leg size = units × ratio.
    """
    combo_legs: list[dict[str, Any]] = []
    for leg in req.legs:
        if leg.right not in ("call", "put"):
            raise ValueError(f"combo leg: unsupported right {leg.right!r}")
        if leg.side not in ("buy", "sell"):
            raise ValueError(f"combo leg: unsupported side {leg.side!r}")
        if leg.ratio <= 0:
            raise ValueError(f"combo leg: ratio must be positive, got {leg.ratio}")
        combo_legs.append(
            {
                "action": "BUY" if leg.side == "buy" else "SELL",
                "ratio": leg.ratio,
                "right": leg.right.upper()[0],  # "C" | "P" (IB right code)
                "strike": leg.strike,
                "expiration": leg.expiration,
                "optionSymbol": leg.option_symbol,
                "conId": leg.conid,  # None ⇒ session resolves at submit
            }
        )

    body: dict[str, Any] = {
        "secType": "BAG",
        "orderType": "LIMIT" if req.order_type == "limit" else "MARKET",
        "quantity": req.quantity,
        "tif": _tif_to_ib_tif(req.time_in_force),
        "symbol": req.symbol,  # underlying for the spread
        "comboLegs": combo_legs,
    }
    if req.order_type == "limit":
        body["lmtPrice"] = req.limit_price  # net debit (+) / credit (−) per unit
    return body


def _tif_to_ib_tif(tif: str) -> str:
    mapping = {
        "day": "DAY",
        "gtc": "GTC",
        "ioc": "IOC",
        "fok": "FOK",
    }
    if tif not in mapping:
        raise ValueError(f"unsupported time_in_force: {tif}")
    return mapping[tif]


def _direction_to_ib_action(direction: str) -> str:
    # QF's direction enum is "Long" | "Short" | "close". IB's order side
    # is just BUY / SELL — a short open and a long close are both SELL;
    # IB nets the resulting position. (Schwab distinguishes SELL_SHORT;
    # IB does not at the order-action level.)
    if direction == "Long":
        return "BUY"
    if direction in ("Short", "close"):
        return "SELL"
    raise ValueError(f"unsupported direction: {direction}")


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
    event: IbkrEvent, *, broker: str = "ibkr", intent_id: str | None = None
) -> BrokerExecReport | None:
    """Translate an :class:`IbkrEvent` to a :class:`BrokerExecReport`.

    Returns ``None`` for events that don't map to QF's wire format
    (e.g. ``replaced``, ``raw``). ``intent_id`` carries the originating
    QF intent when the event correlates to a recent QF submit (the
    bridge looks it up in its intent cache); it stays ``None`` for
    NT-initiated orders, and the TS observation path drops those whose
    ``broker_order_id`` doesn't match a known ``audit_orders`` row.
    """
    if event.broker_order_id is None:
        return None

    if event.kind == "submitted":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.broker_order_id,
            event="submitted",
            ts=event.ts,
            intent_id=intent_id,
        )
    if event.kind == "rejected":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.broker_order_id,
            event="rejected",
            ts=event.ts,
            intent_id=intent_id,
            rejection_reason=event.rejection_reason or "rejected (no reason text)",
        )
    if event.kind == "cancelled":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.broker_order_id,
            event="cancelled",
            ts=event.ts,
            intent_id=intent_id,
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
            intent_id=intent_id,
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


class _IntentCache:
    """Bounded LRU map of ``broker_order_id → intent_id``. Exec-stream
    events use this to correlate back to QF's originating intent. Mirrors
    magpie-schwab-nt's bridge cache.
    """

    def __init__(self, max_size: int = _DEFAULT_INTENT_CACHE_SIZE) -> None:
        self._d: OrderedDict[str, str] = OrderedDict()
        self._max = max_size

    def remember(self, broker_order_id: str, intent_id: str) -> None:
        self._d[broker_order_id] = intent_id
        self._d.move_to_end(broker_order_id)
        while len(self._d) > self._max:
            self._d.popitem(last=False)

    def lookup(self, broker_order_id: str) -> str | None:
        v = self._d.get(broker_order_id)
        if v is not None:
            self._d.move_to_end(broker_order_id)
        return v


class IbkrBrokerBridge:
    """NATS-RPC service translating QF order intents + IB session events.

    Subscribes to the four request/reply subjects (``submit`` / ``cancel``
    / ``status`` / ``positions``) and reads from an
    ``asyncio.Queue[IbkrEvent]`` feeding from NT's exec-event stream to
    publish ``orders.exec_reports.ibkr``. Submit replies record
    ``broker_order_id → intent_id`` in a bounded cache so subsequent exec
    reports round-trip the originating QF intent.

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
        intent_cache: _IntentCache | None = None,
    ) -> None:
        self._nc = nc
        self._session = session
        self._event_queue = event_queue
        self._broker = broker
        self._subjects = subjects_for(broker)
        self._subs: list[NatsSubscription] = []
        self._event_task: asyncio.Task[None] | None = None
        self._intents = intent_cache or _IntentCache()
        self._started = False

    async def start(self) -> None:
        """Subscribe to the four RPC subjects and (if a queue was
        provided) the exec-event fan-out task."""
        if self._started:
            return
        self._subs.append(
            await self._nc.subscribe(self._subjects["submit"], cb=self._on_submit)
        )
        self._subs.append(
            await self._nc.subscribe(self._subjects["cancel"], cb=self._on_cancel)
        )
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

    async def _on_submit(self, msg: Msg) -> None:
        try:
            data = json.loads(msg.data)
            req = SubmitOrderRequest.from_dict(data)
        except Exception as e:  # noqa: BLE001
            await self._reply(
                msg, SubmitOrderReply(error=f"malformed request: {e}").to_dict()
            )
            return
        try:
            body = intent_to_ibkr_body(req)
        except ValueError as e:
            await self._reply(msg, SubmitOrderReply(error=str(e)).to_dict())
            return
        try:
            broker_order_id = await self._session.submit_order(body)
        except IbkrSessionError as e:
            await self._reply(msg, SubmitOrderReply(error=f"ibkr: {e}").to_dict())
            return
        except Exception as e:  # noqa: BLE001
            await self._reply(
                msg, SubmitOrderReply(error=f"submit failed: {e}").to_dict()
            )
            return
        self._intents.remember(broker_order_id, req.intent_id)
        await self._reply(
            msg,
            SubmitOrderReply(broker_order_id=broker_order_id, accepted=True).to_dict(),
        )

    async def _on_cancel(self, msg: Msg) -> None:
        try:
            data = json.loads(msg.data)
            req = CancelOrderRequest.from_dict(data)
        except Exception as e:  # noqa: BLE001
            await self._reply(
                msg, CancelOrderReply(error=f"malformed request: {e}").to_dict()
            )
            return
        try:
            await self._session.cancel_order(req.broker_order_id)
        except IbkrSessionError as e:
            await self._reply(msg, CancelOrderReply(error=f"ibkr: {e}").to_dict())
            return
        except Exception as e:  # noqa: BLE001
            await self._reply(
                msg, CancelOrderReply(error=f"cancel failed: {e}").to_dict()
            )
            return
        await self._reply(msg, CancelOrderReply(accepted=True).to_dict())

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
                intent_id = (
                    self._intents.lookup(event.broker_order_id)
                    if event.broker_order_id is not None
                    else None
                )
                report = event_to_exec_report(
                    event, broker=self._broker, intent_id=intent_id
                )
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
    "intent_to_ibkr_body",
    "subjects_for",
]
