"""Schwab `LEVELONE_OPTIONS` + `LEVELONE_FUTURES_OPTIONS` → quote ticks.

Pure parsing layer on top of QF-162's streamer. Translates Schwab's
indexed-field LEVELONE rows into typed :class:`OptionQuote` snapshots,
and aggregates per-symbol partial updates so the consumer can read a
complete quote (bid/ask/sizes/...) without tracking state itself.

Schwab's streamer LEVELONE delivery contract:

1. After SUBS, Schwab pushes a **full snapshot** for each subscribed
   symbol (all subscribed fields present).
2. Subsequent frames are **delta updates** — only changed fields are
   present. The ``key`` field (Schwab field 0) is always there so we
   can route to the right per-symbol slot.

The aggregator merges deltas into the per-symbol state; the consumer
calls :meth:`QuoteAggregator.ingest_row` for every row delivered into
its QF-162 ``Subscription`` queue and gets back the updated
:class:`OptionQuote`.

**Greeks / IV policy.** Schwab exposes Greeks + IV in this feed
(fields 10, 28–32). Per the QF-159 + QF-160 spike findings, QF
**recomputes** these via ``qf-quant`` rather than consuming the
broker-supplied values — they're surfaced here as carry-along
fields for diagnostics + cross-check, NOT for use in the risk
engine. See ``docs/research/qf-160-schwab-nt-spike.md §Spot-check 1``.

Reference: QF-164. Future tickets QF-165 (TIMESALE) and QF-166
(OPTIONS_BOOK) mirror this pattern with different field maps.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

# ── Field maps ────────────────────────────────────────────────────
#
# Schwab indexes streamer fields by string-stringified integers in the
# JSON content. Each map below is `{schwab_field_index: attr_name}`;
# `attr_name` is the OptionQuote field we write into.
#
# Sources: Schwab Developer Portal, Trader API → Streaming → LEVELONE
# message specs. Indices are stable across the underlying-symbol
# variants (equity vs futures options) for the fields QF cares about,
# but ENCODING differs (e.g. expiration month is "Jan" vs "F"). We
# only extract the indexed-numeric subset; per-asset string conversion
# happens at the strategy layer.

# LEVELONE_OPTIONS (equity-options streamer).
LEVELONE_OPTIONS_FIELDS: dict[str, str] = {
    "0": "symbol",  # key
    "2": "bid_price",
    "3": "ask_price",
    "4": "last_price",
    "8": "volume",
    "9": "open_interest",
    "10": "implied_volatility",
    "16": "bid_size",
    "17": "ask_size",
    "18": "last_size",
    "20": "strike_price",
    "21": "contract_type",  # "P" / "C"
    "22": "underlying_symbol",
    "27": "days_to_expiration",
    "28": "delta",
    "29": "gamma",
    "30": "theta",
    "31": "vega",
    "32": "rho",
    "35": "underlying_price",
    "37": "mark",
    "38": "quote_time_ms",
    "39": "trade_time_ms",
}

# LEVELONE_FUTURES_OPTIONS (futures-options streamer).
# Field indices align with LEVELONE_OPTIONS for the QF-relevant subset;
# Schwab uses the same numeric layout for bid/ask/sizes/Greeks/timestamps.
# Strike + underlying differ semantically but are surfaced the same way.
LEVELONE_FUTURES_OPTIONS_FIELDS: dict[str, str] = dict(LEVELONE_OPTIONS_FIELDS)

# Comma-separated field index strings to pass as the SUBS `fields`
# parameter. Trimming to "just what we use" keeps Schwab's
# bandwidth-budget happy without sacrificing anything QF reads.
LEVELONE_OPTIONS_FIELDS_PARAM: str = ",".join(sorted(LEVELONE_OPTIONS_FIELDS, key=int))
LEVELONE_FUTURES_OPTIONS_FIELDS_PARAM: str = ",".join(
    sorted(LEVELONE_FUTURES_OPTIONS_FIELDS, key=int)
)


# ── Quote snapshot ────────────────────────────────────────────────


@dataclass
class OptionQuote:
    """One snapshot of an option's market state.

    All fields except ``symbol`` are ``None``-able — Schwab's delta
    updates only carry the fields that changed. Use :meth:`is_quote_ready`
    to ask "do we have enough state to emit an NT QuoteTick?"
    """

    symbol: str
    bid_price: float | None = None
    ask_price: float | None = None
    bid_size: int | None = None
    ask_size: int | None = None
    last_price: float | None = None
    last_size: int | None = None
    volume: int | None = None
    open_interest: int | None = None
    mark: float | None = None
    quote_time_ms: int | None = None
    trade_time_ms: int | None = None
    # Strike / underlying / contract metadata stays sticky across
    # deltas — Schwab sends these in the initial snapshot only.
    strike_price: float | None = None
    contract_type: str | None = None  # "P" / "C"
    underlying_symbol: str | None = None
    underlying_price: float | None = None
    days_to_expiration: int | None = None
    # Broker-supplied Greeks + IV. Diagnostic only — QF recomputes via
    # qf-quant. See QF-160 spike Spot-check 1.
    implied_volatility: float | None = None
    delta: float | None = None
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    rho: float | None = None

    def is_quote_ready(self) -> bool:
        """True when bid + ask + their sizes are all known."""
        return (
            self.bid_price is not None
            and self.ask_price is not None
            and self.bid_size is not None
            and self.ask_size is not None
        )


# Fields whose values must be parsed as int (Schwab sends them as
# numbers, but their NT counterparts are integer-typed).
_INT_FIELD_NAMES = frozenset(
    {
        "bid_size",
        "ask_size",
        "last_size",
        "volume",
        "open_interest",
        "days_to_expiration",
        "quote_time_ms",
        "trade_time_ms",
    }
)


# ── Parser ────────────────────────────────────────────────────────


def parse_levelone_options_row(
    row: dict[str, Any],
    *,
    base: OptionQuote | None = None,
    field_map: dict[str, str] = LEVELONE_OPTIONS_FIELDS,
) -> OptionQuote:
    """Parse one LEVELONE row into an :class:`OptionQuote`.

    If ``base`` is supplied (the prior state for this symbol), fields
    absent from ``row`` keep their previous value. Otherwise the
    return is a fresh snapshot with `None` for everything Schwab didn't
    send.

    Use this from a streamer consumer that wants to be stateless about
    aggregation — typically tests. Production consumers use
    :class:`QuoteAggregator` which keeps the per-symbol state.
    """
    symbol_raw = row.get("0") or row.get("key") or (base.symbol if base else None)
    if symbol_raw is None:
        raise ValueError("LEVELONE row missing symbol (field 0 / key)")

    updates: dict[str, Any] = {"symbol": str(symbol_raw)}
    for idx, attr in field_map.items():
        if idx == "0":
            continue  # already captured
        if idx not in row:
            continue
        val = row[idx]
        if val is None:
            continue
        if attr in _INT_FIELD_NAMES:
            updates[attr] = _coerce_int(val)
        elif attr in {"contract_type", "underlying_symbol"}:
            updates[attr] = str(val)
        else:
            updates[attr] = _coerce_float(val)

    if base is None:
        # Construct a fresh snapshot — None for unset fields.
        return OptionQuote(**updates)
    return replace(base, **updates)


def parse_levelone_futures_options_row(
    row: dict[str, Any],
    *,
    base: OptionQuote | None = None,
) -> OptionQuote:
    """Same as :func:`parse_levelone_options_row` but for the
    futures-options stream's field map."""
    return parse_levelone_options_row(
        row, base=base, field_map=LEVELONE_FUTURES_OPTIONS_FIELDS
    )


