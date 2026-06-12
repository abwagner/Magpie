"""SchwabRestMdClient unit tests — mocked Schwab REST via httpx.MockTransport."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from magpie_md_bridge.schwab.rest_md_client import (
    SchwabMdError,
    SchwabRestMdClient,
)

# ── A minimal SchwabAuthClient stand-in ──
#
# The real SchwabAuthClient handles token refresh + redaction; for unit
# testing the REST client we only need GET. The fake delegates to an httpx
# AsyncClient configured with httpx.MockTransport so each test can wire up
# canned vendor responses.


class _FakeAuth:
    def __init__(self, transport: httpx.MockTransport) -> None:
        self._client = httpx.AsyncClient(transport=transport)

    async def get(
        self, url: str, params: dict[str, Any] | None = None
    ) -> httpx.Response:
        return await self._client.get(url, params=params)

    async def aclose(self) -> None:
        await self._client.aclose()


def _make_client(handler: httpx.MockTransport) -> SchwabRestMdClient:
    return SchwabRestMdClient(
        auth_client=_FakeAuth(handler), md_base="https://example/marketdata/v1"
    )  # type: ignore[arg-type]


# ── get_quote ──


@pytest.mark.asyncio
async def test_get_quote_parses_levelone_response() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/marketdata/v1/quotes"
        assert dict(req.url.params)["symbols"] == "SPY"
        return httpx.Response(
            200,
            json={
                "SPY": {
                    "quote": {
                        "bidPrice": 512.34,
                        "askPrice": 512.38,
                        "lastPrice": 512.37,
                        "totalVolume": 12345678,
                        "quoteTime": "2026-05-20T18:30:00Z",
                    }
                }
            },
        )

    client = _make_client(httpx.MockTransport(handler))
    quote = await client.get_quote("SPY", fetched_at="2026-05-20T18:30:00.123Z")
    assert quote.symbol == "SPY"
    assert quote.bid == 512.34
    assert quote.ask == 512.38
    assert quote.last == 512.37
    assert quote.mid == pytest.approx(512.36)
    assert quote.meta.source == "schwab"
    assert quote.meta.fetched_at == "2026-05-20T18:30:00.123Z"


@pytest.mark.asyncio
async def test_get_quote_raises_on_4xx() -> None:
    handler = httpx.MockTransport(
        lambda _: httpx.Response(401, json={"error": "unauthorized"})
    )
    client = _make_client(handler)
    with pytest.raises(SchwabMdError) as exc_info:
        await client.get_quote("SPY", fetched_at="2026-05-20T18:30:00Z")
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_get_quote_raises_on_missing_symbol() -> None:
    handler = httpx.MockTransport(
        lambda _: httpx.Response(200, json={"OTHER": {"quote": {}}})
    )
    client = _make_client(handler)
    with pytest.raises(SchwabMdError, match="missing from response"):
        await client.get_quote("SPY", fetched_at="2026-05-20T18:30:00Z")


# ── get_expirations ──


@pytest.mark.asyncio
async def test_get_expirations_parses_response() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/marketdata/v1/expirationchain"
        assert dict(req.url.params) == {"symbol": "SPY"}
        return httpx.Response(
            200,
            json={
                "expirationList": [
                    {"expirationDate": "2026-05-23"},
                    {"expirationDate": "2026-05-30"},
                    {"expirationDate": "2026-06-20"},
                ]
            },
        )

    client = _make_client(httpx.MockTransport(handler))
    exps = await client.get_expirations("SPY")
    assert exps == ["2026-05-23", "2026-05-30", "2026-06-20"]


@pytest.mark.asyncio
async def test_get_expirations_handles_empty_response() -> None:
    handler = httpx.MockTransport(lambda _: httpx.Response(200, json={}))
    client = _make_client(handler)
    assert await client.get_expirations("SPY") == []


# ── get_chain ──


@pytest.mark.asyncio
async def test_get_chain_parses_both_sides() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/marketdata/v1/chains"
        params = dict(req.url.params)
        assert params["symbol"] == "SPY"
        assert params["fromDate"] == "2026-06-20"
        assert params["toDate"] == "2026-06-20"
        assert params["contractType"] == "ALL"
        return httpx.Response(
            200,
            json={
                "symbol": "SPY",
                "underlying": {"last": 512.36},
                "callExpDateMap": {
                    "2026-06-20:31": {
                        "515.0": [
                            {
                                "symbol": "SPY  260620C00515000",
                                "strikePrice": 515.0,
                                "bid": 8.55,
                                "ask": 8.7,
                                "last": 8.6,
                                "totalVolume": 4321,
                                "openInterest": 15234,
                                "volatility": 0.187,
                                "delta": 0.42,
                                "gamma": 0.018,
                                "theta": -0.21,
                                "vega": 0.53,
                            }
                        ],
                    }
                },
                "putExpDateMap": {
                    "2026-06-20:31": {
                        "515.0": [
                            {
                                "symbol": "SPY  260620P00515000",
                                "strikePrice": 515.0,
                                "bid": 11.05,
                                "ask": 11.2,
                                "last": 11.1,
                                "totalVolume": 3210,
                                "openInterest": 8888,
                                "volatility": 0.193,
                                "delta": -0.55,
                                "gamma": 0.018,
                                "theta": -0.22,
                                "vega": 0.53,
                            }
                        ],
                    }
                },
            },
        )

    client = _make_client(httpx.MockTransport(handler))
    chain = await client.get_chain(
        "SPY", "2026-06-20", fetched_at="2026-05-20T18:30:00Z"
    )
    assert len(chain) == 2
    sides = {c.side for c in chain}
    assert sides == {"call", "put"}
    by_side = {c.side: c for c in chain}
    assert by_side["call"].strike == 515.0
    assert by_side["call"].mid == pytest.approx((8.55 + 8.7) / 2)
    assert by_side["put"].underlyingPrice == 512.36
    assert by_side["call"].dte == 31


@pytest.mark.asyncio
async def test_get_chain_handles_empty_maps() -> None:
    handler = httpx.MockTransport(
        lambda _: httpx.Response(
            200,
            json={"symbol": "SPY", "callExpDateMap": {}, "putExpDateMap": {}},
        )
    )
    client = _make_client(handler)
    chain = await client.get_chain(
        "SPY", "2026-06-20", fetched_at="2026-05-20T18:30:00Z"
    )
    assert chain == []


# ── get_candles ──


@pytest.mark.asyncio
async def test_get_candles_translates_dates_and_parses() -> None:
    captured: dict[str, str] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured.update(dict(req.url.params))
        return httpx.Response(
            200,
            json={
                "candles": [
                    {
                        "datetime": 1779235200000,  # 2026-05-20 00:00:00 UTC
                        "open": 510.12,
                        "high": 513.45,
                        "low": 509.88,
                        "close": 512.37,
                        "volume": 78123456,
                    }
                ]
            },
        )

    client = _make_client(httpx.MockTransport(handler))
    candles = await client.get_candles(
        "SPY", "2026-05-15", "2026-05-20", frequency="daily"
    )
    assert len(candles) == 1
    assert candles[0].date == "2026-05-20"
    assert candles[0].open == 510.12
    assert captured["symbol"] == "SPY"
    assert captured["frequencyType"] == "daily"
    assert captured["startDate"].isdigit()
    assert captured["endDate"].isdigit()


@pytest.mark.asyncio
async def test_get_candles_returns_empty_on_no_candles_field() -> None:
    handler = httpx.MockTransport(lambda _: httpx.Response(200, json={}))
    client = _make_client(handler)
    assert (
        await client.get_candles("SPY", "2026-05-15", "2026-05-20", frequency="daily")
        == []
    )
