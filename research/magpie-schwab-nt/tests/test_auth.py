"""Tests for ``magpie_schwab_nt.auth``.

Covers:
- token store: bootstrap, atomic write, file permissions, in-process
  refresh, refresh-token rotation, concurrent-refresh lock, force
  invalidation, missing/unreadable file → AuthExpiredError.
- auth client: bearer injection, 401-retry-after-refresh, double-401
  passthrough, header merging.

All HTTP I/O is mocked via httpx's MockTransport. No real Schwab calls.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from magpie_schwab_nt.auth import (
    OAUTH_TOKEN_URL,
    AuthExpiredError,
    SchwabAuthClient,
    SchwabTokenStore,
)

# ── Fixtures ──────────────────────────────────────────────────────


@pytest.fixture
def token_store_path(tmp_path: Path) -> Path:
    return tmp_path / "secrets" / "schwab_tokens.json"


class MockClock:
    """Injectable monotonic clock for deterministic expiry windows."""

    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _refresh_response(
    *,
    access_token: str = "access-new",
    refresh_token: str | None = "refresh-new",
    expires_in: int | None = 1800,
) -> httpx.Response:
    body: dict[str, Any] = {"access_token": access_token}
    if refresh_token is not None:
        body["refresh_token"] = refresh_token
    if expires_in is not None:
        body["expires_in"] = expires_in
    return httpx.Response(200, json=body)


def _mock_http(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport, timeout=5.0)


# ── Bootstrap + persistence ───────────────────────────────────────


class TestBootstrap:
    def test_writes_refresh_token_to_disk(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "refresh-initial")
        on_disk = json.loads(token_store_path.read_text("utf-8"))
        assert on_disk["refresh_token"] == "refresh-initial"
        assert on_disk["access_token"] == ""
        assert on_disk["expires_at"] == 0.0

    def test_file_mode_is_0600(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "r")
        mode = stat.S_IMODE(os.stat(token_store_path).st_mode)
        assert mode == 0o600

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        deep = tmp_path / "a" / "b" / "c" / "tokens.json"
        SchwabTokenStore.bootstrap(deep, "r")
        assert deep.exists()

    def test_rejects_empty_refresh_token(self, token_store_path: Path) -> None:
        with pytest.raises(ValueError):
            SchwabTokenStore.bootstrap(token_store_path, "")


# ── In-process refresh ────────────────────────────────────────────


class TestRefresh:
    @pytest.mark.asyncio
    async def test_refreshes_on_first_get(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "refresh-initial")
        calls: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            return _refresh_response(access_token="acc-1", refresh_token="ref-2")

        http = _mock_http(handler)
        clock = MockClock()
        store = SchwabTokenStore(
            app_key="key",
            app_secret="secret",
            store_path=token_store_path,
            http_client=http,
            clock=clock,
        )
        try:
            tok = await store.get_access_token()
            assert tok == "acc-1"
            assert len(calls) == 1
            # Sends Basic auth.
            assert calls[0].headers["Authorization"].startswith("Basic ")
            decoded = base64.b64decode(
                calls[0].headers["Authorization"].removeprefix("Basic ")
            ).decode()
            assert decoded == "key:secret"
            # Sends the initial refresh token.
            body = calls[0].content.decode()
            assert "refresh_token=refresh-initial" in body
            assert "grant_type=refresh_token" in body
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_persists_rotated_refresh_token(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "refresh-initial")
        http = _mock_http(
            lambda req: _refresh_response(
                access_token="acc-1", refresh_token="refresh-rotated"
            )
        )
        store = SchwabTokenStore(
            app_key="key",
            app_secret="secret",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            await store.get_access_token()
            on_disk = json.loads(token_store_path.read_text("utf-8"))
            assert on_disk["refresh_token"] == "refresh-rotated"
            assert on_disk["access_token"] == "acc-1"
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_reuses_unexpired_token(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        call_count = 0

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            return _refresh_response()

        http = _mock_http(handler)
        clock = MockClock()
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=clock,
        )
        try:
            await store.get_access_token()
            await store.get_access_token()
            await store.get_access_token()
            # Three calls, one refresh.
            assert call_count == 1
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_refreshes_inside_safety_window(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        call_count = 0

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            return _refresh_response(expires_in=1800)

        http = _mock_http(handler)
        clock = MockClock()
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=clock,
            safety_window_s=60.0,
        )
        try:
            await store.get_access_token()
            assert call_count == 1
            # Advance to 30s before expiry — inside the 60s safety window.
            clock.advance(1770)
            await store.get_access_token()
            assert call_count == 2
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_invalidate_forces_refresh(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        call_count = 0

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            return _refresh_response()

        http = _mock_http(handler)
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            await store.get_access_token()
            assert call_count == 1
            await store.invalidate()
            await store.get_access_token()
            assert call_count == 2
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_concurrent_refresh_runs_once(self, token_store_path: Path) -> None:
        """Asyncio.Lock should serialise refresh; many gets → one refresh call."""
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        call_count = 0
        gate = asyncio.Event()

        async def slow_handler(req: httpx.Request) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            await gate.wait()
            return _refresh_response()

        # MockTransport handlers can be async — httpx awaits them.
        transport = httpx.MockTransport(slow_handler)
        http = httpx.AsyncClient(transport=transport, timeout=5.0)
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            tasks = [asyncio.create_task(store.get_access_token()) for _ in range(5)]
            # Let all tasks queue up on the lock + the slow refresh.
            await asyncio.sleep(0.05)
            gate.set()
            await asyncio.gather(*tasks)
            assert call_count == 1
        finally:
            await store.aclose()
            await http.aclose()


# ── Refresh failures ──────────────────────────────────────────────


class TestRefreshFailures:
    @pytest.mark.asyncio
    async def test_401_raises_auth_expired(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        http = _mock_http(lambda req: httpx.Response(401, json={"error": "nope"}))
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            with pytest.raises(AuthExpiredError):
                await store.get_access_token()
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_500_raises_auth_expired(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        http = _mock_http(lambda req: httpx.Response(500, json={"error": "boom"}))
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            with pytest.raises(AuthExpiredError):
                await store.get_access_token()
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_missing_store_raises_auth_expired(
        self, token_store_path: Path
    ) -> None:
        # No bootstrap call — store doesn't exist.
        http = _mock_http(lambda req: _refresh_response())
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            with pytest.raises(AuthExpiredError, match="not found"):
                await store.get_access_token()
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_unreadable_store_raises_auth_expired(
        self, token_store_path: Path
    ) -> None:
        token_store_path.parent.mkdir(parents=True, exist_ok=True)
        token_store_path.write_text("not json {")
        http = _mock_http(lambda req: _refresh_response())
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            with pytest.raises(AuthExpiredError):
                await store.get_access_token()
        finally:
            await store.aclose()
            await http.aclose()

    @pytest.mark.asyncio
    async def test_zero_expires_in_raises_auth_expired(
        self, token_store_path: Path
    ) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        http = _mock_http(lambda req: _refresh_response(expires_in=0))
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=http,
            clock=MockClock(),
        )
        try:
            with pytest.raises(AuthExpiredError, match="expires_in"):
                await store.get_access_token()
        finally:
            await store.aclose()
            await http.aclose()


# ── SchwabAuthClient ──────────────────────────────────────────────


class TestAuthClient:
    @pytest.mark.asyncio
    async def test_injects_bearer_header(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        refresh_calls: list[httpx.Request] = []
        api_calls: list[httpx.Request] = []

        def store_handler(req: httpx.Request) -> httpx.Response:
            refresh_calls.append(req)
            return _refresh_response(access_token="my-access-token")

        def api_handler(req: httpx.Request) -> httpx.Response:
            api_calls.append(req)
            return httpx.Response(200, json={"ok": True})

        # Token store has its own httpx; auth client has another. Both
        # use MockTransport so they're isolated from the network.
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=_mock_http(store_handler),
            clock=MockClock(),
        )
        client = SchwabAuthClient(
            token_store=store,
            http_client=_mock_http(api_handler),
        )
        try:
            r = await client.get("https://api.example/v1/foo")
            assert r.status_code == 200
            assert api_calls[0].headers["Authorization"] == "Bearer my-access-token"
        finally:
            await client.aclose()
            await store.aclose()

    @pytest.mark.asyncio
    async def test_401_then_refresh_then_retry(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        store_calls = 0

        def store_handler(req: httpx.Request) -> httpx.Response:
            nonlocal store_calls
            store_calls += 1
            return _refresh_response(access_token=f"access-{store_calls}")

        api_call_count = 0

        def api_handler(req: httpx.Request) -> httpx.Response:
            nonlocal api_call_count
            api_call_count += 1
            # First call: 401. Retry: 200.
            if api_call_count == 1:
                return httpx.Response(401, json={"error": "expired"})
            return httpx.Response(200, json={"ok": True})

        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=_mock_http(store_handler),
            clock=MockClock(),
        )
        client = SchwabAuthClient(
            token_store=store,
            http_client=_mock_http(api_handler),
        )
        try:
            r = await client.get("https://api.example/v1/foo")
            assert r.status_code == 200
            assert api_call_count == 2
            # Two refreshes: initial + after the 401.
            assert store_calls == 2
        finally:
            await client.aclose()
            await store.aclose()

    @pytest.mark.asyncio
    async def test_double_401_passes_through(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=_mock_http(lambda req: _refresh_response()),
            clock=MockClock(),
        )
        client = SchwabAuthClient(
            token_store=store,
            http_client=_mock_http(
                lambda req: httpx.Response(401, json={"error": "always"})
            ),
        )
        try:
            r = await client.get("https://api.example/v1/foo")
            # No exception — the auth client returns the second 401 to
            # the caller. Caller decides escalation.
            assert r.status_code == 401
        finally:
            await client.aclose()
            await store.aclose()

    @pytest.mark.asyncio
    async def test_merges_caller_headers(self, token_store_path: Path) -> None:
        SchwabTokenStore.bootstrap(token_store_path, "ref")
        captured: list[httpx.Request] = []

        def api_handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200)

        store = SchwabTokenStore(
            app_key="k",
            app_secret="s",
            store_path=token_store_path,
            http_client=_mock_http(lambda req: _refresh_response()),
            clock=MockClock(),
        )
        client = SchwabAuthClient(
            token_store=store,
            http_client=_mock_http(api_handler),
        )
        try:
            await client.get(
                "https://api.example/v1/foo",
                headers={"X-Trace-Id": "abc123"},
            )
            assert captured[0].headers["X-Trace-Id"] == "abc123"
            # Authorization injected on top.
            assert captured[0].headers["Authorization"].startswith("Bearer ")
        finally:
            await client.aclose()
            await store.aclose()


# ── Sanity ────────────────────────────────────────────────────────


class TestModuleAPI:
    def test_oauth_token_url_is_canonical(self) -> None:
        # If Schwab ever moves the endpoint, this test should fail
        # noisily so the operator updates a single place.
        assert OAUTH_TOKEN_URL == "https://api.schwabapi.com/v1/oauth/token"
