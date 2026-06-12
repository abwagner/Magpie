"""Tests for ``magpie_schwab_nt.order_status``.

Covers:
- mapping table coverage (every Schwab status has an NT target)
- WORKING + filled_quantity → PARTIALLY_FILLED derivation
- is_terminal classification
"""

from __future__ import annotations

import pytest
from magpie_schwab_nt.order_status import (
    ORDER_STATUS_MAPPING,
    derive_order_status,
    is_terminal,
)


class TestMapping:
    def test_covers_known_schwab_statuses(self) -> None:
        # Per QF-160 spike + Schwab Trader API docs. If Schwab adds a
        # status, this set diverges and the test fails so we patch the
        # table explicitly rather than silently mapping to INITIALIZED.
        expected = {
            "NEW",
            "AWAITING_PARENT_ORDER",
            "AWAITING_CONDITION",
            "AWAITING_STOP_CONDITION",
            "AWAITING_MANUAL_REVIEW",
            "AWAITING_RELEASE_TIME",
            "AWAITING_UR_OUT",
            "PENDING_ACTIVATION",
            "PENDING_ACKNOWLEDGEMENT",
            "PENDING_RECALL",
            "PENDING_CANCEL",
            "PENDING_REPLACE",
            "QUEUED",
            "ACCEPTED",
            "WORKING",
            "REJECTED",
            "CANCELED",
            "REPLACED",
            "FILLED",
            "EXPIRED",
            "UNKNOWN",
        }
        assert set(ORDER_STATUS_MAPPING) == expected

    def test_replaced_terminates_old_order(self) -> None:
        # Per QF-160 caveat: REPLACED on the OLD order is terminal,
        # the NEW order is independent. We map to CANCELED.
        assert ORDER_STATUS_MAPPING["REPLACED"] == "CANCELED"


class TestDerive:
    def test_working_with_no_fills_is_accepted(self) -> None:
        assert (
            derive_order_status("WORKING", filled_quantity=0.0, total_quantity=10.0)
            == "ACCEPTED"
        )

    def test_working_with_partial_fill_is_partially_filled(self) -> None:
        assert (
            derive_order_status("WORKING", filled_quantity=3.0, total_quantity=10.0)
            == "PARTIALLY_FILLED"
        )

    def test_working_with_complete_fill_is_still_accepted_until_filled_status(
        self,
    ) -> None:
        # Schwab updates `status: FILLED` separately; until then,
        # `WORKING + filledQuantity == totalQuantity` is a transitional
        # state. Don't upgrade to FILLED without the status flag —
        # Schwab might still emit a broken-trade event.
        assert (
            derive_order_status("WORKING", filled_quantity=10.0, total_quantity=10.0)
            == "ACCEPTED"
        )

    def test_filled_status_passes_through(self) -> None:
        assert (
            derive_order_status("FILLED", filled_quantity=10.0, total_quantity=10.0)
            == "FILLED"
        )

    def test_unknown_status_defaults_to_initialized(self) -> None:
        assert (
            derive_order_status("MARTIAN", filled_quantity=0.0, total_quantity=1.0)
            == "INITIALIZED"
        )

    @pytest.mark.parametrize(
        "schwab_status, expected",
        [
            ("PENDING_CANCEL", "PENDING_CANCEL"),
            ("AWAITING_UR_OUT", "PENDING_CANCEL"),
            ("PENDING_RECALL", "PENDING_CANCEL"),
            ("PENDING_REPLACE", "PENDING_UPDATE"),
            ("AWAITING_PARENT_ORDER", "PENDING_UPDATE"),
        ],
    )
    def test_pending_states_map_as_documented(
        self, schwab_status: str, expected: str
    ) -> None:
        assert derive_order_status(schwab_status, 0.0, 100.0) == expected


class TestTerminal:
    @pytest.mark.parametrize(
        "status",
        ["REJECTED", "CANCELED", "EXPIRED", "FILLED", "DENIED"],
    )
    def test_terminal_states(self, status: str) -> None:
        assert is_terminal(status) is True  # type: ignore[arg-type]

    @pytest.mark.parametrize(
        "status",
        ["INITIALIZED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "PENDING_CANCEL"],
    )
    def test_non_terminal_states(self, status: str) -> None:
        assert is_terminal(status) is False  # type: ignore[arg-type]
