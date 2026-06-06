"""HTTP publisher to the Signal Ingress sidecar.

The Python SDK does not talk to NATS directly — it POSTs to
``/signals`` on the TS server's HTTP sidecar (default
``http://localhost:3001/signals``), which is responsible for
validating, rate-limiting, and routing onto the internal NATS stream.

The publisher takes a typed :class:`~quantfoundry_signals.types.Signal`
sequence and:

1. Renders the batch envelope ``{"signals": [...]}`` via
   :meth:`Signal.to_wire`.
2. POSTs it with ``Authorization: Bearer <token>`` (token from
   constructor argument or ``QF_SIGNALS_TOKEN`` env var).
3. On 200, parses the response and returns a
   :class:`SignalAcceptResponse`.
4. On 4xx/5xx, raises a typed exception from
   :mod:`quantfoundry_signals.exceptions`.
5. On transient errors (timeouts, 5xx, 429), retries with exponential
   backoff up to ``max_retries`` attempts. Gives up via
   :class:`SignalTransportError` for repeated transients, or surfaces
   the typed error from the final attempt for 4xx.

Logging: emits ``signal.publish.*`` events through ``quantfoundry_logging``,
with ``correlation_id`` propagated from the bound context.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import random
from collections.abc import Sequence
from typing import Any

import httpx
from quantfoundry_logging import get_logger

from quantfoundry_signals.exceptions import (
    SignalAuthError,
    SignalRateLimitError,
    SignalServerError,
    SignalTransportError,
    SignalValidationError,
)
from quantfoundry_signals.types import (
    Signal,
    SignalAcceptResponse,
    SignalBatchRequest,
)

DEFAULT_INGRESS_URL = "http://localhost:3001/signals"
TOKEN_ENV_VAR = "QF_SIGNALS_TOKEN"

_logger = get_logger("quantfoundry-signals")


class SignalPublisher:
    """Async publisher for a single ingress endpoint.

    Construct once per worker (or once per service); reuse across many
    ``publish()`` calls — the underlying ``httpx.AsyncClient`` keeps a
    connection pool warm.

    Parameters
    ----------
    ingress_url:
        Full URL of the ingress endpoint. Defaults to
        :data:`DEFAULT_INGRESS_URL`.
    token:
        Bearer token for the ``Authorization`` header. Falls back to
        the ``QF_SIGNALS_TOKEN`` env var when ``None``. If both are
        empty/unset the publisher still works (v1 ingress auth is a
        stub) but logs a one-shot warning so misconfiguration is
        visible.
    http_client:
        Pre-built ``httpx.AsyncClient``. Tests can pass an
        :class:`httpx.AsyncClient` wired to ``httpx.MockTransport`` to
        avoid real HTTP; production callers normally leave this and
        let the publisher own its own client.
    timeout_s:
        Per-request timeout in seconds. Only used when ``http_client``
        is ``None``.
    max_retries:
        Maximum number of attempts (including the first). ``1`` = no
        retry. ``5`` is the default; chosen because the ingress
        rate-limit recommends 5-attempt exponential backoff before
        falling over.
    base_backoff_s:
        Starting delay for the exponential backoff (doubles each
        retry, jittered by ±25%). Default ``1.0``s.
    max_backoff_s:
        Cap for the exponential backoff. Default ``30.0``s.
    """

    def __init__(
        self,
        *,
        ingress_url: str = DEFAULT_INGRESS_URL,
        token: str | None = None,
        http_client: httpx.AsyncClient | None = None,
        timeout_s: float = 10.0,
        max_retries: int = 5,
        base_backoff_s: float = 1.0,
        max_backoff_s: float = 30.0,
    ) -> None:
        self._ingress_url = ingress_url
        self._token = token if token is not None else os.environ.get(TOKEN_ENV_VAR, "")
        self._owned_client = http_client is None
        self._client = http_client or httpx.AsyncClient(timeout=timeout_s)
        if max_retries < 1:
            raise ValueError("max_retries must be >= 1")
        self._max_retries = max_retries
        self._base_backoff_s = base_backoff_s
        self._max_backoff_s = max_backoff_s
        if not self._token:
            _logger.warning(
                "signal.publish.no_token",
                payload={
                    "ingress_url": ingress_url,
                    "env_var": TOKEN_ENV_VAR,
                    "hint": (
                        "v1 ingress auth is a stub; set QF_SIGNALS_TOKEN "
                        "before phase-2 auth lands"
                    ),
                },
            )

    async def aclose(self) -> None:
        """Close the underlying HTTP client if the publisher owns it."""
        if self._owned_client:
            await self._client.aclose()

    async def __aenter__(self) -> SignalPublisher:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def publish(self, signals: Sequence[Signal]) -> SignalAcceptResponse:
        """POST a batch and return the parsed accept response.

        Raises one of the typed exceptions on failure.
        """
        if not signals:
            raise SignalValidationError("publish: signals batch must be non-empty")
        # The ingress contract caps batches at 1000. We could shard
        # client-side here, but PR-1 keeps it simple: surface the cap
        # as a validation error and let the caller split.
        if len(signals) > 1000:
            raise SignalValidationError(
                f"publish: batch exceeds 1000-signal cap (got {len(signals)})"
            )

        body = SignalBatchRequest(signals=tuple(signals)).to_wire()
        headers = self._build_headers()

        last_transport: BaseException | None = None
        for attempt in range(1, self._max_retries + 1):
            _logger.info(
                "signal.publish.attempt",
                payload={
                    "attempt": attempt,
                    "max_attempts": self._max_retries,
                    "count": len(signals),
                    "url": self._ingress_url,
                },
            )
            try:
                resp = await self._client.post(
                    self._ingress_url, json=body, headers=headers
                )
            except httpx.HTTPError as exc:
                # Transport-level failure (connect timeout, read timeout,
                # connection reset, ...). Retryable.
                last_transport = exc
                _logger.warning(
                    "signal.publish.transport_error",
                    payload={"attempt": attempt, "error": str(exc)},
                )
                if attempt >= self._max_retries:
                    raise SignalTransportError(
                        f"publish: transport exhausted after {attempt} attempts",
                        last_error=exc,
                    ) from exc
                await self._sleep_backoff(attempt)
                continue

            # Got a response. Route by status code.
            if resp.status_code == 200:
                return self._parse_accept(resp)

            # 401/403: auth — never retry.
            if resp.status_code in (401, 403):
                raise SignalAuthError(
                    f"publish: auth rejected ({resp.status_code})",
                    status_code=resp.status_code,
                )

            # 429: rate limit — retryable if we have attempts left.
            if resp.status_code == 429:
                body_dict = _safe_json(resp)
                retry_after = self._compute_retry_after_s(resp, body_dict)
                if attempt >= self._max_retries:
                    raise SignalRateLimitError(
                        "publish: rate-limited (retry budget exhausted)",
                        retry_after_ms=(
                            int(retry_after * 1000) if retry_after is not None else None
                        ),
                        model_id=(body_dict or {}).get("model_id"),
                    )
                _logger.warning(
                    "signal.publish.rate_limited",
                    payload={
                        "attempt": attempt,
                        "retry_after_s": retry_after,
                        "model_id": (body_dict or {}).get("model_id"),
                    },
                )
                await self._sleep_backoff(attempt, override_s=retry_after)
                continue

            # 400 validation: never retry.
            if resp.status_code == 400:
                body_dict = _safe_json(resp) or {}
                raise SignalValidationError(
                    body_dict.get("message")
                    or f"publish: server rejected batch ({resp.status_code})",
                    index=body_dict.get("index"),
                    field=body_dict.get("field"),
                    body=body_dict,
                )

            # 5xx: retryable.
            if 500 <= resp.status_code < 600:
                if attempt >= self._max_retries:
                    raise SignalServerError(
                        f"publish: server {resp.status_code} (retry budget exhausted)",
                        status_code=resp.status_code,
                        body=_safe_json(resp),
                    )
                _logger.warning(
                    "signal.publish.server_5xx",
                    payload={"attempt": attempt, "status": resp.status_code},
                )
                await self._sleep_backoff(attempt)
                continue

            # Other 4xx: surface as a generic server error.
            raise SignalServerError(
                f"publish: server rejected batch ({resp.status_code})",
                status_code=resp.status_code,
                body=_safe_json(resp),
            )

        # Loop exited without returning or raising — should not happen.
        raise SignalTransportError(
            "publish: unreachable retry-loop exit", last_error=last_transport
        )

    def _build_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _parse_accept(self, resp: httpx.Response) -> SignalAcceptResponse:
        body = _safe_json(resp) or {}
        try:
            accepted = int(body["accepted"])
            ack = body["ack"]
            batch_id = str(body["batch_id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SignalServerError(
                "publish: 200 response missing required fields",
                status_code=200,
                body=body,
            ) from exc
        if ack not in ("durable", "fast"):
            raise SignalServerError(
                f"publish: 200 response with unknown ack mode: {ack!r}",
                status_code=200,
                body=body,
            )
        _logger.info(
            "signal.publish.accepted",
            payload={"accepted": accepted, "ack": ack, "batch_id": batch_id},
        )
        return SignalAcceptResponse(accepted=accepted, ack=ack, batch_id=batch_id)

    async def _sleep_backoff(
        self, attempt: int, *, override_s: float | None = None
    ) -> None:
        if override_s is not None:
            delay = override_s
        else:
            exp = self._base_backoff_s * (2 ** (attempt - 1))
            capped = min(exp, self._max_backoff_s)
            # ±25% jitter — avoids thundering-herd retries.
            delay = capped * (1.0 + random.uniform(-0.25, 0.25))  # noqa: S311
        if delay > 0:
            await asyncio.sleep(delay)

    def _compute_retry_after_s(
        self, resp: httpx.Response, body: dict[str, Any] | None
    ) -> float | None:
        """Pick the longer of ``Retry-After`` header and body's
        ``retry_after_ms``, so we never under-wait the server."""
        candidates: list[float] = []
        header_val = resp.headers.get("Retry-After")
        if header_val is not None:
            with contextlib.suppress(ValueError):
                candidates.append(float(header_val))
        if body is not None:
            ms = body.get("retry_after_ms")
            if isinstance(ms, int | float):
                candidates.append(float(ms) / 1000.0)
        if not candidates:
            return None
        return max(candidates)


def _safe_json(resp: httpx.Response) -> dict[str, Any] | None:
    """Decode a JSON body, returning ``None`` on parse failure."""
    try:
        body = resp.json()
    except (ValueError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


__all__ = [
    "DEFAULT_INGRESS_URL",
    "TOKEN_ENV_VAR",
    "SignalPublisher",
]
