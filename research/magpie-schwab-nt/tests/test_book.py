"""Tests for ``magpie_schwab_nt.book``.

Pure parsing + diffing tests — no streamer connection. Validates
that Schwab's OPTIONS_BOOK rows map into typed snapshots, that the
snapshot/delta diff produces the right add/update/delete events,
and that the per-symbol aggregator threads it together.
"""

from __future__ import annotations

from typing import Any

import pytest
from magpie_schwab_nt.book import (
    OPTIONS_BOOK_FIELDS_PARAM,
    OptionBookAggregator,
    OptionBookLevel,
    OptionBookSnapshot,
    diff_books,
    parse_options_book_row,
)

# ── Fixtures ──────────────────────────────────────────────────────


def _level(price: float, size: int, num_mms: int = 1) -> dict[str, Any]:
    return {"0": price, "1": size, "2": num_mms}


def _row(
    symbol: str = "SPY  260516C00500000",
    book_time_ms: int = 1715825400000,
    bids: list[dict[str, Any]] | None = None,
    asks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "key": symbol,
        "0": symbol,
        "1": book_time_ms,
        "2": bids if bids is not None else [_level(12.30, 5), _level(12.25, 10)],
        "3": asks if asks is not None else [_level(12.40, 7), _level(12.45, 12)],
    }


# ── parse_options_book_row ────────────────────────────────────────


class TestParse:
    def test_full_row_populates_snapshot(self) -> None:
        snap = parse_options_book_row(_row())
        assert snap.symbol == "SPY  260516C00500000"
        assert snap.book_time_ms == 1715825400000
        # Bids descending (best bid first).
        assert snap.bids == (
            OptionBookLevel(price=12.30, size=5, num_market_makers=1),
            OptionBookLevel(price=12.25, size=10, num_market_makers=1),
        )
        # Asks ascending (best ask first).
        assert snap.asks == (
            OptionBookLevel(price=12.40, size=7, num_market_makers=1),
            OptionBookLevel(price=12.45, size=12, num_market_makers=1),
        )

    def test_unsorted_input_is_sorted(self) -> None:
        # Schwab does not guarantee sort order in the array; the
        # parser must impose the bids-desc / asks-asc convention.
        snap = parse_options_book_row(
            _row(
                bids=[_level(12.20, 1), _level(12.30, 2), _level(12.25, 3)],
                asks=[_level(12.50, 1), _level(12.40, 2), _level(12.45, 3)],
            )
        )
        assert [lvl.price for lvl in snap.bids] == [12.30, 12.25, 12.20]
        assert [lvl.price for lvl in snap.asks] == [12.40, 12.45, 12.50]

    def test_empty_side_is_tolerated(self) -> None:
        snap = parse_options_book_row(_row(bids=[], asks=[]))
        assert snap.bids == ()
        assert snap.asks == ()
        assert snap.best_bid() is None
        assert snap.best_ask() is None

    def test_missing_side_treated_as_empty(self) -> None:
        snap = parse_options_book_row({"0": "X", "1": 1, "2": [_level(1.0, 1)]})
        assert len(snap.bids) == 1
        assert snap.asks == ()

    def test_malformed_level_dropped_silently(self) -> None:
        # Entries missing price or size are dropped — Schwab partial
        # frames shouldn't crash the parser.
        snap = parse_options_book_row(
            _row(
                bids=[
                    _level(12.30, 5),
                    {"0": 12.20},  # no size — dropped
                    {"1": 4},  # no price — dropped
                    _level(12.25, 8),
                ],
                asks=[_level(12.40, 7)],
            )
        )
        assert [lvl.price for lvl in snap.bids] == [12.30, 12.25]

    def test_missing_symbol_raises(self) -> None:
        with pytest.raises(ValueError, match="missing symbol"):
            parse_options_book_row({"1": 1, "2": [], "3": []})

    def test_missing_book_time_raises(self) -> None:
        with pytest.raises(ValueError, match="book_time_ms"):
            parse_options_book_row({"0": "X", "2": [], "3": []})

    def test_non_numeric_book_time_raises(self) -> None:
        with pytest.raises(ValueError, match="non-numeric book_time_ms"):
            parse_options_book_row({"0": "X", "1": "not-a-number", "2": [], "3": []})

    def test_best_bid_ask(self) -> None:
        snap = parse_options_book_row(_row())
        assert snap.best_bid() == OptionBookLevel(12.30, 5, 1)
        assert snap.best_ask() == OptionBookLevel(12.40, 7, 1)


# ── diff_books ────────────────────────────────────────────────────


