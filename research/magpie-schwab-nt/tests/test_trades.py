"""Tests for ``magpie_schwab_nt.trades``.

Pure parsing tests — no streamer connection. Validates that Schwab's
TIMESALE indexed-field rows map into :class:`OptionTrade` correctly
and that the Lee-Ready aggressor classifier covers the documented
cases.
"""

from __future__ import annotations

import pytest
from magpie_schwab_nt.trades import (
    TIMESALE_FUTURES_OPTIONS_FIELDS_PARAM,
    TIMESALE_OPTIONS_FIELDS_PARAM,
    OptionTrade,
    classify_aggressor,
    parse_timesale_futures_options_row,
    parse_timesale_options_row,
)

# ── parse_timesale_options_row ────────────────────────────────────


class TestParse:
    def test_full_row_populates_all_fields(self) -> None:
        row = {
            "key": "SPY  260516C00500000",
            "0": "SPY  260516C00500000",
            "1": 1715825400000,
            "2": 12.45,
            "3": 7,
            "4": 998877,
        }
        trade = parse_timesale_options_row(row)
        assert trade.symbol == "SPY  260516C00500000"
        assert trade.price == 12.45
        assert trade.size == 7
        assert trade.trade_time_ms == 1715825400000
        assert trade.sequence == 998877
        assert trade.aggressor_side == "unknown"

    def test_sequence_optional(self) -> None:
        row = {"0": "X", "1": 1715825400000, "2": 1.5, "3": 3}
        trade = parse_timesale_options_row(row)
        assert trade.sequence is None

    def test_missing_symbol_raises(self) -> None:
        with pytest.raises(ValueError, match="missing symbol"):
            parse_timesale_options_row({"1": 1, "2": 1.0, "3": 1})

    @pytest.mark.parametrize("missing_idx", ["1", "2", "3"])
    def test_missing_required_field_raises(self, missing_idx: str) -> None:
        row: dict[str, object] = {
            "0": "X",
            "1": 1715825400000,
            "2": 1.5,
            "3": 3,
        }
        row.pop(missing_idx)
        with pytest.raises(ValueError, match="missing required"):
            parse_timesale_options_row(row)

    def test_coerces_string_numbers(self) -> None:
        row = {"0": "X", "1": "1715825400000", "2": "1.5", "3": "3"}
        trade = parse_timesale_options_row(row)
        assert trade.price == 1.5
        assert trade.size == 3
        assert trade.trade_time_ms == 1715825400000

    def test_none_treated_as_missing(self) -> None:
        # Schwab is documented not to send explicit nulls, but the
        # parser is defensive — None for a required field is treated
        # as absent and surfaces the same error.
        row = {"0": "X", "1": 1, "2": None, "3": 5}
        with pytest.raises(ValueError, match="missing required field: price"):
            parse_timesale_options_row(row)

    def test_frozen_dataclass(self) -> None:
        from dataclasses import FrozenInstanceError

        trade = OptionTrade(symbol="X", price=1.0, size=1, trade_time_ms=1)
        with pytest.raises(FrozenInstanceError):
            trade.price = 2.0  # type: ignore[misc]


class TestFuturesOptions:
    def test_futures_options_row_parses_the_same_layout(self) -> None:
        row = {"0": "/ESM26C5800", "1": 1715825400000, "2": 50.0, "3": 2}
        trade = parse_timesale_futures_options_row(row)
        assert trade.symbol == "/ESM26C5800"
        assert trade.price == 50.0
        assert trade.size == 2


# ── Lee-Ready classifier ─────────────────────────────────────────


class TestLeeReady:
    def test_at_or_above_ask_is_buyer(self) -> None:
        assert classify_aggressor(10.05, bid=10.00, ask=10.05) == "buyer"
        assert classify_aggressor(10.10, bid=10.00, ask=10.05) == "buyer"

    def test_at_or_below_bid_is_seller(self) -> None:
        assert classify_aggressor(10.00, bid=10.00, ask=10.05) == "seller"
        assert classify_aggressor(9.95, bid=10.00, ask=10.05) == "seller"

    def test_inside_spread_falls_back_to_tick_rule(self) -> None:
        # 10.02 is mid; uptick from 10.01 → buyer.
        assert (
            classify_aggressor(10.02, bid=10.00, ask=10.05, prev_trade_price=10.01)
            == "buyer"
        )
        # Downtick → seller.
        assert (
            classify_aggressor(10.02, bid=10.00, ask=10.05, prev_trade_price=10.03)
            == "seller"
        )
        # Zero-tick → unknown.
        assert (
            classify_aggressor(10.02, bid=10.00, ask=10.05, prev_trade_price=10.02)
            == "unknown"
        )

    def test_inside_spread_no_prev_price_unknown(self) -> None:
        assert classify_aggressor(10.02, bid=10.00, ask=10.05) == "unknown"

    def test_no_quote_uses_tick_rule_only(self) -> None:
        buyer = classify_aggressor(10.0, bid=None, ask=None, prev_trade_price=9.9)
        seller = classify_aggressor(10.0, bid=None, ask=None, prev_trade_price=10.1)
        unknown = classify_aggressor(10.0, bid=None, ask=None)
        assert buyer == "buyer"
        assert seller == "seller"
        assert unknown == "unknown"

    def test_partial_quote_falls_back_to_tick_rule(self) -> None:
        # Only one side of the book known — Lee-Ready needs both, so
        # fall through to the tick rule.
        assert (
            classify_aggressor(10.0, bid=9.9, ask=None, prev_trade_price=9.9) == "buyer"
        )


# ── Field-param strings ───────────────────────────────────────────


class TestFieldParam:
    def test_both_params_are_comma_separated_numeric_ascending(self) -> None:
        for param in (
            TIMESALE_OPTIONS_FIELDS_PARAM,
            TIMESALE_FUTURES_OPTIONS_FIELDS_PARAM,
        ):
            parts = param.split(",")
            ints = [int(p) for p in parts]
            assert ints == sorted(ints)
            # All five TIMESALE fields.
            assert ints == [0, 1, 2, 3, 4]
