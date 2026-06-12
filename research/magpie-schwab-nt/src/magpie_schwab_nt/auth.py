"""Schwab OAuth2 token lifecycle for the NT adapters.

Provides:

* `SchwabTokenStore` — persistent refresh-token store with in-process
  access-token caching. Refreshes ~`safety_window_s` before expiry,
  serialised via an asyncio lock so concurrent callers don't
  double-refresh. Refresh-token rotation is atomic: the new value is
  written to disk before the access token is returned to the caller,
  so a crash mid-rotation leaves either the old or the new pair fully
  consistent on disk.
* `SchwabAuthClient` — thin wrapper around `httpx.AsyncClient` that
  injects the `Bearer` header and retries once on 401 after forcing
  a token refresh.
* `AuthExpiredError` — raised when the refresh token itself is
  invalidated. NT's exec client maps this to an account-state event;
  recovery requires the operator to re-run the OAuth browser dance and
  bootstrap a new refresh token.

Design rationale lives in
`docs/research/qf-160-schwab-nt-spike.md §Spot-check 2`.

Reference: QF-161.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import stat
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

# Schwab OAuth endpoint. Hard-coded — `schwabapi.com` is the canonical
# host for both prod and test; there is no separate sandbox.
OAUTH_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token"

# Schwab access tokens are typically 1800s (30 min). Refresh this many
# seconds *before* expiry so an in-flight request never sees a 401 from
# a token that expired mid-flight. 60s is a comfortable margin: longer
# than any reasonable single-request RTT, shorter than the refresh
# round-trip.
DEFAULT_SAFETY_WINDOW_S = 60.0


class AuthExpiredError(Exception):
    """The refresh token has been invalidated.

    Schwab's refresh tokens are 7-day-lived. Once invalidated (manual
    revocation, the 7-day window passes, or Schwab decides for any
    other reason), the only recovery is for the operator to re-run the
    OAuth browser dance and persist a new refresh token via
    `SchwabTokenStore.bootstrap(...)`. The store cannot recover
    automatically.
    """


@dataclass
class _TokenPair:
    """In-memory cache of the current access + refresh token pair."""

    access_token: str
    refresh_token: str
    expires_at: float  # wall-clock epoch seconds


class SchwabTokenStore:
    """Persistent Schwab token store with async-safe refresh.

    The disk artefact is a JSON file with three fields::

        {"refresh_token": "...", "access_token": "...", "expires_at": 1715825472.5}

    On boot we trust the persisted `refresh_token`; the cached
    `access_token` is reused only if `expires_at` is still in the
    future, otherwise we refresh. The file is rewritten atomically
    (temp file + os.replace) on every refresh so the new refresh
    token is durable before the caller sees the new access token.
    """

    def __init__(
        self,
        *,
        app_key: str,
        app_secret: str,
        store_path: Path,
        http_client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.time,
        safety_window_s: float = DEFAULT_SAFETY_WINDOW_S,
    ) -> None:
        self._app_key = app_key
        self._app_secret = app_secret
        self._path = Path(store_path)
        self._owns_http_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=15.0)
        self._clock = clock
        self._safety_window_s = safety_window_s
        self._lock = asyncio.Lock()
        self._pair: _TokenPair | None = None

    # ── Public API ────────────────────────────────────────────────

    @staticmethod
    def bootstrap(store_path: Path, refresh_token: str) -> None:
        """Write the initial refresh token to disk (no API call).

        Run this once after the operator-side OAuth browser dance
        (`scripts/schwab-auth.js`) has produced a fresh refresh token.
        Subsequent rotations happen in-process via `get_access_token`.
        """
        if not refresh_token:
            raise ValueError("refresh_token must be non-empty")
        payload = {
            "refresh_token": refresh_token,
            "access_token": "",
            "expires_at": 0.0,
        }
        _atomic_write_json(Path(store_path), payload)

    async def get_access_token(self) -> str:
        """Return a non-expired access token, refreshing if needed."""
        async with self._lock:
            if self._pair is None:
                self._pair = self._load_or_raise()
            if self._needs_refresh(self._pair):
                self._pair = await self._refresh_locked(self._pair.refresh_token)
            return self._pair.access_token

    async def invalidate(self) -> None:
        """Force the next `get_access_token` call to refresh.

        Used after a 401 — the cached access token is invalid even
        though we'd thought it was fresh.
        """
        async with self._lock:
            if self._pair is not None:
                self._pair = _TokenPair(
                    access_token=self._pair.access_token,
                    refresh_token=self._pair.refresh_token,
                    expires_at=0.0,
                )

    async def aclose(self) -> None:
        """Close the owned httpx client. No-op if a client was injected."""
        if self._owns_http_client:
            await self._http.aclose()

    # ── Internals ─────────────────────────────────────────────────

    def _needs_refresh(self, pair: _TokenPair) -> bool:
        return (
            not pair.access_token
            or self._clock() >= pair.expires_at - self._safety_window_s
        )

    def _load_or_raise(self) -> _TokenPair:
        if not self._path.exists():
            raise AuthExpiredError(
                f"Schwab token store {self._path} not found. "
                "Run scripts/schwab-auth.js to bootstrap a refresh token."
            )
        try:
            raw = json.loads(self._path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise AuthExpiredError(
                f"Schwab token store {self._path} unreadable: {e}"
            ) from e
        refresh = raw.get("refresh_token")
        if not isinstance(refresh, str) or not refresh:
            raise AuthExpiredError(
                f"Schwab token store {self._path} missing refresh_token"
            )
        access = raw.get("access_token") or ""
        expires_at = float(raw.get("expires_at") or 0.0)
        return _TokenPair(
            access_token=str(access),
            refresh_token=refresh,
            expires_at=expires_at,
        )

    async def _refresh_locked(self, refresh_token: str) -> _TokenPair:
        """Run the refresh + persist sequence. Caller already holds the lock."""
        body = await self._post_refresh(refresh_token)
        new_access = body["access_token"]
        # Schwab rotates the refresh token; the new one is in the
        # response body. Fall back to the prior value if (defensively)
        # Schwab ever omits it — at the time of writing they always
        # include it.
        new_refresh = body.get("refresh_token") or refresh_token
        expires_in = float(body.get("expires_in") or 0.0)
        if expires_in <= 0:
            raise AuthExpiredError(
                f"Schwab token refresh returned expires_in <= 0; body={_redact(body)}"
            )
        new_pair = _TokenPair(
            access_token=new_access,
            refresh_token=new_refresh,
            expires_at=self._clock() + expires_in,
        )
        # Persist BEFORE returning — a crash between here and the
        # caller's request leaves the new pair on disk, not the old.
        _atomic_write_json(
            self._path,
            {
                "refresh_token": new_pair.refresh_token,
                "access_token": new_pair.access_token,
                "expires_at": new_pair.expires_at,
            },
        )
        return new_pair

    async def _post_refresh(self, refresh_token: str) -> dict[str, Any]:
        basic = base64.b64encode(
            f"{self._app_key}:{self._app_secret}".encode()
        ).decode()
        response = await self._http.post(
            OAUTH_TOKEN_URL,
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )
        if response.status_code == 401:
            raise AuthExpiredError(
                "Schwab rejected the refresh token (401). "
                "Re-run scripts/schwab-auth.js to bootstrap a new one."
            )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise AuthExpiredError(
                f"Schwab token refresh failed: HTTP {response.status_code}"
            ) from e
        body = response.json()
        if not isinstance(body, dict) or "access_token" not in body:
            raise AuthExpiredError(
                f"Schwab token refresh returned unexpected body: {_redact(body)}"
            )
        return body


class SchwabAuthClient:
    """`httpx.AsyncClient` wrapper that injects auth + retries on 401.

    The 401-then-refresh-then-retry-once pattern is the contract NT's
    market-data and execution clients rely on: a single REST call to
    Schwab either succeeds, or fails for a non-auth reason, or
    succeeds-after-a-transparent-refresh. Two consecutive 401s mean
    something is structurally wrong (refresh token revoked, app
    credentials wrong) and surfaces as `AuthExpiredError`.
    """

    def __init__(
        self,
        *,
        token_store: SchwabTokenStore,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._tokens = token_store
        self._owns_http_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=15.0)

    async def request(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> httpx.Response:
        """Make an authenticated request. Retries once on 401."""
        response = await self._send(method, url, **kwargs)
        if response.status_code != 401:
            return response
        # Force a refresh and retry once. If the second attempt also
        # 401s, propagate the response — the caller can decide whether
        # to invalidate the auth context or treat it as a per-resource
        # permission failure.
        await self._tokens.invalidate()
        return await self._send(method, url, **kwargs)

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    async def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("PUT", url, **kwargs)

    async def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("DELETE", url, **kwargs)

    async def aclose(self) -> None:
        if self._owns_http_client:
            await self._http.aclose()

    async def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        access_token = await self._tokens.get_access_token()
        headers = dict(kwargs.pop("headers", None) or {})
        headers["Authorization"] = f"Bearer {access_token}"
        return await self._http.request(method, url, headers=headers, **kwargs)


# ── Helpers ───────────────────────────────────────────────────────


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write `payload` to `path` atomically via temp-file + replace.

    The file is created with mode 0600 (owner read+write only). The
    temp file lives in the same directory so the rename stays within
    one filesystem — POSIX requires that for atomicity.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, sort_keys=True)
        os.replace(tmp, path)
        # os.replace preserves the temp file's mode; ensure 0600 on
        # the final path even if the user umask is permissive.
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        raise


def _redact(body: Any) -> str:
    """Best-effort redaction of token-shaped fields for error messages."""
    if not isinstance(body, dict):
        return str(body)
    safe: dict[str, Any] = {}
    for k, v in body.items():
        if any(s in str(k).lower() for s in ("token", "secret", "password")):
            safe[k] = "***"
        else:
            safe[k] = v
    return json.dumps(safe, sort_keys=True)


# Optional helper for the NT bootstrap path; not part of the core
# token-store API but useful enough to ship in the same module.
async def get_access_token_from_env(
    *,
    store_path: Path,
    http_client: httpx.AsyncClient | None = None,
) -> str:
    """Read app key/secret from env and return a refreshed access token.

    Reads `SCHWAB_APP_KEY` and `SCHWAB_APP_SECRET` from os.environ.
    The store at `store_path` must already have a refresh token (via
    `SchwabTokenStore.bootstrap` or a prior session).
    """
    app_key = os.environ.get("SCHWAB_APP_KEY")
    app_secret = os.environ.get("SCHWAB_APP_SECRET")
    if not app_key or not app_secret:
        raise AuthExpiredError(
            "SCHWAB_APP_KEY and SCHWAB_APP_SECRET must be set in env"
        )
    store = SchwabTokenStore(
        app_key=app_key,
        app_secret=app_secret,
        store_path=store_path,
        http_client=http_client,
    )
    try:
        return await store.get_access_token()
    finally:
        await store.aclose()


# Re-export for type-stub consumers.
__all__ = [
    "AuthExpiredError",
    "SchwabAuthClient",
    "SchwabTokenStore",
    "get_access_token_from_env",
]