class TestDiff:
    def test_first_snapshot_emits_all_levels_as_adds(self) -> None:
        snap = parse_options_book_row(_row())
        deltas = diff_books(None, snap)
        assert {d.action for d in deltas} == {"add"}
        assert len(deltas) == 4  # 2 bids + 2 asks
        bid_deltas = [d for d in deltas if d.side == "bid"]
        ask_deltas = [d for d in deltas if d.side == "ask"]
        assert sorted(d.price for d in bid_deltas) == [12.25, 12.30]
        assert sorted(d.price for d in ask_deltas) == [12.40, 12.45]

    def test_unchanged_snapshot_emits_no_deltas(self) -> None:
        snap = parse_options_book_row(_row())
        deltas = diff_books(snap, snap)
        assert deltas == []

    def test_size_change_is_update(self) -> None:
        prev = parse_options_book_row(_row())
        curr = parse_options_book_row(
            _row(bids=[_level(12.30, 99), _level(12.25, 10)])  # 5 → 99 at best bid
        )
        deltas = diff_books(prev, curr)
        assert len(deltas) == 1
        d = deltas[0]
        assert d.action == "update"
        assert d.side == "bid"
        assert d.price == 12.30
        assert d.new_size == 99

    def test_new_level_is_add(self) -> None:
        prev = parse_options_book_row(_row())
        curr = parse_options_book_row(
            _row(
                bids=[_level(12.30, 5), _level(12.25, 10), _level(12.20, 3)],
            )
        )
        deltas = diff_books(prev, curr)
        adds = [d for d in deltas if d.action == "add"]
        assert len(adds) == 1
        assert adds[0].price == 12.20
        assert adds[0].new_size == 3

    def test_removed_level_is_delete(self) -> None:
        prev = parse_options_book_row(_row())
        curr = parse_options_book_row(
            _row(bids=[_level(12.30, 5)])  # 12.25 disappears
        )
        deltas = diff_books(prev, curr)
        deletes = [d for d in deltas if d.action == "delete"]
        assert len(deletes) == 1
        assert deletes[0].price == 12.25
        assert deletes[0].new_size == 0

    def test_mm_count_change_is_update(self) -> None:
        prev = parse_options_book_row(_row(bids=[_level(12.30, 5, num_mms=1)]))
        curr = parse_options_book_row(_row(bids=[_level(12.30, 5, num_mms=3)]))
        deltas = diff_books(prev, curr)
        bid_deltas = [d for d in deltas if d.side == "bid"]
        # Only the MM-count change should produce a bid update.
        update = next(d for d in bid_deltas if d.action == "update")
        assert update.price == 12.30
        assert update.num_market_makers == 3

    def test_deltas_carry_curr_book_time(self) -> None:
        prev = parse_options_book_row(_row(book_time_ms=1000))
        curr = parse_options_book_row(_row(book_time_ms=2000))
        deltas = diff_books(prev, curr)
        # No level change, so no deltas; verify with a real change.
        curr2 = parse_options_book_row(
            _row(book_time_ms=2000, bids=[_level(12.30, 6), _level(12.25, 10)])
        )
        deltas = diff_books(prev, curr2)
        assert all(d.book_time_ms == 2000 for d in deltas)


# ── OptionBookAggregator ──────────────────────────────────────────


class TestAggregator:
    def test_first_ingest_returns_all_adds(self) -> None:
        agg = OptionBookAggregator()
        result = agg.ingest(_row())
        assert isinstance(result.snapshot, OptionBookSnapshot)
        assert all(d.action == "add" for d in result.deltas)
        assert len(result.deltas) == 4

    def test_subsequent_ingest_only_emits_diffs(self) -> None:
        agg = OptionBookAggregator()
        agg.ingest(_row())  # prime
        result = agg.ingest(_row(bids=[_level(12.30, 99), _level(12.25, 10)]))
        # Only the changed bid level → one update.
        assert len(result.deltas) == 1
        assert result.deltas[0].action == "update"
        assert result.deltas[0].new_size == 99

    def test_per_symbol_isolation(self) -> None:
        agg = OptionBookAggregator()
        agg.ingest(_row("AAPL  260516C00185000"))
        agg.ingest(_row("SPY  260516C00500000"))
        # AAPL's second frame: bid changes, SPY's state untouched.
        result = agg.ingest(
            _row(
                "AAPL  260516C00185000",
                bids=[_level(12.30, 99), _level(12.25, 10)],
            )
        )
        assert len(result.deltas) == 1
        spy = agg.snapshot("SPY  260516C00500000")
        assert spy is not None
        assert spy.best_bid() is not None
        assert spy.best_bid().price == 12.30  # type: ignore[union-attr]

    def test_snapshot_lookup(self) -> None:
        agg = OptionBookAggregator()
        agg.ingest(_row("AAPL"))
        assert agg.snapshot("AAPL") is not None
        assert agg.snapshot("MISSING") is None

    def test_clear_one(self) -> None:
        agg = OptionBookAggregator()
        agg.ingest(_row("AAPL"))
        agg.ingest(_row("SPY"))
        agg.clear("AAPL")
        assert agg.snapshot("AAPL") is None
        assert agg.snapshot("SPY") is not None

    def test_clear_all(self) -> None:
        agg = OptionBookAggregator()
        agg.ingest(_row("AAPL"))
        agg.ingest(_row("SPY"))
        agg.clear()
        assert agg.snapshot("AAPL") is None
        assert agg.snapshot("SPY") is None


# ── Field-param string ────────────────────────────────────────────


class TestFieldParam:
    def test_fields_param_is_zero_through_three(self) -> None:
        ints = [int(p) for p in OPTIONS_BOOK_FIELDS_PARAM.split(",")]
        assert ints == [0, 1, 2, 3]
