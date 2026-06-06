"""Schwab `TIMESALE_OPTIONS` (and futures variant) → trade ticks.

Pure parsing layer on top of QF-162's streamer. Translates Schwab's
indexed-field TIMESALE rows into typed :class:`OptionTrade` records,
and offers a Lee-Ready side-classifier for callers that need an
aggressor-side hint (Schwab's TIMESALE feed does not carry one).

Schwab's TIMESALE delivery contract:

1. After SUBS, Schwab pushes a frame for each subscribed symbol as
   trades print on the exchange. There is no separate snapshot/delta
   split — each row is a self-contained trade.
2. The ``key`` field (Schwab field 0) is always the option symbol so
   we can route to the right consumer; trades are otherwise stateless.

Lower-volume than LEVELONE_OPTIONS — strategies that subscribe to a
wide universe of options should weight TIMESALE bandwidth budget
lower than LEVELONE.

Reference: QF-165. Sibling: QF-164 (LEVELONE quotes), QF-166
(OPTIONS_BOOK depth).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

# ── Field maps ────────────────────────────────────────────────────
#
# Schwab indexes streamer fields by stringified integers in the JSON
# content. TIMESALE_OPTIONS exposes a five-field record — no Greeks,
# no NBBO, no aggressor flag. The futures-options variant uses the
# same numeric layout for the QF-relevant subset.
#
# Source: Schwab Developer Portal, Trader API → Streaming → TIMESALE
# message specs.

TIMESALE_OPTIONS_FIELDS: dict[str, str] = {
    "0": "symbol",  # key
    "1": "trade_time_ms",
    "2": "price",
    "3": "size",
    "4": "sequence",
}

TIMESALE_FUTURES_OPTIONS_FIELDS: dict[str, str] = dict(TIMESALE_OPTIONS_FIELDS)

# Comma-separated index strings for the SUBS `fields` parameter.
TIMESALE_OPTIONS_FIELDS_PARAM: str = ",".join(sorted(TIMESALE_OPTIONS_FIELDS, key=int))
TIMESALE_FUTURES_OPTIONS_FIELDS_PARAM: str = ",".join(
    sorted(TIMESALE_FUTURES_OPTIONS_FIELDS, key=int)
)


# ── Trade record ──────────────────────────────────────────────────


AggressorSide = Literal["buyer", "seller", "unknown"]


@dataclass(frozen=True)
class OptionTrade:
    """One trade print.

    ``aggressor_side`` is always ``"unknown"`` at parse time — Schwab
    does not stream an aggressor flag in TIMESALE. Callers that need
    a side hint should pair the trade with the most recent NBBO and
    call :func:`classify_aggressor`.
    """

    symbol: str
    price: float
    size: int
    trade_time_ms: int
    sequence: int | None = None
    aggressor_side: AggressorSide = "unknown"


# ── Parser ────────────────────────────────────────────────────────


def parse_timesale_options_row(
    row: dict[str, Any],
    *,
    field_map: dict[str, str] = TIMESALE_OPTIONS_FIELDS,
) -> OptionTrade:
    """Parse one TIMESALE row into an :class:`OptionTrade`.

    Trades are stateless — there is no merge-with-previous mode.
    Each row must carry the four required fields (symbol, price,
    size, trade_time_ms); ``sequence`` is optional.
    """
    symbol_raw = row.get("0") or row.get("key")
    if symbol_raw is None:
        raise ValueError("TIMESALE row missing symbol (field 0 / key)")

    extracted: dict[str, Any] = {}
    for idx, attr in field_map.items():
        if idx == "0":
            continue
        if idx not in row:
            continue
        val = row[idx]
        if val is None:
            continue
        if attr in {"size", "trade_time_ms", "sequence"}:
            extracted[attr] = _coerce_int(val)
        else:
            extracted[attr] = _coerce_float(val)

    for required in ("price", "size", "trade_time_ms"):
        if extracted.get(required) is None:
            raise ValueError(f"TIMESALE row missing required field: {required}")

    return OptionTrade(
        symbol=str(symbol_raw),
        price=extracted["price"],
        size=extracted["size"],
        trade_time_ms=extracted["trade_time_ms"],
        sequence=extracted.get("sequence"),
    )


def parse_timesale_futures_options_row(row: dict[str, Any]) -> OptionTrade:
    """Same as :func:`parse_timesale_options_row` but for the
    futures-options TIMESALE stream's field map."""
    return parse_timesale_options_row(row, field_map=TIMESALE_FUTURES_OPTIONS_FIELDS)


# ── Lee-Ready side classifier ────────────────────────────────────


def classify_aggressor(
    trade_price: float,
    *,
    bid: float | None,
    ask: float | None,
    prev_trade_price: float | None = None,
) -> AggressorSide:
    """Lee-Ready aggressor-side classification.

    The Lee-Ready (1991) algorithm:

    * If ``trade_price >= ask`` → buyer-initiated.
    * If ``trade_price <= bid`` → seller-initiated.
    * Otherwise (inside the spread, "at midpoint"): use the tick rule
      against ``prev_trade_price`` — uptick → buyer, downtick →
      seller, zero-tick → ``"unknown"``.

    Returns ``"unknown"`` when NBBO is missing entirely (no quote yet)
    and the tick rule has no prior price to compare against.

    Schwab's TIMESALE does not stream an aggressor flag, so this is
    the canonical classifier for any strategy that needs side. Pair
    with a :class:`~quantfoundry_schwab_nt.quotes.QuoteAggregator`
    snapshot to source bid/ask.
    """
    if bid is not None and ask is not None:
        if trade_price >= ask:
            return "buyer"
        if trade_price <= bid:
            return "seller"
    if prev_trade_price is not None:
        if trade_price > prev_trade_price:
            return "buyer"
        if trade_price < prev_trade_price:
            return "seller"
    return "unknown"


# ── Helpers ───────────────────────────────────────────────────────


def _coerce_float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _coerce_int(v: Any) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


__all__ = [
    "TIMESALE_FUTURES_OPTIONS_FIELDS",
    "TIMESALE_FUTURES_OPTIONS_FIELDS_PARAM",
    "TIMESALE_OPTIONS_FIELDS",
    "TIMESALE_OPTIONS_FIELDS_PARAM",
    "AggressorSide",
    "OptionTrade",
    "classify_aggressor",
    "parse_timesale_futures_options_row",
    "parse_timesale_options_row",
]
