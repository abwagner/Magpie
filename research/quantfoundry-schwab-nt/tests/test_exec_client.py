"""Tests for ``quantfoundry_schwab_nt.exec_client``.

Mocks Schwab's REST API via httpx.MockTransport plus a stub auth
client (`SchwabAuthClient` is exercised in test_auth.py — here we
just want a passthrough Bearer-header-injector).

Covers:
- submit_order: 201 + Location → orderId; missing Location raises.
- cancel_order: 200 happy; 4xx raises.
- modify_order: 200 + new Location → new orderId; no Location → original id.
- query_order parsing.
- list_open_orders: iterates statuses + dedup + raises on per-status 4xx.
- list_positions: parses the `securitiesAccount.positions[]` slice.
- non-success bodies surface via SchwabExecError.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest
from quantfoundry_schwab_nt.auth import SchwabAuthClient, SchwabTokenStore
from quantfoundry_schwab_nt.exec_client import (
    SchwabExecError,
    SchwabRestExecClient,
)

# ── Helpers ───────────────────────────────────────────────────────


def _mock_http(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport, timeout=5.0)


class _StubStore(SchwabTokenStore):
    """Subclass of SchwabTokenStore that returns a fixed token (no I/O)."""

    async def get_access_token(self) -> str:  # type: ignore[override]
        return "stub-access"


async def _make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    tmp_path: Any,
) -> tuple[SchwabRestExecClient, SchwabAuthClient]:
    SchwabTokenStore.bootstrap(tmp_path / "tokens.json", "ref")
    store = _StubStore(app_key="k", app_secret="s", store_path=tmp_path / "tokens.json")
    auth = SchwabAuthClient(token_store=store, http_client=_mock_http(handler))
    exec_client = SchwabRestExecClient(
        auth_client=auth,
        account_hash="hash-1",
        trader_base="https://example.test/trader/v1",
    )
    return exec_client, auth


# ── submit_order ──────────────────────────────────────────────────


class TestSubmitOrder:
    @pytest.mark.asyncio
    async def test_201_with_location_returns_order_id(self, tmp_path: Any) -> None:
        captured: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(
                201,
                headers={
                    "Location": (
                        "https://example.test/trader/v1/accounts/hash-1/orders/12345"
                    )
                },
            )

        client, auth = await _make_client(handler, tmp_path)
        try:
            order_id = await client.submit_order({"orderStrategyType": "SINGLE"})
            assert order_id == "12345"
            # Bearer header injected by the auth client.
            assert captured[0].headers["Authorization"] == "Bearer stub-access"
            assert captured[0].url.path == "/trader/v1/accounts/hash-1/orders"
            assert captured[0].method == "POST"
        finally:
            await auth.aclose()

    @pytest.mark.asyncio
    async def test_missing_location_raises(self, tmp_path: Any) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(201)  # no Location header

        client, auth = await _make_client(handler, tmp_path)
        try:
            with pytest.raises(SchwabExecError, match="Location"):
                await client.submit_order({})
        finally:
            await auth.aclose()

    @pytest.mark.asyncio
    async def test_4xx_raises(self, tmp_path: Any) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(400, json={"error": "bad order"})

        client, auth = await _make_client(handler, tmp_path)
        try:
            with pytest.raises(SchwabExecError) as exc:
                await client.submit_order({})
            assert exc.value.status_code == 400
            assert exc.value.body == {"error": "bad order"}
        finally:
            await auth.aclose()


# ── cancel_order ──────────────────────────────────────────────────


class TestCancelOrder:
    @pytest.mark.asyncio
    async def test_200_no_content_is_success(self, tmp_path: Any) -> None:
        captured: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200)

        client, auth = await _make_client(handler, tmp_path)
        try:
            await client.cancel_order("12345")
            assert captured[0].method == "DELETE"
            assert captured[0].url.path == "/trader/v1/accounts/hash-1/orders/12345"
        finally:
            await auth.aclose()

    @pytest.mark.asyncio
    async def test_4xx_raises(self, tmp_path: Any) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": "no such order"})

        client, auth = await _make_client(handler, tmp_path)
        try:
            with pytest.raises(SchwabExecError):
                await client.cancel_order("12345")
        finally:
            await auth.aclose()


# ── modify_order ──────────────────────────────────────────────────


class TestModifyOrder:
    @pytest.mark.asyncio
    async def test_returns_new_order_id_from_location(self, tmp_path: Any) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={
                    "Location": (
                        "https://example.test/trader/v1/accounts/hash-1/orders/99999"
                    )
                },
            )

        client, auth = await _make_client(handler, tmp_path)
        try:
            new_id = await client.modify_order("12345", {"orderStrategyType": "SINGLE"})
            assert new_id == "99999"
        finally:
            await auth.aclose()

    @pytest.mark.asyncio
    async def test_no_location_returns_original_id(self, tmp_path: Any) -> None:
        # Race: order filled mid-modify; Schwab returns 200 with no
        # Location. The exec client surfaces the original id so the
        # adapter can interpret it as a no-op replace.
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        client, auth = await _make_client(handler, tmp_path)
        try:
            new_id = await client.modify_order("12345", {})
            assert new_id == "12345"
        finally:
            await auth.aclose()


# ── query_order ───────────────────────────────────────────────────


class TestQueryOrder:
    @pytest.mark.asyncio
    async def test_parses_order_fields(self, tmp_path: Any) -> None:
        body = {
            "orderId": 12345,
            "status": "WORKING",
            "quantity": 10,
            "filledQuantity": 3,
            "orderLegCollection": [
                {"instrument": {"symbol": "AAPL"}, "instruction": "BUY", "quantity": 10}
            ],
            "replacedOrderId": 11111,
        }

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=body)

        client, auth = await _make_client(handler, tmp_path)
        try:
            order = await client.query_order("12345")
            assert order.order_id == "12345"
            assert order.status == "WORKING"
            assert order.quantity == 10.0
            assert order.filled_quantity == 3.0
            assert len(order.legs) == 1
            assert order.legs[0]["instrument"]["symbol"] == "AAPL"
            assert order.replaced_order_id == "11111"
            assert order.account_hash == "hash-1"
        finally:
            await auth.aclose()


# ── list_open_orders ──────────────────────────────────────────────


class TestListOpenOrders:
    @pytest.mark.asyncio
    async def test_iterates_statuses_and_dedups(self, tmp_path: Any) -> None:
        # Schwab returns orderId 1 for both WORKING and ACCEPTED queries
        # (rare but possible during a status transition). The client
        # dedups by orderId so the caller doesn't see two copies.
        status_counter = {"calls": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            status_counter["calls"] += 1
            status = req.url.params.get("status")
            if status == "WORKING":
                return httpx.Response(
                    200,
                    json=[
                        {
                            "orderId": 1,
                            "status": "WORKING",
                            "quantity": 5,
                            "filledQuantity": 0,
                        }
                    ],
                )
            if status == "ACCEPTED":
                return httpx.Response(
                    200,
                    json=[
                        {
                            "orderId": 1,
                            "status": "ACCEPTED",
                            "quantity": 5,
                            "filledQuantity": 0,
                        },
                        {
                            "orderId": 2,
                            "status": "ACCEPTED",
                            "quantity": 7,
                            "filledQuantity": 0,
                        },
                    ],
                )
            return httpx.Response(200, json=[])  # other statuses: empty

        client, auth = await _make_client(handler, tmp_path)
        try:
            orders = await client.list_open_orders()
            ids = sorted(o.order_id for o in orders)
            assert ids == ["1", "2"]
        finally:
            await auth.aclose()

    @pytest.mark.asyncio
    async def test_4xx_per_status_raises(self, tmp_path: Any) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        client, auth = await _make_client(handler, tmp_path)
        try:
            with pytest.raises(SchwabExecError):
                await client.list_open_orders()
        finally:
            await auth.aclose()


# ── list_positions ────────────────────────────────────────────────


class TestListPositions:
    @pytest.mark.asyncio
    async def test_parses_securities_account_positions(self, tmp_path: Any) -> None:
        body = {
            "securitiesAccount": {
                "positions": [
                    {
                        "instrument": {"symbol": "AAPL", "assetType": "EQUITY"},
                        "longQuantity": 100,
                        "shortQuantity": 0,
                        "marketValue": 15000.0,
                        "averagePrice": 145.5,
                    },
                    {
                        "instrument": {
                            "symbol": "AAPL  260516C00500000",
                            "assetType": "OPTION",
                        },
                        "longQuantity": 0,
                        "shortQuantity": 1,
                        "marketValue": -250.0,
                        "averagePrice": 2.5,
                    },
                ]
            }
        }

        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.params.get("fields") == "positions"
            return httpx.Response(200, json=body)

        client, auth = await _make_client(handler, tmp_path)
        try:
            positions = await client.list_positions()
            assert len(positions) == 2
            equity = next(p for p in positions if p.instrument_type == "EQUITY")
            option = next(p for p in positions if p.instrument_type == "OPTION")
            assert equity.net_quantity == 100.0
            assert option.net_quantity == -1.0
            assert equity.average_price == 145.5
        finally:
            await auth.aclose()

    @pytest.mark.asyncio
    async def test_no_positions_field_returns_empty(self, tmp_path: Any) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"securitiesAccount": {}})

        client, auth = await _make_client(handler, tmp_path)
        try:
            positions = await client.list_positions()
            assert positions == []
        finally:
            await auth.aclose()
