"""Tests for ``quantfoundry_schwab_nt.broker_bridge`` (QF-237).

Pure helper tests + a couple of NATS handler tests using a minimal
fake :class:`NatsClient` so we don't need a running NATS server in CI.
The actual ACCT_ACTIVITY → exec_report fan-out path is exercised
through the bridge with a manual queue (no streamer required).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from quantfoundry_schwab_nt.account_activity import (
    CancelReplaceEvent,
    FillEvent,
    OrderEvent,
    RawActivityEvent,
)
from quantfoundry_schwab_nt.broker_bridge import (
    SchwabBrokerBridge,
    _IntentCache,
    event_to_exec_report,
    intent_to_schwab_body,
    schwab_order_to_broker_status,
    schwab_position_to_broker_position,
    subjects_for,
)
from quantfoundry_schwab_nt.exec_client import (
    SchwabExecError,
    SchwabOrder,
    SchwabPosition,
)
from quantfoundry_schwab_nt.wire import SubmitOrderRequest

# ── subjects_for ──────────────────────────────────────────────────


def test_subjects_for_schwab() -> None:
    subjects = subjects_for("schwab")
    assert subjects == {
        "submit": "orders.submit.schwab",
        "cancel": "orders.cancel.schwab",
        "status": "orders.status.schwab",
        "positions": "orders.positions.schwab",
        "exec_reports": "orders.exec_reports.schwab",
    }


def test_subjects_for_ibkr() -> None:
    assert subjects_for("ibkr")["exec_reports"] == "orders.exec_reports.ibkr"


# ── intent_to_schwab_body ─────────────────────────────────────────


class TestIntentToSchwabBody:
    def test_market_buy(self) -> None:
        req = SubmitOrderRequest(
            intent_id="01HW",
            symbol="AAPL",
            direction="Long",
            quantity=1.0,
        )
        body = intent_to_schwab_body(req)
        assert body["orderType"] == "MARKET"
        assert body["duration"] == "DAY"
        assert body["session"] == "NORMAL"
        assert body["orderStrategyType"] == "SINGLE"
        legs = body["orderLegCollection"]
        assert len(legs) == 1
        assert legs[0]["instruction"] == "BUY"
        assert legs[0]["quantity"] == 1.0
        assert legs[0]["instrument"] == {"symbol": "AAPL", "assetType": "EQUITY"}
        assert "price" not in body

    def test_limit_short(self) -> None:
        req = SubmitOrderRequest(
            intent_id="01HW",
            symbol="TSLA",
            direction="Short",
            quantity=2.0,
            order_type="limit",
            limit_price=300.50,
            time_in_force="gtc",
        )
        body = intent_to_schwab_body(req)
        assert body["orderType"] == "LIMIT"
        assert body["duration"] == "GOOD_TILL_CANCEL"
        assert body["price"] == 300.50
        assert body["orderLegCollection"][0]["instruction"] == "SELL_SHORT"

    def test_close_position_maps_to_sell(self) -> None:
        req = SubmitOrderRequest(
            intent_id="01HW",
            symbol="SPY",
            direction="close",
            quantity=1.0,
        )
        body = intent_to_schwab_body(req)
        assert body["orderLegCollection"][0]["instruction"] == "SELL"

    def test_limit_without_price_raises(self) -> None:
        req = SubmitOrderRequest(
            intent_id="01HW",
            symbol="AAPL",
            direction="Long",
            quantity=1.0,
            order_type="limit",
        )
        with pytest.raises(ValueError, match="limit_price"):
            intent_to_schwab_body(req)

    def test_unsupported_order_type_raises(self) -> None:
        req = SubmitOrderRequest(
            intent_id="01HW",
            symbol="AAPL",
            direction="Long",
            quantity=1.0,
            order_type="stop",  # type: ignore[arg-type]
        )
        with pytest.raises(ValueError, match="order_type"):
            intent_to_schwab_body(req)

    def test_unsupported_tif_raises(self) -> None:
        req = SubmitOrderRequest(
            intent_id="01HW",
            symbol="AAPL",
            direction="Long",
            quantity=1.0,
            time_in_force="opg",  # type: ignore[arg-type]
        )
        with pytest.raises(ValueError, match="time_in_force"):
            intent_to_schwab_body(req)


# ── schwab_order_to_broker_status ─────────────────────────────────


def _mk_schwab_order(
    *,
    status: str = "WORKING",
    quantity: float = 10.0,
    filled: float = 0.0,
    raw_extra: dict[str, Any] | None = None,
) -> SchwabOrder:
    return SchwabOrder(
        order_id="42",
        account_hash="abc",
        status=status,
        quantity=quantity,
        filled_quantity=filled,
        legs=[],
        raw={"status": status, **(raw_extra or {})},
    )


def _mk_schwab_position(
    *,
    symbol: str = "AAPL",
    long_qty: float = 0.0,
    short_qty: float = 0.0,
) -> SchwabPosition:
    return SchwabPosition(
        account_hash="abc",
        instrument_symbol=symbol,
        instrument_type="EQUITY",
        long_quantity=long_qty,
        short_quantity=short_qty,
        market_value=long_qty * 100.0 - short_qty * 100.0,
        average_price=100.0,
        raw={},
    )


class TestSchwabOrderToBrokerStatus:
    def test_working_no_fills_maps_to_working(self) -> None:
        s = schwab_order_to_broker_status(_mk_schwab_order(), broker_order_id="42")
        assert s.status == "working"
        assert s.filled_quantity == 0.0
        assert s.average_fill_price is None
        assert s.rejection_reason is None

    def test_working_with_partial_fills_maps_to_partial(self) -> None:
        s = schwab_order_to_broker_status(
            _mk_schwab_order(status="WORKING", quantity=10.0, filled=3.0),
            broker_order_id="42",
        )
        assert s.status == "partial_fill"
        assert s.filled_quantity == 3.0

    def test_filled_maps_to_filled_with_avg_price(self) -> None:
        s = schwab_order_to_broker_status(
            _mk_schwab_order(
                status="FILLED",
                quantity=10.0,
                filled=10.0,
                raw_extra={"averagePrice": 175.42},
            ),
            broker_order_id="42",
        )
        assert s.status == "filled"
        assert s.filled_quantity == 10.0
        assert s.average_fill_price == 175.42

    def test_rejected_pulls_reason_from_raw(self) -> None:
        s = schwab_order_to_broker_status(
            _mk_schwab_order(
                status="REJECTED",
                raw_extra={"statusDescription": "insufficient buying power"},
            ),
            broker_order_id="42",
        )
        assert s.status == "rejected"
        assert s.rejection_reason == "insufficient buying power"

    def test_replaced_treated_as_cancelled(self) -> None:
        # Schwab's REPLACED is terminal on the OLD order; order_status
        # maps it to NT CANCELED.
        s = schwab_order_to_broker_status(
            _mk_schwab_order(status="REPLACED"), broker_order_id="42"
        )
        assert s.status == "cancelled"


# ── schwab_position_to_broker_position ────────────────────────────


def test_long_position_maps_to_long() -> None:
    out = schwab_position_to_broker_position(_mk_schwab_position(long_qty=5.0))
    assert out.direction == "Long"
    assert out.quantity == 5.0
    assert out.symbol == "AAPL"


def test_short_position_maps_to_short() -> None:
    out = schwab_position_to_broker_position(
        _mk_schwab_position(symbol="TSLA", short_qty=2.0)
    )
    assert out.direction == "Short"
    assert out.quantity == 2.0


# ── event_to_exec_report ──────────────────────────────────────────


class TestEventToExecReport:
    def test_submitted_with_intent_id(self) -> None:
        evt = OrderEvent(
            kind="submitted",
            account_number="12345",
            message_type="OrderEntryRequest",
            order_id="42",
        )
        rep = event_to_exec_report(evt, intent_id="01HW", ts="2026-05-20T15:00:00Z")
        assert rep is not None
        assert rep.event == "submitted"
        assert rep.intent_id == "01HW"
        assert rep.broker_order_id == "42"
        assert rep.ts == "2026-05-20T15:00:00Z"

    def test_event_with_no_order_id_dropped(self) -> None:
        evt = OrderEvent(
            kind="submitted",
            account_number="12345",
            message_type="OrderEntryRequest",
            order_id=None,
        )
        assert event_to_exec_report(evt, intent_id="01HW") is None

    def test_filled_emits_fill_payload(self) -> None:
        evt = FillEvent(
            kind="filled",
            account_number="12345",
            message_type="OrderFill",
            order_id="42",
            raw_payload={"executionId": "exec-7", "commission": 0.65},
            fill_quantity=10.0,
            fill_price=175.42,
            cumulative_filled=10.0,
            remaining_quantity=0.0,
        )
        rep = event_to_exec_report(evt, intent_id="01HW")
        assert rep is not None
        assert rep.event == "fill"
        assert rep.fill is not None
        assert rep.fill.fill_id == "exec-7"
        assert rep.fill.quantity == 10.0
        assert rep.fill.price == 175.42
        assert rep.fill.fees == 0.65

    def test_partial_fill_emits_partial_event(self) -> None:
        evt = FillEvent(
            kind="partial_fill",
            account_number="12345",
            message_type="OrderPartialFill",
            order_id="42",
            raw_payload={},
            fill_quantity=3.0,
            fill_price=175.0,
            cumulative_filled=3.0,
            remaining_quantity=7.0,
        )
        rep = event_to_exec_report(evt, intent_id="01HW")
        assert rep is not None
        assert rep.event == "partial_fill"
        assert rep.fill is not None
        assert rep.fill.fill_id.startswith("schwab-fill-")  # synthesized

    def test_rejected_emits_reason(self) -> None:
        evt = OrderEvent(
            kind="rejected",
            account_number="12345",
            message_type="OrderRejection",
            order_id="42",
            raw_payload={"rejectReason": "insufficient buying power"},
        )
        rep = event_to_exec_report(evt, intent_id="01HW")
        assert rep is not None
        assert rep.event == "rejected"
        assert rep.rejection_reason == "insufficient buying power"

    def test_canceled_maps_to_cancelled(self) -> None:
        evt = OrderEvent(
            kind="canceled",
            account_number="12345",
            message_type="OrderCancelRequest",
            order_id="42",
        )
        rep = event_to_exec_report(evt, intent_id="01HW")
        assert rep is not None
        assert rep.event == "cancelled"

    @pytest.mark.parametrize(
        "kind", ["accepted", "replaced", "raw", "error", "subscribed"]
    )
    def test_unmapped_kinds_return_none(self, kind: str) -> None:
        if kind == "replaced":
            evt: OrderEvent = CancelReplaceEvent(
                kind="replaced",
                account_number="12345",
                message_type="OrderCancelReplaceRequest",
                order_id="42",
            )
        elif kind in ("raw", "error"):
            evt = RawActivityEvent(
                kind=kind,  # type: ignore[arg-type]
                account_number="12345",
                message_type="WTF",
                order_id="42",
            )
        else:
            evt = OrderEvent(
                kind=kind,  # type: ignore[arg-type]
                account_number="12345",
                message_type="X",
                order_id="42",
            )
        assert event_to_exec_report(evt, intent_id="01HW") is None


# ── _IntentCache LRU ──────────────────────────────────────────────


class TestIntentCache:
    def test_remember_and_lookup(self) -> None:
        cache = _IntentCache(max_size=3)
        cache.remember("a", "intent-A")
        cache.remember("b", "intent-B")
        assert cache.lookup("a") == "intent-A"
        assert cache.lookup("b") == "intent-B"
        assert cache.lookup("nope") is None

    def test_lru_eviction(self) -> None:
        cache = _IntentCache(max_size=2)
        cache.remember("a", "intent-A")
        cache.remember("b", "intent-B")
        cache.remember("c", "intent-C")  # evicts "a"
        assert cache.lookup("a") is None
        assert cache.lookup("b") == "intent-B"
        assert cache.lookup("c") == "intent-C"

    def test_lookup_promotes_to_mru(self) -> None:
        cache = _IntentCache(max_size=2)
        cache.remember("a", "intent-A")
        cache.remember("b", "intent-B")
        # Access "a" → becomes MRU; adding "c" should now evict "b".
        cache.lookup("a")
        cache.remember("c", "intent-C")
        assert cache.lookup("a") == "intent-A"
        assert cache.lookup("b") is None
        assert cache.lookup("c") == "intent-C"


# ── Bridge handlers with a fake NATS client ───────────────────────


class _FakeMsg:
    """Minimal stand-in for nats.aio.msg.Msg in handler tests."""

    def __init__(self, data: bytes, reply: str | None = "_inbox.1") -> None:
        self.data = data
        self.reply = reply


class _FakeSub:
    async def unsubscribe(self) -> None:
        pass


class _FakeNats:
    """Captures everything the bridge publishes; subscribe() returns a
    no-op sub but records (subject, cb) for later use in tests."""

    def __init__(self) -> None:
        self.subscriptions: list[tuple[str, Any]] = []
        self.published: list[tuple[str, dict[str, Any]]] = []

    async def subscribe(self, subject: str, cb: Any = None) -> _FakeSub:  # noqa: ANN401
        self.subscriptions.append((subject, cb))
        return _FakeSub()

    async def publish(self, subject: str, data: bytes) -> None:
        self.published.append((subject, json.loads(data.decode("utf-8"))))


class _FakeExecClient:
    """In-memory fake of SchwabRestExecClient for handler-level tests."""

    def __init__(self) -> None:
        self.submitted: list[dict[str, Any]] = []
        self.cancelled: list[str] = []
        self.next_order_id = "ORDER-1"
        self.query_response: SchwabOrder | None = None
        self.query_raises: SchwabExecError | None = None
        self.positions: list[SchwabPosition] = []

    async def submit_order(self, body: dict[str, Any]) -> str:
        self.submitted.append(body)
        return self.next_order_id

    async def cancel_order(self, order_id: str) -> None:
        self.cancelled.append(order_id)

    async def query_order(self, order_id: str) -> SchwabOrder:
        if self.query_raises is not None:
            raise self.query_raises
        assert self.query_response is not None
        return self.query_response

    async def list_positions(self) -> list[SchwabPosition]:
        return self.positions


def _bridge_with_fakes(
    activity_queue: asyncio.Queue[Any] | None = None,
) -> tuple[SchwabBrokerBridge, _FakeNats, _FakeExecClient]:
    nc = _FakeNats()
    exec_client = _FakeExecClient()
    bridge = SchwabBrokerBridge(
        nc=nc,  # type: ignore[arg-type]
        exec_client=exec_client,  # type: ignore[arg-type]
        account_activity_queue=activity_queue,
    )
    return bridge, nc, exec_client


@pytest.mark.asyncio
async def test_submit_handler_round_trip() -> None:
    bridge, nc, exec_client = _bridge_with_fakes()
    await bridge.start()
    try:
        # The submit subscription is at index 0 (we register them in order).
        _, cb = nc.subscriptions[0]
        req_body = {
            "intent_id": "01HW",
            "symbol": "AAPL",
            "direction": "Long",
            "quantity": 1.0,
        }
        msg = _FakeMsg(json.dumps(req_body).encode("utf-8"))
        await cb(msg)
        assert nc.published, "expected a reply on the _inbox subject"
        reply_subject, reply_payload = nc.published[-1]
        assert reply_subject == "_inbox.1"
        assert reply_payload == {"accepted": True, "broker_order_id": "ORDER-1"}
        assert len(exec_client.submitted) == 1
        assert exec_client.submitted[0]["orderType"] == "MARKET"
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_submit_handler_surface_schwab_errors() -> None:
    bridge, nc, exec_client = _bridge_with_fakes()
    await bridge.start()
    try:

        async def raising(body: dict[str, Any]) -> str:
            raise SchwabExecError("HTTP 401: token expired", status_code=401, body={})

        exec_client.submit_order = raising  # type: ignore[method-assign]
        _, cb = nc.subscriptions[0]
        msg = _FakeMsg(
            json.dumps(
                {
                    "intent_id": "01HW",
                    "symbol": "AAPL",
                    "direction": "Long",
                    "quantity": 1.0,
                }
            ).encode("utf-8")
        )
        await cb(msg)
        _, reply = nc.published[-1]
        assert reply["accepted"] is False
        assert "schwab" in reply["error"]
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_account_activity_loop_publishes_exec_report() -> None:
    q: asyncio.Queue[Any] = asyncio.Queue()
    bridge, nc, _exec = _bridge_with_fakes(activity_queue=q)
    await bridge.start()
    try:
        # Seed the intent cache so the loop can correlate the fill.
        bridge._intents.remember("99", "01HW-INTENT")  # noqa: SLF001
        # Feed an OrderFill-style row.
        row = {
            "1": "12345678",
            "2": "OrderFill",
            "3": json.dumps(
                {
                    "orderId": "99",
                    "executionQuantity": 5.0,
                    "executionPrice": 100.0,
                    "cumulativeFilledQuantity": 5.0,
                    "totalQuantity": 5.0,
                }
            ),
        }
        await q.put(row)
        # Yield to the loop until it publishes.
        for _ in range(20):
            await asyncio.sleep(0.01)
            if any(s == "orders.exec_reports.schwab" for s, _ in nc.published):
                break
        published = [p for p in nc.published if p[0] == "orders.exec_reports.schwab"]
        assert published, "expected an exec_reports publish"
        _, payload = published[0]
        assert payload["event"] == "fill"
        assert payload["broker_order_id"] == "99"
        assert payload["intent_id"] == "01HW-INTENT"
        assert payload["fill"]["price"] == 100.0
        assert payload["fill"]["quantity"] == 5.0
    finally:
        await bridge.stop()