# ── Aggregator ────────────────────────────────────────────────────


class QuoteAggregator:
    """Per-symbol stateful merger for LEVELONE delta updates.

    Typical use in a streamer-consumer loop::

        agg = QuoteAggregator()
        sub = await streamer.subscribe(
            service="LEVELONE_OPTIONS",
            keys=symbols,
            fields=LEVELONE_OPTIONS_FIELDS_PARAM,
        )
        async for row in iter_queue(sub.queue):
            quote = agg.ingest(row, service="LEVELONE_OPTIONS")
            if quote.is_quote_ready():
                publish_quote_tick(quote)

    The aggregator picks the right field map by service name; pass it
    on every call so multi-service consumers (a strategy on both
    equity options + futures options) share one aggregator.
    """

    def __init__(self) -> None:
        self._state: dict[str, OptionQuote] = {}

    def ingest(self, row: dict[str, Any], *, service: str) -> OptionQuote:
        """Merge ``row`` into per-symbol state; return the latest snapshot."""
        field_map = _field_map_for_service(service)
        symbol = str(
            row.get("0") or row.get("key") or (_first_state_symbol(self._state) or "")
        )
        if not symbol:
            raise ValueError("LEVELONE row has no resolvable symbol")
        base = self._state.get(symbol)
        merged = parse_levelone_options_row(row, base=base, field_map=field_map)
        self._state[symbol] = merged
        return merged

    def snapshot(self, symbol: str) -> OptionQuote | None:
        """Read the current state for ``symbol`` without ingesting."""
        return self._state.get(symbol)

    def clear(self, symbol: str | None = None) -> None:
        """Drop state for one symbol (e.g. on UNSUBS) or all."""
        if symbol is None:
            self._state.clear()
        else:
            self._state.pop(symbol, None)


# ── Helpers ───────────────────────────────────────────────────────


def _field_map_for_service(service: str) -> dict[str, str]:
    if service == "LEVELONE_OPTIONS":
        return LEVELONE_OPTIONS_FIELDS
    if service == "LEVELONE_FUTURES_OPTIONS":
        return LEVELONE_FUTURES_OPTIONS_FIELDS
    raise ValueError(f"unsupported LEVELONE service: {service}")


def _coerce_float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _coerce_int(v: Any) -> int | None:
    try:
        # `int(float(v))` rather than `int(v)` to tolerate `"5.0"` and
        # the like — Schwab streams numeric fields as primitives, but
        # not always as the canonical type.
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _first_state_symbol(state: dict[str, OptionQuote]) -> str | None:
    """Fallback when a delta arrives with no symbol field and we know
    there's exactly one entry in state — Schwab observed never doing
    this in practice, but be tolerant of an under-spec'd update."""
    if len(state) == 1:
        return next(iter(state))
    return None


__all__ = [
    "LEVELONE_FUTURES_OPTIONS_FIELDS",
    "LEVELONE_FUTURES_OPTIONS_FIELDS_PARAM",
    "LEVELONE_OPTIONS_FIELDS",
    "LEVELONE_OPTIONS_FIELDS_PARAM",
    "OptionQuote",
    "QuoteAggregator",
    "parse_levelone_futures_options_row",
    "parse_levelone_options_row",
]
