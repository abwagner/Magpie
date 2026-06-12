"""Schwab NT broker bridge — NATS-RPC service (QF-237).

Service-side counterpart to the TS adapter that landed in QF-233. The
QF TS server sends order intents over NATS request/reply; this module
translates them to Schwab REST calls (via :class:`SchwabRestExecClient`)
and publishes execution reports back on the broker-specific pub
subject.

Subjects (per ``docs/tdd/broker-integration.md §3``):

* ``orders.submit.schwab``      — request: ``SubmitOrderRequest`` JSON;
                                  reply: ``SubmitOrderReply`` JSON.
* ``orders.cancel.schwab``      — request: ``CancelOrderRequest`` JSON;
                                  reply: ``CancelOrderReply`` JSON.
* ``orders.status.schwab``      — request: ``StatusRequest`` JSON;
                                  reply: ``BrokerOrderStatus`` JSON.
* ``orders.positions.schwab``   — request: ``{}`` (portfolio scope is
                                  one Schwab account per deployment);
                                  reply: ``BrokerPosition[]`` JSON (each
                                  carries the raw Schwab row for QF-272's
                                  /api/positions parser).
* ``orders.accounts.schwab``    — request: ``{}``; reply: ``AccountInfo[]``
                                  JSON (account number / hash / type; QF-272).
* ``orders.exec_reports.schwab``— one-way pub of ``BrokerExecReport``.

Correlation: per the TDD, ``intent_id`` round-trips through the bridge
on every exec report originating from a QF submit. NT-internal orders
(ones whose ``broker_order_id`` we haven't seen in a recent submit
reply) get ``intent_id: null`` and the TS observation path drops them.

The bridge is intentionally I/O thin: it brokers messages, it doesn't
own retry policy or state — the QF TS server is the audit + retry
authority. If Schwab's REST returns 5xx the bridge surfaces it as an
error reply; QF then transitions the order to ``submission_failed``
and the operator decides.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import nats
from magpie_subjects import (
    orders_accounts,
    orders_cancel,
    orders_exec_reports,
    orders_positions,
    orders_status,
    orders_submit,
)
from nats.aio.client import Client as NatsClient
from nats.aio.msg import Msg
from nats.aio.subscription import Subscription as NatsSubscription

from magpie_schwab_nt.account_activity import (
    FillEvent,
    OrderEvent,
    parse_account_activity_row,
)
from magpie_schwab_nt.exec_client import (
    SchwabAccountRef,
    SchwabExecError,
    SchwabOrder,
    SchwabPosition,
    SchwabRestExecClient,
)
from magpie_schwab_nt.order_status import derive_order_status
from magpie_schwab_nt.streaming import Subscription as StreamerSubscription
from magpie_schwab_nt.wire import (
    AccountInfo,
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

logger = logging.getLogger(__name__)

# Max number of (broker_order_id → intent_id) entries kept around so we
# can correlate ACCT_ACTIVITY events back to the originating QF intent.
# Hits LRU eviction after this — older orders fall back to
# `intent_id: None` (the TS observation path drops them silently per
# the TDD's NT-internal-orders contract).
_DEFAULT_INTENT_CACHE_SIZE = 4096


# ── Subjects ──────────────────────────────────────────────────────


# QF-246 — single-account QF-237 deploys subscribe to the bare
# `orders.submit.schwab` family. When account_id == this sentinel the
# bridge drops the suffix so those deploys keep working unmodified.
DEFAULT_ACCOUNT_ID = "default"

# QF-246 — account_id is interpolated directly into NATS subjects (and a
# malicious value could inject NATS wildcards `>` / `*` or the `.` token
# separator to subscribe to unintended subjects). Mirror the TS slug rule
# (brokers-config.ts SLUG_RE) so the Python bootstrap rejects anything but
# `[a-z0-9_-]+`. The empty-string case is handled before this is applied
# (it falls back to DEFAULT_ACCOUNT_ID).
_ACCOUNT_ID_RE = re.compile(r"^[a-z0-9_-]+$")

# QF-246 — the bridge brokers every order submission + execution report,
# so a redirected NATS connection is a credential/interception vector. We
# only allow loopback hosts; an attacker who tampers with the per-account
# EnvironmentFile cannot redirect the process to a foreign NATS server.
_ALLOWED_NATS_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def subjects_for(broker: str, account_id: str = DEFAULT_ACCOUNT_ID) -> dict[str, str]:
    """The NATS subjects this bridge owns for a given broker + account.

    QF-246 — M12-4: per-account namespacing. Each of the five RPC
    subjects (plus accounts + exec_reports) carries an ``.<account_id>``
    suffix so N bridge processes can subscribe to disjoint subjects.
    Backward-compat: when ``account_id == "default"`` the suffix is
    dropped, leaving the bare ``orders.submit.<broker>`` shape QF-237's
    single-account deploys already subscribe to.
    """
    suffix = "" if account_id == DEFAULT_ACCOUNT_ID else f".{account_id}"
    return {
        # QF-335 builders own the base subject; QF-246 appends the
        # per-account suffix ("" for "default", ".<account_id>" otherwise).
        "submit": orders_submit(broker) + suffix,
        "cancel": orders_cancel(broker) + suffix,
        "status": orders_status(broker) + suffix,
        "positions": orders_positions(broker) + suffix,
        "accounts": orders_accounts(broker) + suffix,
        "exec_reports": orders_exec_reports(broker) + suffix,
    }


# ── Pure helpers (unit-tested) ────────────────────────────────────


def intent_to_schwab_body(req: SubmitOrderRequest) -> dict[str, Any]:
    """Translate a QF :class:`SubmitOrderRequest` to a Schwab REST order body.

    v1 scope: single-leg equity-style orders (the only shape the QF TS
    Execution Layer currently emits — see ``server/execution/decide-price.ts``).
    Options + multi-leg complex orders are deferred to follow-ups; this
    builder raises ``ValueError`` for shapes it doesn't recognize so the
    bridge surfaces a clear error reply instead of fabricating one.

    Schwab REST taxonomy:

    * ``orderType``        — ``MARKET`` | ``LIMIT``
    * ``session``          — ``NORMAL`` (regular trading hours; we don't
                             route extended-hours from QF today)
    * ``duration``         — ``DAY`` | ``GOOD_TILL_CANCEL`` | ``FILL_OR_KILL``
                             (Schwab also has ``IMMEDIATE_OR_CANCEL`` for IOC)
    * ``orderStrategyType``— ``SINGLE`` for plain single-leg orders.
    * ``orderLegCollection``— one ``{instruction, quantity, instrument}`` per leg.
                              QF direction maps to BUY / SELL / SELL_SHORT.
    """
    if req.order_type not in ("market", "limit"):
        raise ValueError(f"unsupported order_type: {req.order_type}")
    if req.order_type == "limit" and req.limit_price is None:
        raise ValueError("order_type=limit requires limit_price")

    body: dict[str, Any] = {
        "orderType": "LIMIT" if req.order_type == "limit" else "MARKET",
        "session": "NORMAL",
        "duration": _tif_to_schwab_duration(req.time_in_force),
        "orderStrategyType": "SINGLE",
        "orderLegCollection": [
            {
                "instruction": _direction_to_instruction(req.direction),
                "quantity": req.quantity,
                "instrument": {
                    "symbol": req.symbol,
                    "assetType": "EQUITY",
                },
            }
        ],
    }
    if req.order_type == "limit":
        body["price"] = req.limit_price
    return body


def _tif_to_schwab_duration(tif: str) -> str:
    mapping = {
        "day": "DAY",
        "gtc": "GOOD_TILL_CANCEL",
        "ioc": "IMMEDIATE_OR_CANCEL",
        "fok": "FILL_OR_KILL",
    }
    if tif not in mapping:
        raise ValueError(f"unsupported time_in_force: {tif}")
    return mapping[tif]


def _direction_to_instruction(direction: str) -> str:
    # QF's direction enum is "Long" | "Short" | "close". Schwab's
    # instructions are BUY / SELL / SELL_SHORT / BUY_TO_COVER. For v1
    # we map Long → BUY, Short → SELL_SHORT, close → SELL. This is
    # equity-only; an options-aware mapping is a follow-up.
    if direction == "Long":
        return "BUY"
    if direction == "Short":
        return "SELL_SHORT"
    if direction == "close":
        return "SELL"
    raise ValueError(f"unsupported direction: {direction}")


def schwab_order_to_broker_status(
    order: SchwabOrder, broker_order_id: str
) -> BrokerOrderStatus:
    """Map a :class:`SchwabOrder` to the TS-facing ``BrokerOrderStatus``."""
    nt_status = derive_order_status(order.status, order.filled_quantity, order.quantity)
    status_str = _nt_status_to_broker_status(nt_status)
    avg_price = _average_fill_price_from_order(order)
    rejection = _rejection_reason_from_order(order)
    return BrokerOrderStatus(
        broker_order_id=broker_order_id,
        status=status_str,
        filled_quantity=order.filled_quantity,
        average_fill_price=avg_price,
        rejection_reason=rejection,
    )


def _nt_status_to_broker_status(nt_status: str) -> BrokerStatusStr:
    # Surfaces the broker-facing strings the TS BrokerOrderStatus union
    # expects. PENDING_* states collapse to "working".
    if nt_status == "FILLED":
        return "filled"
    if nt_status == "PARTIALLY_FILLED":
        return "partial_fill"
    if nt_status in ("CANCELED", "EXPIRED"):
        return "cancelled"
    if nt_status in ("REJECTED", "DENIED"):
        return "rejected"
    if nt_status in (
        "ACCEPTED",
        "SUBMITTED",
        "INITIALIZED",
        "RELEASED",
        "TRIGGERED",
        "PENDING_UPDATE",
        "PENDING_CANCEL",
    ):
        return "working"
    return "unknown"


def _average_fill_price_from_order(order: SchwabOrder) -> float | None:
    """Schwab's per-leg ``executionPrice`` or ``averagePrice`` lives in
    the raw payload; pull the most useful summary. None when unfilled."""
    if order.filled_quantity <= 0:
        return None
    avg = order.raw.get("averagePrice") if hasattr(order, "raw") else None
    if isinstance(avg, (int, float)):
        return float(avg)
    return None


def _rejection_reason_from_order(order: SchwabOrder) -> str | None:
    """Schwab puts rejection text in ``statusDescription`` or a
    ``rejectReason`` field depending on the path."""
    if order.status not in ("REJECTED",):
        return None
    raw = getattr(order, "raw", {}) or {}
    for k in ("statusDescription", "rejectReason", "cancelReason"):
        v = raw.get(k)
        if v:
            return str(v)
    return "rejected (no reason text)"


def schwab_position_to_broker_position(
    position: SchwabPosition,
) -> BrokerPosition:
    """Map :class:`SchwabPosition` to the TS-facing :class:`BrokerPosition`.

    Schwab tracks ``long_quantity`` + ``short_quantity`` separately on
    the same row. We collapse to one direction per QF position record:
    whichever side has the larger absolute quantity wins; ties (both
    zero, or rarely both populated during settle) report as Long with
    the net quantity.
    """
    if position.short_quantity > position.long_quantity:
        return BrokerPosition(
            symbol=position.instrument_symbol,
            direction="Short",
            quantity=position.short_quantity,
            raw=position.raw or None,
        )
    return BrokerPosition(
        symbol=position.instrument_symbol,
        direction="Long",
        quantity=position.long_quantity,
        raw=position.raw or None,
    )


def schwab_account_ref_to_account_info(ref: SchwabAccountRef) -> AccountInfo:
    """Map an :class:`SchwabAccountRef` to the TS-facing :class:`AccountInfo`."""
    return AccountInfo(
        account_number=ref.account_number,
        hash_value=ref.hash_value,
        account_type=ref.account_type,
    )


def event_to_exec_report(
    event: OrderEvent,
    *,
    broker: str = "schwab",
    intent_id: str | None,
    account_id: str | None = None,
    ts: str | None = None,
) -> BrokerExecReport | None:
    """Translate an ACCT_ACTIVITY :class:`OrderEvent` to a :class:`BrokerExecReport`.

    Returns ``None`` for events that don't map to QF's wire format (e.g.
    ``subscribed``, ``raw``, ``error``, ``replaced``). The bridge logs
    those for forensics but doesn't fan them out — QF doesn't react to
    them at the OrderPlane layer.
    """
    if event.order_id is None:
        return None  # can't correlate without a broker_order_id

    ts_str = ts or _utc_now_iso()

    if event.kind == "submitted":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.order_id,
            event="submitted",
            ts=ts_str,
            intent_id=intent_id,
            account_id=account_id,
        )
    if event.kind == "rejected":
        reason = _rejection_reason_from_event(event)
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.order_id,
            event="rejected",
            ts=ts_str,
            intent_id=intent_id,
            rejection_reason=reason,
            account_id=account_id,
        )
    if event.kind == "canceled":
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.order_id,
            event="cancelled",
            ts=ts_str,
            intent_id=intent_id,
            account_id=account_id,
        )
    if event.kind in ("filled", "partial_fill") and isinstance(event, FillEvent):
        fill_event_kind: ExecReportEvent = (
            "fill" if event.kind == "filled" else "partial_fill"
        )
        fill_id = _fill_id_from_event(event)
        return BrokerExecReport(
            broker=broker,
            broker_order_id=event.order_id,
            event=fill_event_kind,
            ts=ts_str,
            intent_id=intent_id,
            account_id=account_id,
            fill=ExecFillPayload(
                fill_id=fill_id,
                price=event.fill_price,
                quantity=event.fill_quantity,
                fees=_fees_from_event(event),
            ),
        )
    # accepted / replaced / raw / error / subscribed → not emitted.
    return None


def _rejection_reason_from_event(event: OrderEvent) -> str:
    raw = event.raw_payload or {}
    for k in ("rejectReason", "statusDescription", "reason", "text"):
        v = raw.get(k)
        if v:
            return str(v)
    return "rejected (no reason text)"


def _fees_from_event(event: FillEvent) -> float | None:
    raw = event.raw_payload or {}
    fee = raw.get("commission") or raw.get("fees")
    if isinstance(fee, (int, float)):
        return float(fee)
    return None


def _fill_id_from_event(event: FillEvent) -> str:
    """Schwab's ACCT_ACTIVITY fill rows don't carry a stable fill ID
    Schwab-side. We synthesize one: ULID-style timestamp + 8 random
    hex. Stable per call (events fan out at most once), so the QF
    audit layer's dedup keys are honoured.
    """
    raw = event.raw_payload or {}
    for k in ("executionId", "fillId", "execId"):
        v = raw.get(k)
        if v:
            return str(v)
    return _synth_id(prefix="schwab-fill")


def _synth_id(prefix: str) -> str:
    ts_ms = int(datetime.now(tz=UTC).timestamp() * 1000)
    return f"{prefix}-{ts_ms}-{secrets.token_hex(4)}"


def _utc_now_iso() -> str:
    return (
        datetime.now(tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


# ── Bridge ────────────────────────────────────────────────────────


class _IntentCache:
    """Bounded LRU map of ``broker_order_id → intent_id``. ACCT_ACTIVITY
    events use this to correlate back to QF's originating intent.
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


