"""Tests for ``magpie_ibkr_nt.broker_bridge`` (QF-240, QF-353).

Pure helper tests + bridge handler tests using a minimal fake
NatsClient + IbkrSessionClient so we don't need a running NATS server
or a connected IB Gateway. The exec-event fan-out is exercised through
a manual queue.

QF-353 added the submission half (``orders.submit.ibkr`` /
``orders.cancel.ibkr``) so the bundle is symmetric with Schwab; those
handlers + the ``intent_to_ibkr_body`` translator + intent correlation
are covered alongside the original observation tests.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from magpie_ibkr_nt.broker_bridge import (
    IbkrBrokerBridge,
    derive_broker_status,
    event_to_exec_report,
    ibkr_order_to_broker_status,
    ibkr_position_to_broker_position,
    ibkr_status_to_broker_status,
    intent_to_ibkr_body,
    subjects_for,
)
from magpie_ibkr_nt.session import (
    IbkrEvent,
    IbkrOrder,
    IbkrOrderNotFoundError,
    IbkrPosition,
    IbkrSessionError,
    is_rejection_error_code,
)
from magpie_schwab_nt.wire import SubmitOrderRequest

# ── subjects_for ──────────────────────────────────────────────────


def test_subjects_for_ibkr_is_symmetric_with_schwab() -> None:
    """QF-353: the bundle owns every orders.* subject, incl. submit/cancel."""
    subjects = subjects_for("ibkr")
    assert subjects == {
        "submit": "orders.submit.ibkr",
        "cancel": "orders.cancel.ibkr",
        "status": "orders.status.ibkr",
        "positions": "orders.positions.ibkr",
        "exec_reports": "orders.exec_reports.ibkr",
    }


# ── intent_to_ibkr_body ───────────────────────────────────────────


class TestIntentToIbkrBody:
    def test_market_long(self) -> None:
        req = SubmitOrderRequest(
            intent_id="I1",
            symbol="AAPL",
            direction="Long",
            quantity=10.0,
            order_type="market",
            limit_price=None,
            time_in_force="day",
        )
        body = intent_to_ibkr_body(req)
        assert body == {
            "action": "BUY",
            "orderType": "MARKET",
            "quantity": 10.0,
            "tif": "DAY",
            "symbol": "AAPL",
        }

    def test_limit_short_carries_price(self) -> None:
        req = SubmitOrderRequest(
            intent_id="I2",
            symbol="MSFT",
            direction="Short",
            quantity=5.0,
            order_type="limit",
            limit_price=412.5,
            time_in_force="gtc",
        )
        body = intent_to_ibkr_body(req)
        assert body["action"] == "SELL"
        assert body["orderType"] == "LIMIT"
        assert body["lmtPrice"] == 412.5
        assert body["tif"] == "GTC"

    def test_close_maps_to_sell(self) -> None:
        req = SubmitOrderRequest(
            intent_id="I3",
            symbol="AAPL",
            direction="close",
            quantity=10.0,
            order_type="market",
            limit_price=None,
            time_in_force="day",
        )
        assert intent_to_ibkr_body(req)["action"] == "SELL"

    def test_tif_mapping(self) -> None:
        for qf_tif, ib_tif in (
            ("day", "DAY"),
            ("gtc", "GTC"),
            ("ioc", "IOC"),
            ("fok", "FOK"),
        ):
            req = SubmitOrderRequest(
                intent_id="I",
                symbol="AAPL",
                direction="Long",
                quantity=1.0,
                order_type="market",
                limit_price=None,
                time_in_force=qf_tif,
            )
            assert intent_to_ibkr_body(req)["tif"] == ib_tif

    def test_limit_without_price_raises(self) -> None:
        req = SubmitOrderRequest(
            intent_id="I",
            symbol="AAPL",
            direction="Long",
            quantity=1.0,
            order_type="limit",
            limit_price=None,
            time_in_force="day",
        )
        with pytest.raises(ValueError, match="requires limit_price"):
            intent_to_ibkr_body(req)

    def test_unsupported_order_type_raises(self) -> None:
        req = SubmitOrderRequest(
            intent_id="I",
            symbol="AAPL",
            direction="Long",
            quantity=1.0,
            order_type="stop",
            limit_price=None,
            time_in_force="day",
        )
        with pytest.raises(ValueError, match="unsupported order_type"):
            intent_to_ibkr_body(req)

    def test_unsupported_tif_raises(self) -> None:
        req = SubmitOrderRequest(
            intent_id="I",
            symbol="AAPL",
            direction="Long",
            quantity=1.0,
            order_type="market",
            limit_price=None,
            time_in_force="opg",
        )
        with pytest.raises(ValueError, match="unsupported time_in_force"):
            intent_to_ibkr_body(req)


# ── ibkr_status_to_broker_status ──────────────────────────────────


class TestIbkrStatusMapping:
    def test_filled(self) -> None:
        assert ibkr_status_to_broker_status("Filled") == "filled"

    def test_cancelled_variants(self) -> None:
        assert ibkr_status_to_broker_status("Cancelled") == "cancelled"
        assert ibkr_status_to_broker_status("ApiCancelled") == "cancelled"

    def test_inactive_is_rejected(self) -> None:
        assert ibkr_status_to_broker_status("Inactive") == "rejected"

    def test_working_variants(self) -> None:
        for s in ("PendingSubmit", "PreSubmitted", "Submitted", "PendingCancel"):
            assert ibkr_status_to_broker_status(s) == "working"

    def test_unknown(self) -> None:
        assert ibkr_status_to_broker_status("WeirdNewStatus") == "unknown"


# ── derive_broker_status (race detection) ─────────────────────────


class TestDeriveBrokerStatus:
    def test_passes_through_normal_status(self) -> None:
        order = IbkrOrder(
            broker_order_id="O1",
            status="Filled",
            quantity=5.0,
            filled_quantity=5.0,
            average_fill_price=10.0,
        )
        assert derive_broker_status(order) == "filled"

    def test_race_filled_quantity_full_but_status_lags(self) -> None:
        # IB sometimes leaves status="Submitted" while filled_quantity
        # reached quantity. Detect that and surface "filled".
        order = IbkrOrder(
            broker_order_id="O1",
            status="Submitted",
            quantity=5.0,
            filled_quantity=5.0,
        )
        assert derive_broker_status(order) == "filled"

    def test_race_partial_fill_but_status_working(self) -> None:
        order = IbkrOrder(
            broker_order_id="O1",
            status="Submitted",
            quantity=5.0,
            filled_quantity=2.0,
        )
        assert derive_broker_status(order) == "partial_fill"

    def test_zero_quantity_order_passes_through(self) -> None:
        order = IbkrOrder(
            broker_order_id="O1",
            status="Submitted",
            quantity=0.0,
            filled_quantity=0.0,
        )
        # Edge case — quantity should never be 0 in practice but the
        # guard in derive_broker_status only kicks in when quantity > 0.
        assert derive_broker_status(order) == "working"


# ── ibkr_order_to_broker_status ───────────────────────────────────


def test_ibkr_order_to_broker_status_full() -> None:
    order = IbkrOrder(
        broker_order_id="O1",
        status="Filled",
        quantity=10.0,
        filled_quantity=10.0,
        average_fill_price=15.25,
    )
    status = ibkr_order_to_broker_status(order, "O1")
    assert status.broker_order_id == "O1"
    assert status.status == "filled"
    assert status.filled_quantity == 10.0
    assert status.average_fill_price == 15.25
    assert status.rejection_reason is None


def test_ibkr_order_to_broker_status_rejected_with_reason() -> None:
    order = IbkrOrder(
        broker_order_id="O2",
        status="Inactive",
        quantity=10.0,
        filled_quantity=0.0,
        rejection_reason="Order rejected — locate failure",
    )
    status = ibkr_order_to_broker_status(order, "O2")
    assert status.status == "rejected"
    assert status.rejection_reason == "Order rejected — locate failure"


# ── ibkr_position_to_broker_position ──────────────────────────────


class TestPositionMapping:
    def test_long(self) -> None:
        out = ibkr_position_to_broker_position(
            IbkrPosition(symbol="AAPL", quantity=100.0)
        )
        assert out.direction == "Long"
        assert out.quantity == 100.0
        assert out.symbol == "AAPL"

    def test_short(self) -> None:
        out = ibkr_position_to_broker_position(
            IbkrPosition(symbol="AAPL", quantity=-50.0)
        )
        assert out.direction == "Short"
        assert out.quantity == 50.0  # absolute


# ── event_to_exec_report ──────────────────────────────────────────


class TestEventToExecReport:
    def test_submitted_event(self) -> None:
        ev = IbkrEvent(
            kind="submitted",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
        )
        rpt = event_to_exec_report(ev)
        assert rpt is not None
        assert rpt.event == "submitted"
        assert rpt.broker == "ibkr"
        # No intent supplied → null (NT-internal order).
        assert rpt.intent_id is None

    def test_intent_id_round_trips_when_supplied(self) -> None:
        ev = IbkrEvent(
            kind="submitted",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
        )
        rpt = event_to_exec_report(ev, intent_id="I-42")
        assert rpt is not None
        assert rpt.intent_id == "I-42"

    def test_fill_event(self) -> None:
        ev = IbkrEvent(
            kind="filled",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
            fill_id="EX-1",
            fill_price=10.5,
            fill_quantity=3.0,
            fill_fees=0.65,
        )
        rpt = event_to_exec_report(ev)
        assert rpt is not None
        assert rpt.event == "fill"
        assert rpt.fill is not None
        assert rpt.fill.fill_id == "EX-1"
        assert rpt.fill.price == 10.5
        assert rpt.fill.quantity == 3.0
        assert rpt.fill.fees == 0.65

    def test_partial_fill_event(self) -> None:
        ev = IbkrEvent(
            kind="partial_fill",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
            fill_id="EX-2",
            fill_price=10.5,
            fill_quantity=1.0,
        )
        rpt = event_to_exec_report(ev)
        assert rpt is not None
        assert rpt.event == "partial_fill"

    def test_fill_event_missing_price_drops(self) -> None:
        ev = IbkrEvent(
            kind="filled",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
            fill_quantity=3.0,
            # fill_price omitted
        )
        assert event_to_exec_report(ev) is None

    def test_fill_event_missing_quantity_drops(self) -> None:
        ev = IbkrEvent(
            kind="filled",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
            fill_price=10.5,
        )
        assert event_to_exec_report(ev) is None

    def test_fill_event_synthesizes_fill_id_when_missing(self) -> None:
        ev = IbkrEvent(
            kind="filled",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
            fill_price=10.5,
            fill_quantity=3.0,
            # fill_id omitted
        )
        rpt = event_to_exec_report(ev)
        assert rpt is not None
        assert rpt.fill is not None
        assert rpt.fill.fill_id.startswith("ibkr-fill-")

    def test_rejected_event_with_reason(self) -> None:
        ev = IbkrEvent(
            kind="rejected",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
            rejection_reason="Order rejected: price band breach",
            ib_error_code=201,
        )
        rpt = event_to_exec_report(ev)
        assert rpt is not None
        assert rpt.event == "rejected"
        assert rpt.rejection_reason == "Order rejected: price band breach"

    def test_rejected_event_without_reason_falls_back(self) -> None:
        ev = IbkrEvent(
            kind="rejected",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
        )
        rpt = event_to_exec_report(ev)
        assert rpt is not None
        assert rpt.rejection_reason == "rejected (no reason text)"

    def test_cancelled_event(self) -> None:
        ev = IbkrEvent(
            kind="cancelled",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
        )
        rpt = event_to_exec_report(ev)
        assert rpt is not None
        assert rpt.event == "cancelled"

    def test_event_without_broker_order_id_drops(self) -> None:
        ev = IbkrEvent(
            kind="filled",
            broker_order_id=None,
            ts="2026-05-20T14:30:00Z",
            fill_price=10.5,
            fill_quantity=1.0,
        )
        assert event_to_exec_report(ev) is None

    def test_replaced_event_drops(self) -> None:
        # IB replaces are NT-internal — QF observes the resulting fills
        # but doesn't track the replace event itself.
        ev = IbkrEvent(
            kind="replaced",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
        )
        assert event_to_exec_report(ev) is None

    def test_unknown_kind_drops(self) -> None:
        ev = IbkrEvent(
            kind="raw",
            broker_order_id="O1",
            ts="2026-05-20T14:30:00Z",
        )
        assert event_to_exec_report(ev) is None


# ── is_rejection_error_code ───────────────────────────────────────


class TestRejectionErrorCodeFilter:
    def test_201_is_rejection(self) -> None:
        assert is_rejection_error_code(201) is True

    def test_2148_is_rejection(self) -> None:
        # IB 2148: order rounds to zero
        assert is_rejection_error_code(2148) is True

    def test_market_data_warning_is_not_rejection(self) -> None:
        # 2104: Market data farm connection is OK — informational only
        assert is_rejection_error_code(2104) is False

    def test_unknown_code_is_not_rejection(self) -> None:
        assert is_rejection_error_code(9999) is False


# ── Bridge with fakes ─────────────────────────────────────────────


class _FakeMsg:
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
        self.published: list[tuple[str, Any]] = []

    async def subscribe(self, subject: str, cb: Any = None) -> _FakeSub:  # noqa: ANN401
        self.subscriptions.append((subject, cb))
        return _FakeSub()

    async def publish(self, subject: str, data: bytes) -> None:
        self.published.append((subject, json.loads(data.decode("utf-8"))))


class _FakeSession:
    """In-memory fake of IbkrSessionClient for handler-level tests."""

    def __init__(self) -> None:
        self.query_response: IbkrOrder | None = None
        self.query_not_found: bool = False
        self.query_raises: IbkrSessionError | None = None
        self.positions: list[IbkrPosition] = []
        # Submission half (QF-353).
        self.submitted_bodies: list[dict[str, Any]] = []
        self.submit_order_id: str = "IB-1"
        self.submit_raises: Exception | None = None
        self.cancelled_ids: list[str] = []
        self.cancel_raises: Exception | None = None

    async def submit_order(self, body: dict[str, Any]) -> str:
        if self.submit_raises is not None:
            raise self.submit_raises
        self.submitted_bodies.append(body)
        return self.submit_order_id

    async def cancel_order(self, broker_order_id: str) -> None:
        if self.cancel_raises is not None:
            raise self.cancel_raises
        self.cancelled_ids.append(broker_order_id)

    async def query_order(self, broker_order_id: str) -> IbkrOrder:
        if self.query_not_found:
            raise IbkrOrderNotFoundError(broker_order_id)
        if self.query_raises is not None:
            raise self.query_raises
        assert self.query_response is not None
        return self.query_response

    async def list_positions(self) -> list[IbkrPosition]:
        return self.positions


def _bridge_with_fakes(
    event_queue: asyncio.Queue[IbkrEvent] | None = None,
) -> tuple[IbkrBrokerBridge, _FakeNats, _FakeSession]:
    nc = _FakeNats()
    session = _FakeSession()
    bridge = IbkrBrokerBridge(
        nc=nc,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        event_queue=event_queue,
    )
    return bridge, nc, session


def _cb_for(nc: _FakeNats, subject: str) -> Any:  # noqa: ANN401
    """Look up the handler the bridge subscribed for a subject — robust to
    subscription order changes."""
    for s, cb in nc.subscriptions:
        if s == subject:
            return cb
    raise AssertionError(f"no subscription for {subject}")


def _submit_req(**over: Any) -> dict[str, Any]:  # noqa: ANN401
    base = {
        "intent_id": "I1",
        "symbol": "AAPL",
        "direction": "Long",
        "quantity": 10.0,
        "order_type": "market",
        "limit_price": None,
        "time_in_force": "day",
    }
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_bridge_subscribes_to_all_four_rpc_subjects() -> None:
    """QF-353: symmetric with Schwab — submit + cancel + status + positions."""
    bridge, nc, _session = _bridge_with_fakes()
    await bridge.start()
    try:
        subjects = [s for s, _ in nc.subscriptions]
        assert "orders.submit.ibkr" in subjects
        assert "orders.cancel.ibkr" in subjects
        assert "orders.status.ibkr" in subjects
        assert "orders.positions.ibkr" in subjects
    finally:
        await bridge.stop()


# ── submit handler (QF-353) ───────────────────────────────────────


@pytest.mark.asyncio
async def test_submit_handler_round_trip() -> None:
    bridge, nc, session = _bridge_with_fakes()
    session.submit_order_id = "IB-99"
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.submit.ibkr")
        msg = _FakeMsg(json.dumps(_submit_req()).encode("utf-8"))
        await cb(msg)
        _, reply = nc.published[-1]
        assert reply["accepted"] is True
        assert reply["broker_order_id"] == "IB-99"
        # Body was translated to the IB spec.
        assert session.submitted_bodies[-1]["action"] == "BUY"
        assert session.submitted_bodies[-1]["orderType"] == "MARKET"
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_submit_handler_remembers_intent_for_correlation() -> None:
    """A fill arriving after submit carries the originating intent_id."""
    queue: asyncio.Queue[IbkrEvent] = asyncio.Queue()
    bridge, nc, session = _bridge_with_fakes(event_queue=queue)
    session.submit_order_id = "IB-7"
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.submit.ibkr")
        await cb(_FakeMsg(json.dumps(_submit_req(intent_id="I-7")).encode("utf-8")))
        # Now a fill for that broker_order_id flows through the event loop.
        await queue.put(
            IbkrEvent(
                kind="filled",
                broker_order_id="IB-7",
                ts="2026-05-20T14:30:00Z",
                fill_id="EX-1",
                fill_price=10.5,
                fill_quantity=10.0,
            )
        )
        for _ in range(3):
            await asyncio.sleep(0)
        reports = [p for s, p in nc.published if s == "orders.exec_reports.ibkr"]
        assert len(reports) == 1
        assert reports[0]["intent_id"] == "I-7"
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_submit_handler_malformed_request() -> None:
    bridge, nc, _session = _bridge_with_fakes()
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.submit.ibkr")
        await cb(_FakeMsg(b"not json"))
        _, reply = nc.published[-1]
        assert reply["accepted"] is False
        assert "malformed request" in reply["error"]
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_submit_handler_unsupported_shape_replies_error() -> None:
    bridge, nc, session = _bridge_with_fakes()
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.submit.ibkr")
        # limit order with no price → intent_to_ibkr_body raises ValueError.
        await cb(
            _FakeMsg(
                json.dumps(_submit_req(order_type="limit", limit_price=None)).encode(
                    "utf-8"
                )
            )
        )
        _, reply = nc.published[-1]
        assert reply["accepted"] is False
        assert "limit_price" in reply["error"]
        assert session.submitted_bodies == []  # never reached the session
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_submit_handler_session_error_surfaces_reason() -> None:
    bridge, nc, session = _bridge_with_fakes()
    session.submit_raises = IbkrSessionError("IB Gateway disconnected")
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.submit.ibkr")
        await cb(_FakeMsg(json.dumps(_submit_req()).encode("utf-8")))
        _, reply = nc.published[-1]
        assert reply["accepted"] is False
        assert "IB Gateway disconnected" in reply["error"]
    finally:
        await bridge.stop()


# ── cancel handler (QF-353) ───────────────────────────────────────


@pytest.mark.asyncio
async def test_cancel_handler_round_trip() -> None:
    bridge, nc, session = _bridge_with_fakes()
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.cancel.ibkr")
        await cb(_FakeMsg(json.dumps({"broker_order_id": "IB-3"}).encode("utf-8")))
        _, reply = nc.published[-1]
        assert reply["accepted"] is True
        assert session.cancelled_ids == ["IB-3"]
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_cancel_handler_session_error_surfaces_reason() -> None:
    bridge, nc, session = _bridge_with_fakes()
    session.cancel_raises = IbkrSessionError("no such order")
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.cancel.ibkr")
        await cb(_FakeMsg(json.dumps({"broker_order_id": "IB-X"}).encode("utf-8")))
        _, reply = nc.published[-1]
        assert reply["accepted"] is False
        assert "no such order" in reply["error"]
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_cancel_handler_malformed_request() -> None:
    bridge, nc, _session = _bridge_with_fakes()
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.cancel.ibkr")
        await cb(_FakeMsg(b"not json"))
        _, reply = nc.published[-1]
        assert reply["accepted"] is False
        assert "malformed request" in reply["error"]
    finally:
        await bridge.stop()


# ── status handler ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_status_handler_returns_normalized_status() -> None:
    bridge, nc, session = _bridge_with_fakes()
    session.query_response = IbkrOrder(
        broker_order_id="O1",
        status="Filled",
        quantity=10.0,
        filled_quantity=10.0,
        average_fill_price=15.25,
    )
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.status.ibkr")
        msg = _FakeMsg(json.dumps({"broker_order_id": "O1"}).encode("utf-8"))
        await cb(msg)
        _, reply = nc.published[-1]
        assert reply["broker_order_id"] == "O1"
        assert reply["status"] == "filled"
        assert reply["filled_quantity"] == 10.0
        assert reply["average_fill_price"] == 15.25
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_status_handler_unknown_order_replies_unknown() -> None:
    bridge, nc, session = _bridge_with_fakes()
    session.query_not_found = True
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.status.ibkr")
        msg = _FakeMsg(json.dumps({"broker_order_id": "O-GHOST"}).encode("utf-8"))
        await cb(msg)
        _, reply = nc.published[-1]
        assert reply["status"] == "unknown"
        assert reply["broker_order_id"] == "O-GHOST"
        assert reply["rejection_reason"] is None
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_status_handler_session_error_surfaces_reason() -> None:
    bridge, nc, session = _bridge_with_fakes()
    session.query_raises = IbkrSessionError("IB Gateway disconnected")
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.status.ibkr")
        msg = _FakeMsg(json.dumps({"broker_order_id": "O1"}).encode("utf-8"))
        await cb(msg)
        _, reply = nc.published[-1]
        assert reply["status"] == "unknown"
        assert "IB Gateway disconnected" in reply["rejection_reason"]
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_status_handler_malformed_request() -> None:
    bridge, nc, _session = _bridge_with_fakes()
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.status.ibkr")
        msg = _FakeMsg(b"not json")
        await cb(msg)
        _, reply = nc.published[-1]
        assert reply["status"] == "unknown"
        assert "malformed request" in reply["rejection_reason"]
    finally:
        await bridge.stop()


# ── positions handler ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_positions_handler_drops_zero_quantity() -> None:
    bridge, nc, session = _bridge_with_fakes()
    session.positions = [
        IbkrPosition(symbol="AAPL", quantity=100.0),
        IbkrPosition(symbol="MSFT", quantity=0.0),  # zero — dropped
        IbkrPosition(symbol="GOOG", quantity=-50.0),  # short
    ]
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.positions.ibkr")
        msg = _FakeMsg(b"{}")
        await cb(msg)
        _, reply = nc.published[-1]
        assert isinstance(reply, list)
        assert len(reply) == 2
        symbols = sorted(r["symbol"] for r in reply)
        assert symbols == ["AAPL", "GOOG"]
        # Check direction mapping carried through
        directions = {r["symbol"]: r["direction"] for r in reply}
        assert directions["AAPL"] == "Long"
        assert directions["GOOG"] == "Short"
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_positions_handler_session_error_returns_error_payload() -> None:
    bridge, nc, session = _bridge_with_fakes()

    async def _raises() -> list[IbkrPosition]:
        raise IbkrSessionError("permission denied")

    session.list_positions = _raises  # type: ignore[method-assign]
    await bridge.start()
    try:
        cb = _cb_for(nc, "orders.positions.ibkr")
        msg = _FakeMsg(b"{}")
        await cb(msg)
        _, reply = nc.published[-1]
        assert isinstance(reply, dict)
        assert "permission denied" in reply["error"]
    finally:
        await bridge.stop()


# ── exec-event loop ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_event_loop_publishes_exec_report_on_fill() -> None:
    queue: asyncio.Queue[IbkrEvent] = asyncio.Queue()
    bridge, nc, _session = _bridge_with_fakes(event_queue=queue)
    await bridge.start()
    try:
        await queue.put(
            IbkrEvent(
                kind="filled",
                broker_order_id="O1",
                ts="2026-05-20T14:30:00Z",
                fill_id="EX-1",
                fill_price=10.5,
                fill_quantity=3.0,
                fill_fees=0.65,
            )
        )
        # Yield twice so the event-loop task picks up + publishes.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        publishes = [(s, p) for s, p in nc.published if s == "orders.exec_reports.ibkr"]
        assert len(publishes) == 1
        _, report = publishes[0]
        assert report["broker"] == "ibkr"
        assert report["event"] == "fill"
        # No prior submit → no cached intent → null (NT-internal order).
        assert report["intent_id"] is None
        assert report["fill"]["price"] == 10.5
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_event_loop_skips_events_with_no_broker_order_id() -> None:
    queue: asyncio.Queue[IbkrEvent] = asyncio.Queue()
    bridge, nc, _session = _bridge_with_fakes(event_queue=queue)
    await bridge.start()
    try:
        await queue.put(
            IbkrEvent(
                kind="filled",
                broker_order_id=None,
                ts="2026-05-20T14:30:00Z",
                fill_price=10.5,
                fill_quantity=3.0,
            )
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        publishes = [(s, p) for s, p in nc.published if s == "orders.exec_reports.ibkr"]
        assert len(publishes) == 0
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_event_loop_survives_translation_failure() -> None:
    """A bad event shouldn't kill the loop — the bridge logs + continues."""
    queue: asyncio.Queue[IbkrEvent] = asyncio.Queue()
    bridge, nc, _session = _bridge_with_fakes(event_queue=queue)
    await bridge.start()
    try:
        # First event: a fill missing required fields → translation
        # drops to None (logged warning), loop continues.
        await queue.put(
            IbkrEvent(
                kind="filled",
                broker_order_id="O-BAD",
                ts="2026-05-20T14:30:00Z",
                # missing price/quantity
            )
        )
        # Second event: a valid rejection.
        await queue.put(
            IbkrEvent(
                kind="rejected",
                broker_order_id="O-GOOD",
                ts="2026-05-20T14:31:00Z",
                rejection_reason="locate failure",
            )
        )
        # Three setImmediate-style yields to ensure the loop drains both.
        for _ in range(4):
            await asyncio.sleep(0)
        publishes = [(s, p) for s, p in nc.published if s == "orders.exec_reports.ibkr"]
        assert len(publishes) == 1
        _, report = publishes[0]
        assert report["broker_order_id"] == "O-GOOD"
        assert report["event"] == "rejected"
    finally:
        await bridge.stop()


@pytest.mark.asyncio
async def test_bridge_stop_is_idempotent() -> None:
    bridge, _nc, _session = _bridge_with_fakes()
    await bridge.start()
    await bridge.stop()
    await bridge.stop()  # second stop is a no-op
