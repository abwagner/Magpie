"""Tests for ``quantfoundry_schwab_nt.quotes``.

Pure parsing tests — no streamer connection, no I/O. Validates that
Schwab's LEVELONE indexed-field rows map into :class:`OptionQuote`
correctly and that the aggregator merges deltas into the right
per-symbol slot.
"""

from __future__ import annotations

from typing import Any

import pytest
from quantfoundry_schwab_nt.quotes import (
    LEVELONE_FUTURES_OPTIONS_FIELDS_PARAM,
    LEVELONE_OPTIONS_FIELDS_PARAM,
    QuoteAggregator,
    parse_levelone_futures_options_row,
    parse_levelone_options_row,
)

# ── Fixtures ──────────────────────────────────────────────────────


def _full_row(symbol: str = "SPY  260516C00500000") -> dict[str, Any]:
    """A snapshot frame with every QF-relevant field present."""
    return {
        "key": symbol,
        "0": symbol,
        "2": 12.34,  # bid_price
        "3": 12.56,  # ask_price
        "4": 12.45,  # last_price
        "8": 4823,  # volume
        "9": 19284,  # open_interest
        "10": 0.21,  # IV
        "16": 25,  # bid_size
        "17": 30,  # ask_size
        "18": 1,  # last_size
        "20": 500.0,  # strike_price
        "21": "C",  # contract_type
        "22": "SPY",  # underlying_symbol
        "27": 14,  # DTE
        "28": 0.42,  # delta
        "29": 0.018,  # gamma
        "30": -0.07,  # theta
        "31": 0.55,  # vega
        "32": 0.04,  # rho
        "35": 588.42,  # underlying_price
        "37": 12.45,  # mark
        "38": 1715825400000,  # quote_time_ms
        "39": 1715825399000,  # trade_time_ms
    }


# ── parse_levelone_options_row — happy path ─────────────────────


class TestSnapshotParse:
    def test_full_snapshot_populates_all_fields(self) -> None:
        row = _full_row()
        q = parse_levelone_options_row(row)
        assert q.symbol == "SPY  260516C00500000"
        assert q.bid_price == 12.34
        assert q.ask_price == 12.56
        assert q.bid_size == 25
        assert q.ask_size == 30
        assert q.implied_volatility == pytest.approx(0.21)
        assert q.delta == pytest.approx(0.42)
        assert q.contract_type == "C"
        assert q.underlying_symbol == "SPY"
        assert q.underlying_price == pytest.approx(588.42)
        assert q.quote_time_ms == 1715825400000
        assert q.days_to_expiration == 14
        assert q.is_quote_ready() is True

    def test_minimal_snapshot_leaves_unsent_fields_none(self) -> None:
        # Only the four NT-required fields plus symbol.
        row = {"0": "SPY  260516C00500000", "2": 1.0, "3": 1.05, "16": 5, "17": 6}
        q = parse_levelone_options_row(row)
        assert q.is_quote_ready()
        assert q.delta is None
        assert q.implied_volatility is None
        assert q.strike_price is None

    def test_missing_symbol_raises(self) -> None:
        with pytest.raises(ValueError, match="missing symbol"):
            parse_levelone_options_row({"2": 1.0})

    def test_coerces_string_numbers(self) -> None:
        # Schwab streams numerics as primitives but tests of partial
        # decoders sometimes pass strings — be tolerant.
        row = {"0": "X", "2": "1.5", "3": "1.6", "16": "10", "17": "12"}
        q = parse_levelone_options_row(row)
        assert q.bid_price == 1.5
        assert q.bid_size == 10
        assert q.ask_size == 12


# ── Delta updates via base ─────────────────────────────────────


class TestDelta:
    def test_delta_keeps_sticky_metadata(self) -> None:
        base = parse_levelone_options_row(_full_row())
        # Delta updates only the changed numeric fields.
        delta_row = {"0": base.symbol, "2": 12.50, "16": 28}
        merged = parse_levelone_options_row(delta_row, base=base)
        # Updated fields take new values.
        assert merged.bid_price == 12.50
        assert merged.bid_size == 28
        # Unchanged fields retained from base.
        assert merged.ask_price == 12.56
        assert merged.ask_size == 30
        assert merged.contract_type == "C"
        assert merged.strike_price == 500.0
        assert merged.delta == pytest.approx(0.42)

    def test_delta_does_not_clobber_with_none(self) -> None:
        # Schwab never sends an explicit `null` for a field, but be
        # defensive — if it does, treat as "no change" rather than
        # overwriting.
        base = parse_levelone_options_row(_full_row())
        merged = parse_levelone_options_row(
            {"0": base.symbol, "2": None, "3": 13.0},
            base=base,
        )
        assert merged.bid_price == 12.34  # preserved
        assert merged.ask_price == 13.0