class SchwabBrokerBridge:
    """NATS-RPC service translating QF order intents into Schwab REST calls.

    Construct once per deployment with the exec client + streamer + open
    NATS connection, then ``await bridge.start()`` to begin servicing
    requests. ``stop()`` cleanly unsubscribes everything (use during
    operator-driven shutdown so in-flight replies aren't dropped).

    The bridge is not thread-safe — it expects to run inside a single
    asyncio event loop. Multi-account deployment (QF-246) runs one bridge
    process per account, each constructed with a distinct ``account_id``
    so it subscribes to disjoint per-account subjects. The legacy
    one-account-per-deployment shape (QF-237) is the ``account_id ==
    "default"`` case, which keeps the bare un-suffixed subjects.
    """

    def __init__(
        self,
        *,
        nc: NatsClient,
        exec_client: SchwabRestExecClient,
        account_activity_queue: asyncio.Queue[Any] | None = None,
        broker: str = "schwab",
        account_id: str = DEFAULT_ACCOUNT_ID,
        intent_cache: _IntentCache | None = None,
    ) -> None:
        self._nc = nc
        self._exec = exec_client
        self._activity_queue = account_activity_queue
        self._broker = broker
        self._account_id = account_id
        self._subjects = subjects_for(broker, account_id)
        self._subs: list[NatsSubscription] = []
        self._activity_task: asyncio.Task[None] | None = None
        self._intents = intent_cache or _IntentCache()
        self._started = False

    async def start(self) -> None:
        """Subscribe to the RPC subjects and (if a queue was provided)
        the ACCT_ACTIVITY fan-out task."""
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
        self._subs.append(
            await self._nc.subscribe(self._subjects["accounts"], cb=self._on_accounts)
        )
        if self._activity_queue is not None:
            self._activity_task = asyncio.create_task(self._account_activity_loop())
        self._started = True
        logger.info(
            "SchwabBrokerBridge started",
            extra={
                "broker": self._broker,
                "account_id": self._account_id,
                "subjects": list(self._subjects.values()),
            },
        )

    async def stop(self) -> None:
        """Drain subscriptions + halt the activity loop. Idempotent."""
        if not self._started:
            return
        for sub in self._subs:
            try:
                await sub.unsubscribe()
            except Exception as e:  # noqa: BLE001 — best-effort cleanup
                logger.warning("unsubscribe failed: %s", e)
        self._subs.clear()
        if self._activity_task is not None:
            self._activity_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):  # noqa: BLE001
                await self._activity_task
            self._activity_task = None
        self._started = False
        logger.info(
            "SchwabBrokerBridge stopped",
            extra={"broker": self._broker, "account_id": self._account_id},
        )

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
            body = intent_to_schwab_body(req)
        except ValueError as e:
            await self._reply(msg, SubmitOrderReply(error=str(e)).to_dict())
            return
        try:
            broker_order_id = await self._exec.submit_order(body)
        except SchwabExecError as e:
            await self._reply(msg, SubmitOrderReply(error=f"schwab: {e}").to_dict())
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
            await self._exec.cancel_order(req.broker_order_id)
        except SchwabExecError as e:
            await self._reply(msg, CancelOrderReply(error=f"schwab: {e}").to_dict())
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
            order = await self._exec.query_order(req.broker_order_id)
        except SchwabExecError:
            # Schwab returns 404 for unknown order ids; surface as
            # `unknown` status per the TDD's reconciliation contract.
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
        status = schwab_order_to_broker_status(order, req.broker_order_id)
        await self._reply(msg, status.to_dict())

    async def _on_positions(self, msg: Msg) -> None:
        try:
            positions = await self._exec.list_positions()
        except SchwabExecError:
            await self._reply(msg, {"error": "list_positions failed"})
            return
        out = [schwab_position_to_broker_position(p).to_dict() for p in positions]
        await self._reply(msg, out)

    async def _on_accounts(self, msg: Msg) -> None:
        try:
            accounts = await self._exec.list_accounts()
        except SchwabExecError:
            await self._reply(msg, {"error": "list_accounts failed"})
            return
        out = [schwab_account_ref_to_account_info(a).to_dict() for a in accounts]
        await self._reply(msg, out)

    # ── ACCT_ACTIVITY → exec_reports ──

    async def _account_activity_loop(self) -> None:
        """Consume ACCT_ACTIVITY frames from the streamer subscription,
        translate to BrokerExecReport, publish. Runs until cancelled.
        """
        assert self._activity_queue is not None
        while True:
            try:
                frame = await self._activity_queue.get()
            except asyncio.CancelledError:
                return
            try:
                # Frame is the raw streamer JSON; the streamer subscription
                # already extracts the content rows. We accept either:
                #   - a single content-row dict
                #   - a frame envelope with .content rows we walk
                rows = _content_rows(frame)
                for row in rows:
                    event = parse_account_activity_row(row)
                    intent_id = (
                        self._intents.lookup(event.order_id)
                        if event.order_id is not None
                        else None
                    )
                    report = event_to_exec_report(
                        event,
                        broker=self._broker,
                        intent_id=intent_id,
                        account_id=self._exec_report_account_id(),
                    )
                    if report is None:
                        continue
                    await self._publish_exec_report(report)
            except Exception as e:  # noqa: BLE001 — never let a bad frame kill the loop
                logger.warning("ACCT_ACTIVITY frame translation failed: %s", e)

    def _exec_report_account_id(self) -> str | None:
        """The account_id to stamp on exec reports. ``None`` for the
        legacy "default" deploy so the wire payload stays QF-237-compatible
        (the field is omitted); the explicit id otherwise so M12-3's
        audit-attribution path can read it.
        """
        return None if self._account_id == DEFAULT_ACCOUNT_ID else self._account_id

    async def _publish_exec_report(self, report: BrokerExecReport) -> None:
        try:
            payload = json.dumps(report.to_dict()).encode("utf-8")
            await self._nc.publish(self._subjects["exec_reports"], payload)
        except Exception as e:  # noqa: BLE001 — log + drop
            logger.warning("exec_report publish failed: %s", e)


