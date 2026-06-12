"""Tests for ``magpie_schwab_nt.account_activity``.

Pure parsing tests; no I/O. Validates that every ACCT_ACTIVITY
message type the parser claims to handle produces the right typed
event, and that unknown / malformed shapes degrade to
:class:`RawActivityEvent` instead of raising.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from magpie_schwab_nt.account_activity import (
    CancelReplaceEvent,
    FillEvent,
    OrderEvent,
    RawActivityEvent,
    parse_account_activity_row,
)


def _row(message_type: str, payload: dict[str, Any] | str) -> dict[str, Any]:
    """Build a typical ACCT_ACTIVITY content row."""
    data: Any = payload if isinstance(payload, str) else json.dumps(payload)
    return {"key": "ACCT_KEY", "1": "12345678", "2": message_type, "3": data}


class TestSimpleEvents:
    @pytest.mark.parametrize(
        "message_type, expected_kind",
        [
            ("OrderEntryRequest", "submitted"),
            ("OrderActivation", "accepted"),
            ("OrderRejection", "rejected"),
            ("OrderCancelRequest", "canceled"),
            ("TooLateToCancel", "canceled"),
            ("UROUT", "canceled"),
        ],
    )
    def test_typed_kind(self, message_type: str, expected_kind: str) -> None:
        row = _row(message_type, {"orderId": "12345"})
        event = parse_account_activity_row(row)
        assert isinstance(event, OrderEvent)
        assert event.kind == expected_kind
        assert event.order_id == "12345"
        assert event.account_number == "12345678"
        assert event.message_type == message_type

    def test_handles_dict_payload_not_string(self) -> None:
        # Field 3 may already be decoded by the streamer layer.
        row = {
            "1": "12345678",
            "2": "OrderActivation",
            "3": {"orderId": "999"},
        }
        event = parse_account_activity_row(row)
        assert event.kind == "accepted"
        assert event.order_id == "999"


class TestFillEvents:
    def test_partial_fill_carries_quantities(self) -> None:
        row = _row(
            "OrderPartialFill",
            {
                "orderId": "12345",
                "executionQuantity": 3,
                "executionPrice": 100.5,
                "cumulativeFilledQuantity": 3,
                "totalQuantity": 10,
            },
        )
        event = parse_account_activity_row(row)
        assert isinstance(event, FillEvent)
        assert event.kind == "partial_fill"
        assert event.fill_quantity == 3.0
        assert event.fill_price == 100.5
        assert event.cumulative_filled == 3.0
        assert event.remaining_quantity == 7.0
        assert event.derived_status == "PARTIALLY_FILLED"

    def test_full_fill_carries_filled_status(self) -> None:
        row = _row(
            "OrderFill",
            {
                "orderId": "12345",
                "executionQuantity": 10,
                "executionPrice": 100.5,
                "cumulativeFilledQuantity": 10,
                "totalQuantity": 10,
            },
        )
        event = parse_account_activity_row(row)
        assert isinstance(event, FillEvent)
        assert event.kind == "filled"
        assert event.derived_status == "FILLED"
        assert event.remaining_quantity == 0.0

    def test_alternate_field_names(self) -> None:
        # Schwab sometimes uses different key shapes for the same
        # logical field. The parser tries a small fallback chain.
        row = _row(
            "OrderFill",
            {
                "orderId": "12345",
                "fillQuantity": 5,
                "fillPrice": 50.0,
                "cumulativeQuantity": 5,
                "orderQuantity": 5,
            },
        )
        event = parse_account_activity_row(row)
        assert isinstance(event, FillEvent)
        assert event.fill_quantity == 5.0
        assert event.fill_price == 50.0


class TestReplaceEvent:
    def test_cancel_replace_carries_new_order_id(self) -> None:
        row = _row(
            "OrderCancelReplaceRequest",
            {"orderId": "OLD", "newOrderId": "NEW"},
        )
        event = parse_account_activity_row(row)
        assert isinstance(event, CancelReplaceEvent)
        assert event.kind == "replaced"
        assert event.old_order_id == "OLD"
        assert event.new_order_id == "NEW"


class TestSubscribedAndError:
    def test_subscribed_kind(self) -> None:
        row = _row("SUBSCRIBED", {"ack": True})
        event = parse_account_activity_row(row)
        assert event.kind == "subscribed"
        assert event.account_number == "12345678"

    def test_error_kind_preserves_message(self) -> None:
        row = _row("ERROR", {"error": "stream closed"})
        event = parse_account_activity_row(row)
        assert isinstance(event, RawActivityEvent)
        assert event.kind == "error"
        assert event.error == "stream closed"


class TestFallback:
    def test_unknown_message_type_falls_back_to_raw(self) -> None:
        row = _row("MartianAlert", {"orderId": "12345"})
        event = parse_account_activity_row(row)
        assert isinstance(event, RawActivityEvent)
        assert event.kind == "raw"
        assert event.order_id == "12345"
        assert event.error and "MartianAlert" in event.error

    def test_malformed_payload_string_falls_back_to_raw(self) -> None:
        row = {"1": "12345678", "2": "OrderActivation", "3": "{ not json"}
        event = parse_account_activity_row(row)
        assert isinstance(event, RawActivityEvent)
        assert event.kind == "raw"
        assert event.error == "message_data not a JSON object"

    def test_missing_payload_falls_back(self) -> None:
        row = {"1": "12345678", "2": "OrderActivation"}
        event = parse_account_activity_row(row)
        assert isinstance(event, RawActivityEvent)
        assert event.kind == "raw"