# ── Futures-options variant ────────────────────────────────────


class TestFuturesOptions:
    def test_futures_options_row_parses_the_same_layout(self) -> None:
        # The indexed-field layout is shared between LEVELONE_OPTIONS
        # and LEVELONE_FUTURES_OPTIONS for the QF-relevant subset.
        row = _full_row("/ESM26C5800")
        q = parse_levelone_futures_options_row(row)
        assert q.symbol == "/ESM26C5800"
        assert q.bid_price == 12.34


# ── QuoteAggregator ───────────────────────────────────────────


class TestQuoteAggregator:
    def test_ingest_returns_merged_state(self) -> None:
        agg = QuoteAggregator()
        snapshot = _full_row("AAPL  260516C00185000")
        first = agg.ingest(snapshot, service="LEVELONE_OPTIONS")
        assert first.bid_price == 12.34
        delta = {"0": "AAPL  260516C00185000", "2": 99.99}
        second = agg.ingest(delta, service="LEVELONE_OPTIONS")
        # Returned snapshot reflects the delta + sticky metadata.
        assert second.bid_price == 99.99
        assert second.strike_price == 500.0  # from the original snapshot
        assert second.contract_type == "C"

    def test_per_symbol_isolation(self) -> None:
        agg = QuoteAggregator()
        a = _full_row("AAPL  260516C00185000")
        b = _full_row("SPY  260516C00500000")
        b["2"] = 7.77
        agg.ingest(a, service="LEVELONE_OPTIONS")
        agg.ingest(b, service="LEVELONE_OPTIONS")
        # AAPL bid_price stays at 12.34; SPY at 7.77.
        assert agg.snapshot("AAPL  260516C00185000").bid_price == 12.34  # type: ignore[union-attr]
        assert agg.snapshot("SPY  260516C00500000").bid_price == 7.77  # type: ignore[union-attr]

    def test_clear_drops_one_symbol(self) -> None:
        agg = QuoteAggregator()
        agg.ingest(_full_row("AAPL"), service="LEVELONE_OPTIONS")
        agg.ingest(_full_row("SPY"), service="LEVELONE_OPTIONS")
        agg.clear("AAPL")
        assert agg.snapshot("AAPL") is None
        assert agg.snapshot("SPY") is not None

    def test_clear_all(self) -> None:
        agg = QuoteAggregator()
        agg.ingest(_full_row("AAPL"), service="LEVELONE_OPTIONS")
        agg.clear()
        assert agg.snapshot("AAPL") is None

    def test_unsupported_service_raises(self) -> None:
        agg = QuoteAggregator()
        with pytest.raises(ValueError, match="unsupported LEVELONE service"):
            agg.ingest({"0": "x", "2": 1.0}, service="SOMETHING_ELSE")

    def test_futures_options_service_routes_correctly(self) -> None:
        agg = QuoteAggregator()
        q = agg.ingest(_full_row("/ESM26C5800"), service="LEVELONE_FUTURES_OPTIONS")
        assert q.symbol == "/ESM26C5800"
        assert q.bid_price == 12.34


# ── Field-param strings ───────────────────────────────────────


class TestFieldParam:
    def test_both_params_are_comma_separated_numeric_ascending(self) -> None:
        for param in (
            LEVELONE_OPTIONS_FIELDS_PARAM,
            LEVELONE_FUTURES_OPTIONS_FIELDS_PARAM,
        ):
            parts = param.split(",")
            ints = [int(p) for p in parts]
            assert ints == sorted(ints)

    def test_includes_required_quote_indices(self) -> None:
        # Bid/ask/sizes + key (0) and timestamps are non-negotiable for
        # NT QuoteTick construction; assert they're in the param string
        # so a default subscription is QuoteTick-complete on snapshot.
        for required_idx in ("0", "2", "3", "16", "17", "38"):
            assert required_idx in LEVELONE_OPTIONS_FIELDS_PARAM.split(",")