def _content_rows(frame: Any) -> list[dict[str, Any]]:
    """Normalize an ACCT_ACTIVITY frame into a list of content-row dicts.

    The streamer queue can deliver either:
    * a parsed envelope: ``{"service": "ACCT_ACTIVITY", "content": [...]}``
    * a single content row already extracted upstream.
    """
    if isinstance(frame, dict):
        if "content" in frame and isinstance(frame["content"], list):
            return [r for r in frame["content"] if isinstance(r, dict)]
        return [frame]
    return []


# ── Public API for service runners ────────────────────────────────


async def connect_and_run(
    *,
    nats_url: str,
    exec_client: SchwabRestExecClient,
    streamer_subscription: StreamerSubscription | None,
    broker: str = "schwab",
    account_id: str = DEFAULT_ACCOUNT_ID,
) -> SchwabBrokerBridge:
    """Convenience runner: open a NATS connection + start the bridge.

    Returns the started bridge so the caller can await its lifetime
    (e.g. ``await asyncio.Event().wait()``) and ``stop()`` on shutdown.

    QF-246 — pass ``account_id`` to bind this process to a single Schwab
    account's per-account subjects. The deploy unit varies it via the
    ``SCHWAB_ACCOUNT_ID`` env var (see ``account_id_from_env``).
    """
    nc = await nats.connect(nats_url)
    activity_q = streamer_subscription.queue if streamer_subscription else None
    bridge = SchwabBrokerBridge(
        nc=nc,
        exec_client=exec_client,
        account_activity_queue=activity_q,
        broker=broker,
        account_id=account_id,
    )
    await bridge.start()
    return bridge


