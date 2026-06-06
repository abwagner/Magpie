"""Closing classifier for the fail-open path.

Implements the §4.1 truth-table from
docs/tdd/risk-gate-architecture.md. Pure function: takes the current
position + the order side/qty and classifies as strictly closing or
not. Any opening component means not-closing.

Truth table:

  Current position | Order side | Order qty | Classification
  ----------------+------------+-----------+-----------------
  Long N           | sell       | qty <= N  | strictly closing
  Short N          | buy        | qty <= N  | strictly closing
  Long N           | sell       | qty > N   | mixed -> not closing
  Short N          | buy        | qty > N   | mixed -> not closing
  Flat             | any        | any       | opening -> not closing
  Long N           | buy        | any       | adding -> not closing
  Short N          | sell       | any       | adding -> not closing
"""

from __future__ import annotations

from typing import Literal

# Side narrows to the wire-level values gate-handler.ts emits.
Side = Literal["buy", "sell", "Long", "Short"]


def is_strictly_closing(
    current_position_qty: int,
    side: Side,
    order_qty: int,
) -> bool:
    """Classify the order against the current position.

    ``current_position_qty`` is signed: positive = long, negative =
    short, zero = flat. ``side`` is one of {"buy", "sell", "Long",
    "Short"} — wire-level values from GateRequestIntent. Returns True
    only when the order strictly reduces the position without flipping
    or adding.
    """

    if order_qty <= 0:
        # Defensive: a 0-or-negative qty isn't classifiable as
        # closing; treat as not-closing so fail-open rejects it.
        return False

    normalized_side = _normalize_side(side)

    # Flat position: anything opens.
    if current_position_qty == 0:
        return False

    # Long position: only a sell-side reducing order is closing.
    if current_position_qty > 0:
        return normalized_side == "sell" and order_qty <= current_position_qty

    # Short position (current_position_qty < 0): only a buy-side
    # reducing order is closing.
    return normalized_side == "buy" and order_qty <= abs(current_position_qty)


def _normalize_side(side: Side) -> Literal["buy", "sell"]:
    if side in ("buy", "Long"):
        return "buy"
    return "sell"
