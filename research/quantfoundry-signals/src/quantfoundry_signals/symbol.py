"""Canonical symbol parser/formatter — mirrors ``server/signals/symbol.ts``.

A symbol is a canonical, colon-separated string. All signal-side symbol
handling goes through :func:`parse_symbol` and :func:`format_symbol`;
ad-hoc string munging on incoming/outgoing symbol fields is a bug.

Grammar (from ``docs/tdd/signal-ingress.md §2.1.1``):

* ``EQ:<ticker>`` — e.g. ``EQ:SPY``
* ``OPT:<root>:<expiry>:<right>:<strike>`` — e.g. ``OPT:SPY:2026-01-16:C:500``
* ``FUT:<root>:<contract>`` — e.g. ``FUT:ES:2026-06``
* ``FOP:<root>:<contract>:<expiry>:<right>:<strike>``
  — e.g. ``FOP:ES:2026-06:2026-05-23:C:5000``
* ``V:<label>`` — virtual (non-tradeable), e.g. ``V:regime-spx-vol``

Roots/tickers/contracts: ``[A-Z0-9_-]+`` (uppercase). Dates: ``YYYY-MM-DD``.
Contract months for FUT/FOP accept ``YYYY-MM`` or the same date form. Rights:
``C``/``P``. Strikes: positive finite numbers, no trailing zeros. Virtual
labels are case-insensitive at parse time (per the TS implementation).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

# ── Constants ──────────────────────────────────────────────────────

VALID_CLASSES = frozenset({"EQ", "OPT", "FUT", "FOP", "V"})
_TOKEN_RE = re.compile(r"^[A-Z0-9_-]+$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
_RIGHT_RE = re.compile(r"^[CP]$")
_V_LABEL_RE = re.compile(r"^[A-Za-z0-9_-]+$")

SymbolClass = Literal["EQ", "OPT", "FUT", "FOP", "V"]
Right = Literal["C", "P"]


# ── Parsed-symbol records ──────────────────────────────────────────


@dataclass(frozen=True)
class EqSymbol:
    ticker: str
    cls: Literal["EQ"] = "EQ"


@dataclass(frozen=True)
class OptSymbol:
    root: str
    expiry: str
    right: Right
    strike: float
    cls: Literal["OPT"] = "OPT"


@dataclass(frozen=True)
class FutSymbol:
    root: str
    contract: str
    cls: Literal["FUT"] = "FUT"


@dataclass(frozen=True)
class FopSymbol:
    root: str
    contract: str
    expiry: str
    right: Right
    strike: float
    cls: Literal["FOP"] = "FOP"


@dataclass(frozen=True)
class VSymbol:
    label: str
    cls: Literal["V"] = "V"


ParsedSymbol = EqSymbol | OptSymbol | FutSymbol | FopSymbol | VSymbol


# ── Parse ──────────────────────────────────────────────────────────


def parse_symbol(s: str) -> ParsedSymbol:
    """Parse a canonical symbol string into its typed record.

    Raises :class:`ValueError` on any malformed input — same error
    surface as the TS implementation, with messages chosen to be
    diff-friendly so cross-language regressions are easy to spot.
    """
    if not isinstance(s, str) or not s:
        raise ValueError("Symbol must be a non-empty string")

    parts = s.split(":")
    cls = parts[0]
    if cls not in VALID_CLASSES:
        raise ValueError(f"Unknown symbol class: {cls}")

    if cls == "EQ":
        if len(parts) != 2:
            raise ValueError(f"EQ symbol must have 2 parts, got {len(parts)}: {s}")
        ticker = parts[1]
        if not _TOKEN_RE.match(ticker):
            raise ValueError(f"Invalid ticker: {ticker}")
        return EqSymbol(ticker=ticker)

    if cls == "OPT":
        if len(parts) != 5:
            raise ValueError(f"OPT symbol must have 5 parts, got {len(parts)}: {s}")
        _, root, expiry, right, strike_str = parts
        if not _TOKEN_RE.match(root):
            raise ValueError(f"Invalid root: {root}")
        if not _DATE_RE.match(expiry):
            raise ValueError(f"Invalid expiry date: {expiry}")
        if not _RIGHT_RE.match(right):
            raise ValueError(f"Invalid right: {right}")
        strike = _parse_strike(strike_str)
        return OptSymbol(root=root, expiry=expiry, right=right, strike=strike)  # type: ignore[arg-type]

    if cls == "FUT":
        if len(parts) != 3:
            raise ValueError(f"FUT symbol must have 3 parts, got {len(parts)}: {s}")
        _, root, contract = parts
        if not _TOKEN_RE.match(root):
            raise ValueError(f"Invalid root: {root}")
        if (
            not _TOKEN_RE.match(contract)
            and not _DATE_RE.match(contract)
            and not _MONTH_RE.match(contract)
        ):
            raise ValueError(f"Invalid contract: {contract}")
        return FutSymbol(root=root, contract=contract)

    if cls == "FOP":
        if len(parts) != 6:
            raise ValueError(f"FOP symbol must have 6 parts, got {len(parts)}: {s}")
        _, root, contract, expiry, right, strike_str = parts
        if not _TOKEN_RE.match(root):
            raise ValueError(f"Invalid root: {root}")
        if not _DATE_RE.match(expiry):
            raise ValueError(f"Invalid expiry date: {expiry}")
        if not _RIGHT_RE.match(right):
            raise ValueError(f"Invalid right: {right}")
        strike = _parse_strike(strike_str)
        return FopSymbol(
            root=root,
            contract=contract,
            expiry=expiry,
            right=right,  # type: ignore[arg-type]
            strike=strike,
        )

    # cls == "V"
    if len(parts) != 2:
        raise ValueError(f"V symbol must have 2 parts, got {len(parts)}: {s}")
    label = parts[1]
    if not _V_LABEL_RE.match(label):
        raise ValueError(f"Invalid virtual label: {label}")
    return VSymbol(label=label)


def _parse_strike(s: str) -> float:
    try:
        v = float(s)
    except ValueError as exc:
        raise ValueError(f"Invalid strike: {s}") from exc
    if v <= 0 or v != v or v == float("inf") or v == float("-inf"):
        raise ValueError(f"Invalid strike: {s}")
    return v


# ── Format ─────────────────────────────────────────────────────────


def format_symbol(sym: ParsedSymbol) -> str:
    """Render a :class:`ParsedSymbol` back to its canonical string."""
    if isinstance(sym, EqSymbol):
        return f"EQ:{sym.ticker}"
    if isinstance(sym, OptSymbol):
        return f"OPT:{sym.root}:{sym.expiry}:{sym.right}:{_format_strike(sym.strike)}"
    if isinstance(sym, FutSymbol):
        return f"FUT:{sym.root}:{sym.contract}"
    if isinstance(sym, FopSymbol):
        return (
            f"FOP:{sym.root}:{sym.contract}:{sym.expiry}:"
            f"{sym.right}:{_format_strike(sym.strike)}"
        )
    # VSymbol — exhaustive over the union, but mypy doesn't narrow.
    return f"V:{sym.label}"


def _format_strike(strike: float) -> str:
    """Format a strike with no trailing zeros (500 stays "500", 4787.5 stays
    "4787.5"). Mirrors the TS ``String(strike)`` behaviour for finite floats."""
    if strike == int(strike):
        return str(int(strike))
    return str(strike)


__all__ = [
    "VALID_CLASSES",
    "EqSymbol",
    "FopSymbol",
    "FutSymbol",
    "OptSymbol",
    "ParsedSymbol",
    "Right",
    "SymbolClass",
    "VSymbol",
    "format_symbol",
    "parse_symbol",
]
