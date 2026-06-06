"""Wire format for the QF↔Python MD-bridge NATS contract (M13-03).

Mirrors the TypeScript shapes in ``src/types/market-data.ts`` so the same
field names round-trip across runtimes. Same pattern as
``quantfoundry_schwab_nt.wire`` mirrors ``src/types/order.ts`` for the order
side.

Schemas correspond to ``docs/tdd/market-data-via-nt.md §3.2``. Plain frozen
dataclasses with explicit ``to_dict`` / ``from_dict`` — no pydantic dep. JSON
parity is tested in ``tests/test_wire_parity.py`` using shared fixtures that
the TS side parses too (added in M13-04).

Field-naming rule: the JSON wire format uses the **TS field names verbatim**,
which are mostly camelCase in market-data.ts (e.g. ``openInterest``,
``underlyingPrice``). Python attribute names match TS exactly so
``from_dict(d)`` / ``to_dict()`` are pure data plumbing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

# ── Data payload types — mirror src/types/market-data.ts ─────────────


@dataclass(frozen=True)
class DataMeta:
    """Mirror of TS ``DataMeta`` (market-data.ts:72)."""

    source: str
    source_timestamp: str | None
    fetched_at: str
    freshness_ms: float | None
    latency_ms: float
    from_cache: bool
    cache_age_ms: float
    sources_tried: tuple[str, ...]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DataMeta:
        return cls(
            source=str(d["source"]),
            source_timestamp=(
                str(d["source_timestamp"])
                if d.get("source_timestamp") is not None
                else None
            ),
            fetched_at=str(d["fetched_at"]),
            freshness_ms=(
                float(d["freshness_ms"]) if d.get("freshness_ms") is not None else None
            ),
            latency_ms=float(d["latency_ms"]),
            from_cache=bool(d["from_cache"]),
            cache_age_ms=float(d["cache_age_ms"]),
            sources_tried=tuple(str(s) for s in d["sources_tried"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "source_timestamp": self.source_timestamp,
            "fetched_at": self.fetched_at,
            "freshness_ms": self.freshness_ms,
            "latency_ms": self.latency_ms,
            "from_cache": self.from_cache,
            "cache_age_ms": self.cache_age_ms,
            "sources_tried": list(self.sources_tried),
        }


@dataclass(frozen=True)
class Quote:
    """Mirror of TS ``Quote`` (market-data.ts:4)."""

    symbol: str
    bid: float
    ask: float
    mid: float
    last: float
    volume: float
    timestamp: str
    meta: DataMeta  # TS field name is "_meta"

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Quote:
        return cls(
            symbol=str(d["symbol"]),
            bid=float(d["bid"]),
            ask=float(d["ask"]),
            mid=float(d["mid"]),
            last=float(d["last"]),
            volume=float(d["volume"]),
            timestamp=str(d["timestamp"]),
            meta=DataMeta.from_dict(d["_meta"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "bid": self.bid,
            "ask": self.ask,
            "mid": self.mid,
            "last": self.last,
            "volume": self.volume,
            "timestamp": self.timestamp,
            "_meta": self.meta.to_dict(),
        }


ContractSide = Literal["call", "put"]


@dataclass(frozen=True)
class Contract:
    """Mirror of TS ``Contract`` (market-data.ts:15) — option contract."""

    symbol: str
    underlying: str
    expiration: str
    side: ContractSide
    strike: float
    dte: int
    bid: float
    ask: float
    mid: float
    last: float
    volume: float
    openInterest: float  # noqa: N815 (TS field name)
    underlyingPrice: float  # noqa: N815
    iv: float
    delta: float
    gamma: float
    theta: float
    vega: float
    tickSize: float | None = None  # noqa: N815

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Contract:
        side_val = str(d["side"])
        if side_val not in ("call", "put"):
            raise ValueError(f"Contract.side must be 'call' or 'put', got {side_val!r}")
        return cls(
            symbol=str(d["symbol"]),
            underlying=str(d["underlying"]),
            expiration=str(d["expiration"]),
            side=side_val,  # type: ignore[arg-type]
            strike=float(d["strike"]),
            dte=int(d["dte"]),
            bid=float(d["bid"]),
            ask=float(d["ask"]),
            mid=float(d["mid"]),
            last=float(d["last"]),
            volume=float(d["volume"]),
            openInterest=float(d["openInterest"]),
            underlyingPrice=float(d["underlyingPrice"]),
            iv=float(d["iv"]),
            delta=float(d["delta"]),
            gamma=float(d["gamma"]),
            theta=float(d["theta"]),
            vega=float(d["vega"]),
            tickSize=(float(d["tickSize"]) if d.get("tickSize") is not None else None),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "symbol": self.symbol,
            "underlying": self.underlying,
            "expiration": self.expiration,
            "side": self.side,
            "strike": self.strike,
            "dte": self.dte,
            "bid": self.bid,
            "ask": self.ask,
            "mid": self.mid,
            "last": self.last,
            "volume": self.volume,
            "openInterest": self.openInterest,
            "underlyingPrice": self.underlyingPrice,
            "iv": self.iv,
            "delta": self.delta,
            "gamma": self.gamma,
            "theta": self.theta,
            "vega": self.vega,
        }
        if self.tickSize is not None:
            out["tickSize"] = self.tickSize
        return out


@dataclass(frozen=True)
class TradePrint:
    """Mirror of TS ``TradePrint`` (market-data.ts:40)."""

    ts: str
    price: float
    size: float
    side: Literal["buy", "sell"] | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TradePrint:
        side_val: Literal["buy", "sell"] | None = None
        if d.get("side") is not None:
            s = str(d["side"])
            if s not in ("buy", "sell"):
                raise ValueError(
                    f"TradePrint.side must be 'buy'|'sell'|None, got {s!r}"
                )
            side_val = s  # type: ignore[assignment]
        return cls(
            ts=str(d["ts"]),
            price=float(d["price"]),
            size=float(d["size"]),
            side=side_val,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "ts": self.ts,
            "price": self.price,
            "size": self.size,
        }
        if self.side is not None:
            out["side"] = self.side
        return out


@dataclass(frozen=True)
class L2Level:
    """Mirror of TS ``L2Level`` (market-data.ts:51)."""

    price: float
    size: float
    num_orders: int | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> L2Level:
        return cls(
            price=float(d["price"]),
            size=float(d["size"]),
            num_orders=(
                int(d["num_orders"]) if d.get("num_orders") is not None else None
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"price": self.price, "size": self.size}
        if self.num_orders is not None:
            out["num_orders"] = self.num_orders
        return out


@dataclass(frozen=True)
class L2Book:
    """Mirror of TS ``L2Book`` (market-data.ts:57)."""

    ts: str
    bids: tuple[L2Level, ...]
    asks: tuple[L2Level, ...]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> L2Book:
        return cls(
            ts=str(d["ts"]),
            bids=tuple(L2Level.from_dict(b) for b in d["bids"]),
            asks=tuple(L2Level.from_dict(a) for a in d["asks"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "ts": self.ts,
            "bids": [b.to_dict() for b in self.bids],
            "asks": [a.to_dict() for a in self.asks],
        }


@dataclass(frozen=True)
class Candle:
    """Mirror of TS ``Candle`` (market-data.ts:63)."""

    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Candle:
        return cls(
            date=str(d["date"]),
            open=float(d["open"]),
            high=float(d["high"]),
            low=float(d["low"]),
            close=float(d["close"]),
            volume=float(d["volume"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }


# ── RPC envelopes — per-method request/reply shapes ─────────────────────
#
# Error frames carry a code from a small enum. Per TDD §3.4: `not_supported`,
# `upstream_unavailable`, `auth_failed`, `rate_limited`, `internal`.

ErrorCode = Literal[
    "not_supported",
    "upstream_unavailable",
    "auth_failed",
    "rate_limited",
    "internal",
]


@dataclass(frozen=True)
class ErrorFrame:
    code: ErrorCode
    message: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ErrorFrame:
        code_val = str(d["code"])
        if code_val not in (
            "not_supported",
            "upstream_unavailable",
            "auth_failed",
            "rate_limited",
            "internal",
        ):
            raise ValueError(f"ErrorFrame.code: unknown value {code_val!r}")
        return cls(code=code_val, message=str(d["message"]))  # type: ignore[arg-type]

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class QuoteRequest:
    """Payload of ``marketdata.rpc.quote.<broker>``."""

    symbol: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> QuoteRequest:
        return cls(symbol=str(d["symbol"]))

    def to_dict(self) -> dict[str, Any]:
        return {"symbol": self.symbol}


@dataclass(frozen=True)
class QuoteReply:
    quote: Quote | None = None
    error: ErrorFrame | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> QuoteReply:
        return cls(
            quote=Quote.from_dict(d["quote"]) if d.get("quote") is not None else None,
            error=ErrorFrame.from_dict(d["error"])
            if d.get("error") is not None
            else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.quote is not None:
            out["quote"] = self.quote.to_dict()
        if self.error is not None:
            out["error"] = self.error.to_dict()
        return out


@dataclass(frozen=True)
class ExpirationsRequest:
    """Payload of ``marketdata.rpc.expirations.<broker>``."""

    symbol: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ExpirationsRequest:
        return cls(symbol=str(d["symbol"]))

    def to_dict(self) -> dict[str, Any]:
        return {"symbol": self.symbol}


@dataclass(frozen=True)
class ExpirationsReply:
    expirations: tuple[str, ...] | None = None
    error: ErrorFrame | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ExpirationsReply:
        return cls(
            expirations=(
                tuple(str(e) for e in d["expirations"])
                if d.get("expirations") is not None
                else None
            ),
            error=ErrorFrame.from_dict(d["error"])
            if d.get("error") is not None
            else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.expirations is not None:
            out["expirations"] = list(self.expirations)
        if self.error is not None:
            out["error"] = self.error.to_dict()
        return out


@dataclass(frozen=True)
class ChainRequest:
    """Payload of ``marketdata.rpc.chain.<broker>``."""

    symbol: str
    expiration: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ChainRequest:
        return cls(symbol=str(d["symbol"]), expiration=str(d["expiration"]))

    def to_dict(self) -> dict[str, Any]:
        return {"symbol": self.symbol, "expiration": self.expiration}


@dataclass(frozen=True)
class ChainReply:
    chain: tuple[Contract, ...] | None = None
    error: ErrorFrame | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ChainReply:
        return cls(
            chain=(
                tuple(Contract.from_dict(c) for c in d["chain"])
                if d.get("chain") is not None
                else None
            ),
            error=ErrorFrame.from_dict(d["error"])
            if d.get("error") is not None
            else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.chain is not None:
            out["chain"] = [c.to_dict() for c in self.chain]
        if self.error is not None:
            out["error"] = self.error.to_dict()
        return out


@dataclass(frozen=True)
class HistoricalChainRequest:
    """Payload of ``marketdata.rpc.historical_chain.<broker>``."""

    symbol: str
    date: str
    expiration: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> HistoricalChainRequest:
        return cls(
            symbol=str(d["symbol"]),
            date=str(d["date"]),
            expiration=str(d["expiration"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {"symbol": self.symbol, "date": self.date, "expiration": self.expiration}


@dataclass(frozen=True)
class HistoricalChainReply:
    chain: tuple[Contract, ...] | None = None
    error: ErrorFrame | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> HistoricalChainReply:
        return cls(
            chain=(
                tuple(Contract.from_dict(c) for c in d["chain"])
                if d.get("chain") is not None
                else None
            ),
            error=ErrorFrame.from_dict(d["error"])
            if d.get("error") is not None
            else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.chain is not None:
            out["chain"] = [c.to_dict() for c in self.chain]
        if self.error is not None:
            out["error"] = self.error.to_dict()
        return out


CandleFrequency = Literal["daily", "minute"]


@dataclass(frozen=True)
class CandlesRequest:
    """Payload of ``marketdata.rpc.candles.<broker>``."""

    symbol: str
    fromDate: str  # noqa: N815 — TS field name is `from`, which is a Python keyword
    toDate: str  # noqa: N815 — TS field name is `to`
    frequency: CandleFrequency | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CandlesRequest:
        freq_val: CandleFrequency | None = None
        if d.get("frequency") is not None:
            f = str(d["frequency"])
            if f not in ("daily", "minute"):
                raise ValueError(f"frequency must be 'daily'|'minute'|None, got {f!r}")
            freq_val = f  # type: ignore[assignment]
        return cls(
            symbol=str(d["symbol"]),
            fromDate=str(d["from"]),
            toDate=str(d["to"]),
            frequency=freq_val,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "symbol": self.symbol,
            "from": self.fromDate,
            "to": self.toDate,
        }
        if self.frequency is not None:
            out["frequency"] = self.frequency
        return out


@dataclass(frozen=True)
class CandlesReply:
    candles: tuple[Candle, ...] | None = None
    error: ErrorFrame | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CandlesReply:
        return cls(
            candles=(
                tuple(Candle.from_dict(c) for c in d["candles"])
                if d.get("candles") is not None
                else None
            ),
            error=ErrorFrame.from_dict(d["error"])
            if d.get("error") is not None
            else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.candles is not None:
            out["candles"] = [c.to_dict() for c in self.candles]
        if self.error is not None:
            out["error"] = self.error.to_dict()
        return out


# ── Heartbeat ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Heartbeat:
    """Payload of ``marketdata.<broker>.heartbeat``.

    Published every 10s. `last_upstream_success_ts` is the last successful
    vendor interaction; TS adapter marks itself unhealthy if the heartbeat
    arrival itself stalls > 30s (per TDD §3.1).
    """

    broker: str
    ts: str
    last_upstream_success_ts: str | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Heartbeat:
        return cls(
            broker=str(d["broker"]),
            ts=str(d["ts"]),
            last_upstream_success_ts=(
                str(d["last_upstream_success_ts"])
                if d.get("last_upstream_success_ts") is not None
                else None
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"broker": self.broker, "ts": self.ts}
        if self.last_upstream_success_ts is not None:
            out["last_upstream_success_ts"] = self.last_upstream_success_ts
        return out
