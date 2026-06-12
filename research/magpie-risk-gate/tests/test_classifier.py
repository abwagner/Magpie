"""QF-313 — closing classifier truth-table.

Mirrors docs/tdd/risk-gate-architecture.md §4.1.
"""

from __future__ import annotations

import pytest
from magpie_risk_gate.classifier import is_strictly_closing


class TestStrictlyClosingLong:
    """Long N current position."""

    def test_sell_at_position_qty_is_closing(self) -> None:
        assert is_strictly_closing(current_position_qty=5, side="sell", order_qty=5)

    def test_sell_below_position_qty_is_closing(self) -> None:
        assert is_strictly_closing(current_position_qty=5, side="sell", order_qty=3)

    def test_sell_above_position_qty_is_mixed_not_closing(self) -> None:
        # Long 5, sell 7 = close 5 + flip short 2. Not strictly closing.
        assert not is_strictly_closing(current_position_qty=5, side="sell", order_qty=7)

    def test_buy_is_adding_not_closing(self) -> None:
        assert not is_strictly_closing(current_position_qty=5, side="buy", order_qty=2)


class TestStrictlyClosingShort:
    """Short N current position (qty stored as negative)."""

    def test_buy_at_position_qty_is_closing(self) -> None:
        assert is_strictly_closing(current_position_qty=-5, side="buy", order_qty=5)

    def test_buy_below_position_qty_is_closing(self) -> None:
        assert is_strictly_closing(current_position_qty=-5, side="buy", order_qty=2)

    def test_buy_above_position_qty_is_mixed_not_closing(self) -> None:
        assert not is_strictly_closing(current_position_qty=-5, side="buy", order_qty=8)

    def test_sell_is_adding_not_closing(self) -> None:
        assert not is_strictly_closing(
            current_position_qty=-5, side="sell", order_qty=2
        )


class TestFlat:
    """Flat position rejects everything."""

    @pytest.mark.parametrize("side", ["buy", "sell"])
    def test_anything_is_opening_not_closing(self, side: str) -> None:
        assert not is_strictly_closing(
            current_position_qty=0,
            side=side,  # type: ignore[arg-type]
            order_qty=1,
        )


class TestEdgeCases:
    def test_zero_qty_order_is_not_closing(self) -> None:
        # Defensive: a 0-qty order isn't classifiable as closing.
        assert not is_strictly_closing(current_position_qty=5, side="sell", order_qty=0)

    def test_negative_qty_order_is_not_closing(self) -> None:
        # Defensive: NT shouldn't emit negative qty, but check anyway.
        assert not is_strictly_closing(
            current_position_qty=5, side="sell", order_qty=-1
        )

    def test_long_side_alias_treated_as_buy(self) -> None:
        # Wire layer may send "Long" (NT-style); should adding-mode.
        assert not is_strictly_closing(current_position_qty=5, side="Long", order_qty=3)

    def test_short_side_alias_treated_as_sell(self) -> None:
        # Wire layer may send "Short"; should be closing-mode for long position.
        assert is_strictly_closing(current_position_qty=5, side="Short", order_qty=3)
