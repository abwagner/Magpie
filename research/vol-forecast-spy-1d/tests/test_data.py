"""Tests for ``vol_forecast_spy_1d.data``."""

from __future__ import annotations

from pathlib import Path

import pytest
from vol_forecast_spy_1d.data import (
    FIXTURE_PATH,
    DailyReturn,
    load_returns_csv,
    recent_returns,
)


class TestLoadReturnsCsv:
    def test_fixture_loads(self) -> None:
        rows = load_returns_csv()
        assert len(rows) > 0
        assert all(isinstance(r, DailyReturn) for r in rows)
        # Returns are floats in a reasonable daily range.
        assert all(-0.5 < r.log_return < 0.5 for r in rows)

    def test_sorted_oldest_first(self) -> None:
        rows = load_returns_csv()
        assert [r.date for r in rows] == sorted(r.date for r in rows)

    def test_skips_blank_and_malformed_rows(self, tmp_path: Path) -> None:
        csv_path = tmp_path / "ragged.csv"
        csv_path.write_text(
            "date,log_return\n"
            "2025-01-02,0.01\n"
            ",0.02\n"  # blank date
            "2025-01-03,\n"  # blank value
            "2025-01-04,not-a-number\n"  # malformed
            "2025-01-05,-0.005\n"
        )
        rows = load_returns_csv(csv_path)
        assert [r.date for r in rows] == ["2025-01-02", "2025-01-05"]

    def test_rejects_csv_without_date_column(self, tmp_path: Path) -> None:
        csv_path = tmp_path / "no_header.csv"
        csv_path.write_text("foo,bar\n1,2\n")
        with pytest.raises(ValueError, match="'date'"):
            load_returns_csv(csv_path)


class TestRecentReturns:
    def test_window_caps_at_size(self) -> None:
        rows = [
            DailyReturn(date=f"2025-01-{d:02d}", log_return=0.01) for d in range(1, 11)
        ]
        got = recent_returns(rows, asof="2025-01-10", window=3)
        assert [r.date for r in got] == ["2025-01-08", "2025-01-09", "2025-01-10"]

    def test_filters_out_future_rows(self) -> None:
        rows = [
            DailyReturn(date="2025-01-01", log_return=0.01),
            DailyReturn(date="2025-01-02", log_return=0.02),
            DailyReturn(date="2025-01-03", log_return=0.03),
        ]
        got = recent_returns(rows, asof="2025-01-02", window=10)
        assert [r.date for r in got] == ["2025-01-01", "2025-01-02"]

    def test_zero_window_raises(self) -> None:
        with pytest.raises(ValueError, match="window must be"):
            recent_returns([], asof="2025-01-01", window=0)

    def test_fixture_at_known_asof(self) -> None:
        # Final asof in the fixture — should return up to N rows.
        rows = load_returns_csv(FIXTURE_PATH)
        got = recent_returns(rows, asof="2025-03-31", window=20)
        assert len(got) == 20
        assert got[-1].date == "2025-03-31"
