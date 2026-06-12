"""Schwab REST market-data client.

Sibling of ``magpie_schwab_nt.exec_client.SchwabRestExecClient`` but for
the read-only market-data endpoints. Shares the auth layer (``SchwabAuthClient``)
so token refreshes serialize across both clients — no double-refresh races.

Endpoints exposed:
- ``get_quote(symbol)`` → wire.Quote
- ``get_expirations(symbol)`` → list[str]
- ``get_chain(symbol, expiration)`` → list[wire.Contract]
- ``get_candles(symbol, from_date, to_date, frequency)`` → list[wire.Candle]

NOT exposed:
- ``historical_chain`` — Schwab REST does not expose a date-keyed historical
  options chain. M13-05 Q4 confirmed this. The bridge maps this verb to a
  ``not_supported`` error frame so the TS service layer falls through to
  MarketData.app per the existing routing.

Schwab market-data base: ``https://api.schwabapi.com/marketdata/v1``.
"""

from __future__ import annotations

from datetime import UTC
from typing import Any

import httpx
from magpie_schwab_nt.auth import SchwabAuthClient

from ..wire import Candle, Contract, DataMeta, Quote

DEFAULT_MD_BASE = "https://api.schwabapi.com/marketdata/v1"

_SOURCE_NAME = "schwab"


# ── Errors ─────────────────────────────────────────────────────────


class SchwabMdError(Exception):
    """Raised on non-success Schwab MD REST responses (4xx / 5xx)."""

    def __init__(self, message: str, *, status_code: int, body: Any) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


# ── Client ─────────────────────────────────────────────────────────


class SchwabRestMdClient:
    """Read-only MD REST client. One instance per process; cheap to construct."""

    def __init__(
        self,
        *,
        auth_client: SchwabAuthClient,
        md_base: str = DEFAULT_MD_BASE,
    ) -> None:
        self._auth = auth_client
        self._base = md_base.rstrip("/")

    # ── Snapshot endpoints ──────────────────────────────────────────

    async def get_quote(self, symbol: str, *, fetched_at: str) -> Quote:
        """GET /marketdata/v1/quotes?symbols=<symbol>&fields=quote.

        Returns a wire.Quote with ``_meta.source = "schwab"``. The
        ``fetched_at`` ISO timestamp is supplied by the caller (the bridge
        records the moment of the inbound NATS request) so caching and
        freshness math are aligned across the stack.
        """
        url = f"{self._base}/quotes"
        resp = await self._auth.get(url, params={"symbols": symbol, "fields": "quote"})
        _raise_for_status("get_quote", resp)
        body = resp.json()
        record = _quote_record_from_body(body, symbol)
        return _parse_quote(symbol, record, fetched_at)

    async def get_expirations(self, symbol: str) -> list[str]:
        """GET /marketdata/v1/expirationchain?symbol=<symbol>."""
        url = f"{self._base}/expirationchain"
        resp = await self._auth.get(url, params={"symbol": symbol})
        _raise_for_status("get_expirations", resp)
        body = resp.json()
        return _parse_expirations(body)

    async def get_chain(
        self,
        symbol: str,
        expiration: str,
        *,
        fetched_at: str,
    ) -> list[Contract]:
        """GET /marketdata/v1/chains scoped to a single expiration.

        Schwab's chain endpoint accepts a from/to date range; we send both as
        the single expiration date to scope to one expiry. Contract type is
        ``ALL`` (calls + puts).
        """
        url = f"{self._base}/chains"
        resp = await self._auth.get(
            url,
            params={
                "symbol": symbol,
                "contractType": "ALL",
                "fromDate": expiration,
                "toDate": expiration,
            },
        )
        _raise_for_status("get_chain", resp)
        body = resp.json()
        underlying_price = _underlying_price(body)
        return _parse_chain(
            body, underlying_price=underlying_price, fetched_at=fetched_at
        )

    async def get_candles(
        self,
        symbol: str,
        from_date: str,
        to_date: str,
        frequency: str | None = None,
    ) -> list[Candle]:
        """GET /marketdata/v1/pricehistory.

        Schwab's price-history endpoint takes epoch-ms inclusive bounds plus
        a frequency type (daily | minute). For v1 we accept ISO dates from the
        QF side and translate to UTC midnight epoch-ms.
        """
        url = f"{self._base}/pricehistory"
        params: dict[str, str] = {
            "symbol": symbol,
            "periodType": _period_type(frequency),
            "frequencyType": frequency or "daily",
            "startDate": _iso_to_epoch_ms(from_date),
            "endDate": _iso_to_epoch_ms(to_date),
        }
        resp = await self._auth.get(url, params=params)
        _raise_for_status("get_candles", resp)
        body = resp.json()
        return _parse_candles(body)


