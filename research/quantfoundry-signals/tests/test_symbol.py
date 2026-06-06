"""Tests for ``quantfoundry_signals.symbol``.

Mirror the test coverage of ``server/signals/symbol.ts`` — every class
parses round-trip cleanly; malformed inputs raise with a descriptive
``ValueError``; strike formatting drops trailing zeros.
"""

from __future__ import annotations

import pytest
from quantfoundry_signals.symbol import (
    EqSymbol,
    FopSymbol,
    FutSymbol,
    OptSymbol,
    VSymbol,
    format_symbol,
    parse_symbol,
)


class TestParseEq:
    def test_basic(self) -> None:
        assert parse_symbol("EQ:SPY") == EqSymbol(ticker="SPY")

    def test_ticker_with_digits_and_dash(self) -> None:
        assert parse_symbol("EQ:BRK-B").ticker == "BRK-B"

    def test_wrong_part_count_raises(self) -> None:
        with pytest.raises(ValueError, match="EQ symbol must have 2 parts"):
            parse_symbol("EQ:SPY:extra")

    def test_lowercase_ticker_rejected(self) -> None:
        with pytest.raises(ValueError, match="Invalid ticker"):
            parse_symbol("EQ:spy")


class TestParseOpt:
    def test_basic(self) -> None:
        sym = parse_symbol("OPT:SPY:2026-01-16:C:500")
        assert isinstance(sym, OptSymbol)
        assert sym.root == "SPY"
        assert sym.expiry == "2026-01-16"
        assert sym.right == "C"
        assert sym.strike == 500.0

    def test_fractional_strike(self) -> None:
        sym = parse_symbol("OPT:SPY:2026-01-16:C:500.5")
        assert isinstance(sym, OptSymbol)
        assert sym.strike == 500.5

    def test_wrong_part_count_raises(self) -> None:
        with pytest.raises(ValueError, match="OPT symbol must have 5 parts"):
            parse_symbol("OPT:SPY:2026-01-16:C")

    def test_bad_date_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid expiry date"):
            parse_symbol("OPT:SPY:2026/01/16:C:500")

    def test_bad_right_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid right"):
            parse_symbol("OPT:SPY:2026-01-16:X:500")

    def test_negative_strike_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid strike"):
            parse_symbol("OPT:SPY:2026-01-16:C:-500")

    def test_zero_strike_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid strike"):
            parse_symbol("OPT:SPY:2026-01-16:C:0")


class TestParseFut:
    def test_yymm(self) -> None:
        assert parse_symbol("FUT:ES:2026-06") == FutSymbol(
            root="ES", contract="2026-06"
        )

    def test_yymmdd(self) -> None:
        assert parse_symbol("FUT:CL:2026-06-20").contract == "2026-06-20"

    def test_token_contract(self) -> None:
        # E-mini "ESM6" style — TS allows TOKEN_RE for FUT contracts.
        assert parse_symbol("FUT:ES:ESM6").contract == "ESM6"

    def test_bad_contract_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid contract"):
            parse_symbol("FUT:ES:not.a.contract")


class TestParseFop:
    def test_basic(self) -> None:
        sym = parse_symbol("FOP:ES:2026-06:2026-05-23:C:5000")
        assert isinstance(sym, FopSymbol)
        assert sym.root == "ES"
        assert sym.contract == "2026-06"
        assert sym.expiry == "2026-05-23"
        assert sym.right == "C"
        assert sym.strike == 5000.0

    def test_wrong_part_count_raises(self) -> None:
        with pytest.raises(ValueError, match="FOP symbol must have 6 parts"):
            parse_symbol("FOP:ES:2026-06:2026-05-23:C")


class TestParseV:
    def test_basic_lowercase(self) -> None:
        assert parse_symbol("V:regime-spx-vol") == VSymbol(label="regime-spx-vol")

    def test_mixed_case_label(self) -> None:
        # Per TS implementation, V labels are case-insensitive at parse.
        assert parse_symbol("V:RegimeSPX").label == "RegimeSPX"

    def test_bad_label_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid virtual label"):
            parse_symbol("V:regime spx")  # space disallowed


class TestParseBadShape:
    def test_empty_string(self) -> None:
        with pytest.raises(ValueError, match="non-empty string"):
            parse_symbol("")

    def test_unknown_class(self) -> None:
        with pytest.raises(ValueError, match="Unknown symbol class"):
            parse_symbol("XYZ:foo")


class TestFormatRoundTrip:
    @pytest.mark.parametrize(
        "sym",
        [
            "EQ:SPY",
            "OPT:SPY:2026-01-16:C:500",
            "OPT:SPY:2026-01-16:P:4787.5",
            "FUT:ES:2026-06",
            "FOP:ES:2026-06:2026-05-23:C:5000",
            "V:regime-spx-vol",
        ],
    )
    def test_parse_format_round_trips(self, sym: str) -> None:
        assert format_symbol(parse_symbol(sym)) == sym

    def test_integer_strike_has_no_decimal(self) -> None:
        # 500.0 → "500", not "500.0"
        assert format_symbol(parse_symbol("OPT:SPY:2026-01-16:C:500")).endswith(":500")

    def test_fractional_strike_preserved(self) -> None:
        assert format_symbol(parse_symbol("OPT:SPY:2026-01-16:C:4787.5")).endswith(
            ":4787.5"
        )