def account_id_from_env(env: dict[str, str] | None = None) -> str:
    """Resolve the bridge's account_id from ``SCHWAB_ACCOUNT_ID``.

    QF-246 — the deploy unit (``magpie-schwab-nt@<account_id>``)
    sets this per instance. Unset / empty falls back to ``"default"`` so
    the single-account QF-237 unit needs no env change and keeps the
    bare un-suffixed subjects.
    """
    source = os.environ if env is None else env
    value = source.get("SCHWAB_ACCOUNT_ID", "").strip()
    if not value:
        return DEFAULT_ACCOUNT_ID
    if not _ACCOUNT_ID_RE.match(value):
        # The value is spliced into NATS subjects; reject wildcards /
        # separators outright rather than subscribe to attacker-chosen
        # subjects. Mirrors the TS slug validation (brokers-config.ts).
        raise ValueError(f"invalid SCHWAB_ACCOUNT_ID {value!r}: must match [a-z0-9_-]+")
    return value


def nats_url_from_env(env: dict[str, str] | None = None) -> str:
    """Resolve + validate the NATS URL from ``NATS_URL``.

    QF-246 — the bridge brokers every order submission and execution
    report, so a redirected NATS connection would let an attacker
    intercept the whole order flow. We default to loopback and reject any
    URL whose host isn't a known-loopback address, so tampering with the
    per-account EnvironmentFile can't point the process at a foreign NATS
    server. Malformed URLs raise rather than silently connecting nowhere.
    """
    source = os.environ if env is None else env
    value = source.get("NATS_URL", "").strip()
    if not value:
        return "nats://localhost:4222"
    parsed = urlparse(value)
    if parsed.scheme not in ("nats", "tls"):
        raise ValueError(
            f"invalid NATS_URL {value!r}: scheme must be nats:// or tls://"
        )
    if parsed.hostname not in _ALLOWED_NATS_HOSTS:
        raise ValueError(
            f"refusing non-loopback NATS_URL {value!r}: "
            f"host must be one of {sorted(_ALLOWED_NATS_HOSTS)}"
        )
    return value


