"""Tests for ``quantfoundry_ibkr_nt.broker_bridge`` (QF-240).

Pure helper tests + bridge handler tests using a minimal fake
NatsClient + IbkrSessionClient so we don't need a running NATS server
or a connected IB Gateway. The exec-event fan-out is exercised through
a manual queue.

The IBKR side is observation-only — there are no submit/cancel
handlers to test (and the bridge intentionally doesn't subscribe to
``orders.submit.ibkr`` / ``orders.cancel.ibkr``).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from quantfoundry_ibkr_nt.broker_bridge import (
    IbkrBrokerBridge,
    derive_broker_status,
    event_to_exec_report,
    ibkr_order_to_broker_status,
    ibkr_position_to_broker_position,
    ibkr_status_to_broker_status,
    subjects_for,
)
from quantfoundry_ibkr_nt.session import (
    IbkrEvent,
    IbkrOrder,
    IbkrOrderNotFoundError,
    IbkrPosition,
    IbkrSessionError,
    is_rejection_error_code,
)

# ── subjects_for ──────────────────────────────────────────────────


def test_subjects_for_ibkr_excludes_submit_cancel() -> None:
    """Observation-only: only status + positions + exec_reports."""
    subjects = subjects_for("ibkr")
    assert subjects == {
        "status": "orders.status.ibkr",
        "positions": "orders.positions.ibkr",
        "exec_reports": "orders.exec_reports.ibkr",
    }
    assert "submit" not in subjects
    assert "cancel" not in subjects


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
        assert rpt.intent_id is None  # IBKR is observation-only

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


@pytest.mark.asyncio
async def test_bridge_subscribes_only_to_status_and_positions() -> None:
    """Critical observation-only property: the bridge MUST NOT subscribe
    to orders.submit.ibkr or orders.cancel.ibkr."""
    bridge, nc, _session = _bridge_with_fakes()
    await bridge.start()
    try:
        subjects = [s for s, _ in nc.subscriptions]
        assert "orders.status.ibkr" in subjects
        assert "orders.positions.ibkr" in subjects
        assert "orders.submit.ibkr" not in subjects
        assert "orders.cancel.ibkr" not in subjects
    finally:
        await bridge.stop()


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
        # status is at index 0 (first subscribed)
        _, cb = nc.subscriptions[0]
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
        _, cb = nc.subscriptions[0]
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
        _, cb = nc.subscriptions[0]
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
        _, cb = nc.subscriptions[0]
        msg = _FakeMsg(b"not json")
        await cb(msg)
        _, reply = nc.published[-1]
        assert reply["status"] == "unknown"
        assert "malformed request" in reply["rejection_reason"]
    finally:
        await bridge.stop()


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
        # positions is at index 1
        _, cb = nc.subscriptions[1]
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
        _, cb = nc.subscriptions[1]
        msg = _FakeMsg(b"{}")
        await cb(msg)
        _, reply = nc.published[-1]
        assert isinstance(reply, dict)
        assert "permission denied" in reply["error"]
    finally:
        await bridge.stop()


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
