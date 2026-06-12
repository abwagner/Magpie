"""Schwab ``OPTIONS_BOOK`` → L2 depth snapshots + derived deltas.

Pure parsing + diffing layer on top of QF-162's streamer. Translates
Schwab's per-frame full-book messages into typed
:class:`OptionBookSnapshot` records, and provides a per-symbol
aggregator that can compute incremental :class:`OptionBookDelta`
events between consecutive snapshots.

Schwab's OPTIONS_BOOK delivery contract:

* Every frame carries the **full** bid + ask ladder for the symbol
  (not incremental L2 deltas — Schwab does not stream per-level
  add/update/delete events). The book_time_ms moves forward with
  each frame.
* Bids and asks are sent as JSON arrays of price-level entries; each
  entry has a price, an aggregate volume, a market-maker count, and
  an inner list of per-market-maker quotes.

For the QF-relevant subset, we keep price + aggregate volume per
level (and the MM count for diagnostics). The per-market-maker inner
detail is intentionally dropped — strategies that act on price/size
don't need it, and recording it bloats memory for wide universes.

**Snapshots vs deltas.** NT consumers can choose either shape:

* ``DataEngine.subscribe_order_book_snapshots`` — publish each
  parsed :class:`OptionBookSnapshot` directly.
* ``DataEngine.subscribe_order_book_deltas`` — use
  :meth:`OptionBookAggregator.ingest` to get the new snapshot plus
  the list of deltas vs the prior snapshot. Each delta is an
  add/update/delete at a single (side, price) coordinate.

Reference: QF-166. Siblings: QF-164 (LEVELONE quotes), QF-165
(TIMESALE trades).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# ── Field maps ────────────────────────────────────────────────────
#
# Schwab indexes top-level streamer fields by stringified integers.
# OPTIONS_BOOK has a tiny outer-field set (symbol, book_time, bids,
# asks) — the structural detail is inside the bid/ask arrays.
#
# Source: Schwab Developer Portal, Trader API → Streaming →
# OPTIONS_BOOK message spec.

OPTIONS_BOOK_FIELDS: dict[str, str] = {
    "0": "symbol",
    "1": "book_time_ms",
    "2": "bids",
    "3": "asks",
}

OPTIONS_BOOK_FIELDS_PARAM: str = ",".join(sorted(OPTIONS_BOOK_FIELDS, key=int))


# ── Book records ──────────────────────────────────────────────────


BookSide = Literal["bid", "ask"]
DeltaAction = Literal["add", "update", "delete"]


@dataclass(frozen=True, order=True)
class OptionBookLevel:
    """One price level in the book.

    ``num_market_makers`` is informational; consumers acting on
    price/size can ignore it. Schwab's per-MM inner detail is
    dropped at parse time.
    """

    price: float
    size: int
    num_market_makers: int = 0


@dataclass(frozen=True)
class OptionBookSnapshot:
    """Full L2 book for one option at one instant.

    Bids are sorted descending by price (best bid first); asks
    sorted ascending (best ask first). Both sides may be empty if
    the venue has no quotes at the time of the frame.
    """

    symbol: str
    book_time_ms: int
    bids: tuple[OptionBookLevel, ...] = ()
    asks: tuple[OptionBookLevel, ...] = ()

    def best_bid(self) -> OptionBookLevel | None:
        return self.bids[0] if self.bids else None

    def best_ask(self) -> OptionBookLevel | None:
        return self.asks[0] if self.asks else None


@dataclass(frozen=True)
class OptionBookDelta:
    """One incremental change to the book at (side, price).

    * ``add`` — a price level that did not exist in the previous
      snapshot.
    * ``update`` — a level that existed and changed size or
      market-maker count.
    * ``delete`` — a level that existed and no longer does.
      ``new_size`` is 0 for deletes.
    """

    symbol: str
    book_time_ms: int
    side: BookSide
    action: DeltaAction
    price: float
    new_size: int
    num_market_makers: int = 0


# ── Parser ────────────────────────────────────────────────────────


def parse_options_book_row(row: dict[str, Any]) -> OptionBookSnapshot:
    """Parse one OPTIONS_BOOK row into an :class:`OptionBookSnapshot`.

    The returned snapshot's bids/asks are sorted in market-conventional
    order (best-first). Rows that omit a side are treated as empty for
    that side; rows missing ``book_time_ms`` raise.
    """
    symbol_raw = row.get("0") or row.get("key")
    if symbol_raw is None:
        raise ValueError("OPTIONS_BOOK row missing symbol (field 0 / key)")

    book_time_raw = row.get("1")
    if book_time_raw is None:
        raise ValueError("OPTIONS_BOOK row missing book_time_ms (field 1)")
    book_time = _coerce_int(book_time_raw)
    if book_time is None:
        raise ValueError("OPTIONS_BOOK row has non-numeric book_time_ms")

    bids = _parse_levels(row.get("2") or [])
    asks = _parse_levels(row.get("3") or [])

    return OptionBookSnapshot(
        symbol=str(symbol_raw),
        book_time_ms=book_time,
        bids=tuple(sorted(bids, key=lambda lvl: lvl.price, reverse=True)),
        asks=tuple(sorted(asks, key=lambda lvl: lvl.price)),
    )


def _parse_levels(entries: Any) -> list[OptionBookLevel]:
    """Parse a Schwab bid/ask array into typed levels.

    Each entry is either a dict with stringified-int field indices
    (``"0"`` = price, ``"1"`` = volume, ``"2"`` = num MMs) or already
    a typed object — both are tolerated. Malformed entries (no
    price, no size) are dropped silently rather than raising; this
    keeps the parser robust to Schwab's occasional partial-frame
    edge cases.
    """
    if not isinstance(entries, list):
        return []
    out: list[OptionBookLevel] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        price = _coerce_float(entry.get("0") or entry.get("price"))
        size = _coerce_int(entry.get("1") or entry.get("size") or entry.get("volume"))
        if price is None or size is None:
            continue
        num_mms = _coerce_int(entry.get("2") or entry.get("num_market_makers")) or 0
        out.append(OptionBookLevel(price=price, size=size, num_market_makers=num_mms))
    return out


# ── Diff ─────────────────────────────────────────────────────────


def diff_books(
    prev: OptionBookSnapshot | None,
    curr: OptionBookSnapshot,
) -> list[OptionBookDelta]:
    """Compute the set of price-level deltas from ``prev`` to ``curr``.

    If ``prev`` is ``None`` (first snapshot), every level in ``curr``
    is emitted as an ``add``. Otherwise:

    * Levels in ``curr`` not in ``prev`` → ``add``.
    * Levels in both whose ``size`` or ``num_market_makers`` differ
      → ``update``.
    * Levels in ``prev`` not in ``curr`` → ``delete`` (new_size 0).

    Levels are keyed by ``(side, price)``. The returned list is
    deterministic — ordered by side (bids then asks), then by price
    ascending.
    """
    deltas: list[OptionBookDelta] = []
    for side, prev_levels, curr_levels in (
        ("bid", prev.bids if prev else (), curr.bids),
        ("ask", prev.asks if prev else (), curr.asks),
    ):
        prev_by_price = {lvl.price: lvl for lvl in prev_levels}
        curr_by_price = {lvl.price: lvl for lvl in curr_levels}
        all_prices = sorted(set(prev_by_price) | set(curr_by_price))
        for price in all_prices:
            in_prev = prev_by_price.get(price)
            in_curr = curr_by_price.get(price)
            if in_curr is None:
                deltas.append(
                    OptionBookDelta(
                        symbol=curr.symbol,
                        book_time_ms=curr.book_time_ms,
                        side=side,  # type: ignore[arg-type]
                        action="delete",
                        price=price,
                        new_size=0,
                    )
                )
            elif in_prev is None:
                deltas.append(
                    OptionBookDelta(
                        symbol=curr.symbol,
                        book_time_ms=curr.book_time_ms,
                        side=side,  # type: ignore[arg-type]
                        action="add",
                        price=price,
                        new_size=in_curr.size,
                        num_market_makers=in_curr.num_market_makers,
                    )
                )
            elif (
                in_prev.size != in_curr.size
                or in_prev.num_market_makers != in_curr.num_market_makers
            ):
                deltas.append(
                    OptionBookDelta(
                        symbol=curr.symbol,
                        book_time_ms=curr.book_time_ms,
                        side=side,  # type: ignore[arg-type]
                        action="update",
                        price=price,
                        new_size=in_curr.size,
                        num_market_makers=in_curr.num_market_makers,
                    )
                )
    return deltas


# ── Aggregator ───────────────────────────────────────────────────


@dataclass
class BookIngestResult:
    """Pair returned by :meth:`OptionBookAggregator.ingest`.

    Consumers that want NT ``OrderBookSnapshot`` events read
    :attr:`snapshot`; consumers that want NT ``OrderBookDelta`` events
    iterate :attr:`deltas`. ``deltas`` is empty when the snapshot has
    not changed vs the prior frame (e.g. duplicate heartbeat).
    """

    snapshot: OptionBookSnapshot
    deltas: list[OptionBookDelta] = field(default_factory=list)


class OptionBookAggregator:
    """Per-symbol L2 book state.

    Typical use in a streamer-consumer loop::

        agg = OptionBookAggregator()
        sub = await streamer.subscribe(
            service="OPTIONS_BOOK",
            keys=symbols,
            fields=OPTIONS_BOOK_FIELDS_PARAM,
        )
        async for row in iter_queue(sub.queue):
            result = agg.ingest(row)
            for delta in result.deltas:
                publish_order_book_delta(delta)
    """

    def __init__(self) -> None:
        self._state: dict[str, OptionBookSnapshot] = {}

    def ingest(self, row: dict[str, Any]) -> BookIngestResult:
        """Parse ``row`` and update per-symbol state.

        Returns the new snapshot + deltas vs the previous snapshot
        for the same symbol. First-frame returns all current levels
        as ``add`` deltas.
        """
        snap = parse_options_book_row(row)
        prev = self._state.get(snap.symbol)
        deltas = diff_books(prev, snap)
        self._state[snap.symbol] = snap
        return BookIngestResult(snapshot=snap, deltas=deltas)

    def snapshot(self, symbol: str) -> OptionBookSnapshot | None:
        """Read current book state for ``symbol`` without ingesting."""
        return self._state.get(symbol)

    def clear(self, symbol: str | None = None) -> None:
        """Drop state for one symbol (e.g. on UNSUBS) or all."""
        if symbol is None:
            self._state.clear()
        else:
            self._state.pop(symbol, None)


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
    "OPTIONS_BOOK_FIELDS",
    "OPTIONS_BOOK_FIELDS_PARAM",
    "BookIngestResult",
    "BookSide",
    "DeltaAction",
    "OptionBookAggregator",
    "OptionBookDelta",
    "OptionBookLevel",
    "OptionBookSnapshot",
    "diff_books",
    "parse_options_book_row",
]