async def run_from_env(
    *,
    exec_client: SchwabRestExecClient,
    streamer_subscription: StreamerSubscription | None,
    broker: str = "schwab",
    env: dict[str, str] | None = None,
) -> SchwabBrokerBridge:
    """Runner entry point: build + start a bridge from env config.

    QF-246 — reads ``SCHWAB_ACCOUNT_ID`` + ``NATS_URL`` so the per-account
    deploy unit can vary the account without code changes. The exec client
    + streamer are passed in by the deploy bootstrap (OAuth / account-hash
    resolution is out of scope here — see M12-6 / QF-62). Returns the
    started bridge so the caller can await its lifetime and ``stop()`` on
    shutdown.
    """
    return await connect_and_run(
        nats_url=nats_url_from_env(env),
        exec_client=exec_client,
        streamer_subscription=streamer_subscription,
        broker=broker,
        account_id=account_id_from_env(env),
    )


__all__ = [
    "DEFAULT_ACCOUNT_ID",
    "SchwabBrokerBridge",
    "account_id_from_env",
    "connect_and_run",
    "event_to_exec_report",
    "intent_to_schwab_body",
    "nats_url_from_env",
    "run_from_env",
    "schwab_account_ref_to_account_info",
    "schwab_order_to_broker_status",
    "schwab_position_to_broker_position",
    "subjects_for",
]