# ── Parsing helpers ────────────────────────────────────────────────


def _raise_for_status(op: str, resp: httpx.Response) -> None:
    if resp.status_code >= 400:
        raise SchwabMdError(
            f"{op} failed: HTTP {resp.status_code}",
            status_code=resp.status_code,
            body=_safe_body(resp),
        )


def _safe_body(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text


def _quote_record_from_body(body: Any, symbol: str) -> dict[str, Any]:
    """Schwab's quote response is keyed by symbol at the top level."""
    if not isinstance(body, dict):
        raise SchwabMdError(
            "get_quote: unexpected response shape",
            status_code=200,
            body=body,
        )
    record = body.get(symbol)
    if not isinstance(record, dict):
        raise SchwabMdError(
            f"get_quote: symbol {symbol!r} missing from response",
            status_code=200,
            body=body,
        )
    return record


def _parse_quote(symbol: str, record: dict[str, Any], fetched_at: str) -> Quote:
    quote_block = _as_dict(record.get("quote"))
    bid = _coerce_float(quote_block.get("bidPrice"))
    ask = _coerce_float(quote_block.get("askPrice"))
    last = _coerce_float(quote_block.get("lastPrice"))
    volume = _coerce_float(quote_block.get("totalVolume") or quote_block.get("volume"))
    timestamp = _coerce_str(quote_block.get("quoteTime")) or fetched_at
    mid = (bid + ask) / 2.0 if (bid is not None and ask is not None) else (last or 0.0)
    return Quote(
        symbol=symbol,
        bid=bid or 0.0,
        ask=ask or 0.0,
        mid=mid,
        last=last or 0.0,
        volume=volume or 0.0,
        timestamp=timestamp,
        meta=DataMeta(
            source=_SOURCE_NAME,
            source_timestamp=timestamp,
            fetched_at=fetched_at,
            freshness_ms=None,
            latency_ms=0.0,
            from_cache=False,
            cache_age_ms=0.0,
            sources_tried=(_SOURCE_NAME,),
        ),
    )


def _parse_expirations(body: Any) -> list[str]:
    if not isinstance(body, dict):
        return []
    raw_list = body.get("expirationList")
    if not isinstance(raw_list, list):
        return []
    out: list[str] = []
    for entry in raw_list:
        if not isinstance(entry, dict):
            continue
        date_str = _coerce_str(entry.get("expirationDate"))
        if date_str:
            out.append(date_str)
    return out


def _underlying_price(body: Any) -> float:
    if not isinstance(body, dict):
        return 0.0
    underlying = body.get("underlying")
    if isinstance(underlying, dict):
        price = _coerce_float(underlying.get("last") or underlying.get("mark"))
        if price is not None:
            return price
    direct = _coerce_float(body.get("underlyingPrice"))
    return direct or 0.0


def _parse_chain(
    body: Any, *, underlying_price: float, fetched_at: str
) -> list[Contract]:
    """Schwab returns callExpDateMap + putExpDateMap, each a dict keyed by
    "<EXP>:<DTE>", each value a dict keyed by strike (string), each value a
    list of contract entries.
    """
    if not isinstance(body, dict):
        return []
    underlying = _coerce_str(body.get("symbol")) or ""
    contracts: list[Contract] = []
    for side_label, map_key in (("call", "callExpDateMap"), ("put", "putExpDateMap")):
        exp_map = body.get(map_key)
        if not isinstance(exp_map, dict):
            continue
        for exp_key, strike_map in exp_map.items():
            if not isinstance(strike_map, dict):
                continue
            expiration_date = _split_exp_key(exp_key)[0]
            dte = _split_exp_key(exp_key)[1]
            for strike_str, entries in strike_map.items():
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    contracts.append(
                        _parse_contract_entry(
                            entry,
                            underlying=underlying,
                            underlying_price=underlying_price,
                            expiration=expiration_date,
                            dte=dte,
                            side=side_label,
                            strike_str=strike_str,
                        )
                    )
    _ = fetched_at  # reserved for future per-contract _meta enrichment
    return contracts


def _parse_contract_entry(
    entry: dict[str, Any],
    *,
    underlying: str,
    underlying_price: float,
    expiration: str,
    dte: int,
    side: str,
    strike_str: str,
) -> Contract:
    strike = _coerce_float(entry.get("strikePrice")) or _coerce_float(strike_str) or 0.0
    bid = _coerce_float(entry.get("bid")) or 0.0
    ask = _coerce_float(entry.get("ask")) or 0.0
    last = _coerce_float(entry.get("last")) or 0.0
    mid = (bid + ask) / 2.0 if (bid > 0 or ask > 0) else last
    volume = _coerce_float(entry.get("totalVolume") or entry.get("volume")) or 0.0
    return Contract(
        symbol=_coerce_str(entry.get("symbol")) or "",
        underlying=underlying,
        expiration=expiration,
        side=side,  # type: ignore[arg-type]
        strike=strike,
        dte=dte,
        bid=bid,
        ask=ask,
        mid=mid,
        last=last,
        volume=volume,
        openInterest=_coerce_float(entry.get("openInterest")) or 0.0,
        underlyingPrice=underlying_price,
        iv=_coerce_float(entry.get("volatility")) or 0.0,
        delta=_coerce_float(entry.get("delta")) or 0.0,
        gamma=_coerce_float(entry.get("gamma")) or 0.0,
        theta=_coerce_float(entry.get("theta")) or 0.0,
        vega=_coerce_float(entry.get("vega")) or 0.0,
        tickSize=_coerce_float(entry.get("tickSize")),
    )


def _split_exp_key(key: str) -> tuple[str, int]:
    """'2026-06-20:31' -> ('2026-06-20', 31)."""
    parts = key.split(":", 1)
    date_part = parts[0]
    dte_part = parts[1] if len(parts) > 1 else "0"
    try:
        dte = int(dte_part)
    except ValueError:
        dte = 0
    return date_part, dte


def _parse_candles(body: Any) -> list[Candle]:
    if not isinstance(body, dict):
        return []
    raw = body.get("candles")
    if not isinstance(raw, list):
        return []
    out: list[Candle] = []
    for c in raw:
        if not isinstance(c, dict):
            continue
        datetime_field = c.get("datetime")
        date_str = _epoch_ms_to_iso_date(_coerce_int(datetime_field) or 0)
        out.append(
            Candle(
                date=date_str,
                open=_coerce_float(c.get("open")) or 0.0,
                high=_coerce_float(c.get("high")) or 0.0,
                low=_coerce_float(c.get("low")) or 0.0,
                close=_coerce_float(c.get("close")) or 0.0,
                volume=_coerce_float(c.get("volume")) or 0.0,
            )
        )
    return out


def _period_type(frequency: str | None) -> str:
    if frequency == "minute":
        return "day"
    return "month"


def _iso_to_epoch_ms(iso_date: str) -> str:
    """Translate YYYY-MM-DD to UTC midnight epoch-ms (string for query param)."""
    from datetime import datetime

    parsed = datetime.strptime(iso_date, "%Y-%m-%d").replace(tzinfo=UTC)
    return str(int(parsed.timestamp() * 1000))


def _epoch_ms_to_iso_date(epoch_ms: int) -> str:
    from datetime import datetime

    if epoch_ms <= 0:
        return ""
    return datetime.fromtimestamp(epoch_ms / 1000.0, tz=UTC).strftime("%Y-%m-%d")


def _as_dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _coerce_float(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _coerce_int(v: Any) -> int | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            return None
    return None


def _coerce_str(v: Any) -> str | None:
    if v is None:
        return None
    return str(v) if not isinstance(v, str) else v
