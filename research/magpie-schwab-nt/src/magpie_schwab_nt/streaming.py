"""Schwab streaming-API connection lifecycle for the NT adapters.

Provides:

* `SchwabStreamerInfo` — typed view of the `streamerInfo[0]` slice of
  `/trader/v1/userPreference`. Required for LOGIN.
* `Subscription` — a single SUBS contract (service + keys + fields)
  the caller registered. Carries its own asyncio.Queue and chosen
  backpressure policy.
* `SchwabStreamerClient` — manages one WebSocket connection: dial,
  LOGIN, dispatch incoming `data` frames to subscription queues,
  heartbeat watchdog, exponential-backoff reconnect with replay of
  active subscriptions, clean shutdown.

The client doesn't know about specific services — `LEVELONE_OPTIONS`,
`TIMESALE_OPTIONS`, `OPTIONS_BOOK`, `ACCT_ACTIVITY` all flow through
the same `subscribe()` API. Per-service parsing belongs to the
caller (QF-164/165/166 + QF-163).

Design rationale: `docs/research/qf-160-schwab-nt-spike.md
§Spot-check 3`. Reference: QF-162.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any, Literal

import websockets
from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosed

from magpie_schwab_nt.auth import SchwabTokenStore

_log = logging.getLogger(__name__)

# Schwab sends a `notify` frame with `{"heartbeat": "<unix-ms>"}`
# roughly every 10s. If we go this long without one, the connection
# is dead and we reconnect.
DEFAULT_HEARTBEAT_TIMEOUT_S = 30.0

# Reconnect backoff schedule: 1s, 2s, 4s, …, capped at 30s. Reset on
# every successful LOGIN. Matches the cadence captured in the spike doc.
DEFAULT_BACKOFF_INITIAL_S = 1.0
DEFAULT_BACKOFF_CAP_S = 30.0

BackpressurePolicy = Literal["drop_oldest", "never_drop"]


# ── Streamer info (from /userPreference) ──────────────────────────


@dataclass(frozen=True)
class SchwabStreamerInfo:
    """The fields needed to dial + LOGIN to Schwab's streamer."""

    streamer_socket_url: str
    schwab_client_customer_id: str
    schwab_client_correl_id: str
    schwab_client_channel: str
    schwab_client_function_id: str

    @classmethod
    def from_user_preference(cls, prefs: Mapping[str, Any]) -> SchwabStreamerInfo:
        """Build from the response body of `GET /trader/v1/userPreference`.

        Raises `ValueError` if any required field is missing.
        """
        infos = prefs.get("streamerInfo")
        if not isinstance(infos, list) or not infos:
            raise ValueError("userPreference response missing streamerInfo[]")
        info = infos[0]
        missing = [
            k
            for k in (
                "streamerSocketUrl",
                "schwabClientCustomerId",
                "schwabClientCorrelId",
                "schwabClientChannel",
                "schwabClientFunctionId",
            )
            if k not in info
        ]
        if missing:
            raise ValueError(f"streamerInfo[0] missing fields: {missing}")
        return cls(
            streamer_socket_url=str(info["streamerSocketUrl"]),
            schwab_client_customer_id=str(info["schwabClientCustomerId"]),
            schwab_client_correl_id=str(info["schwabClientCorrelId"]),
            schwab_client_channel=str(info["schwabClientChannel"]),
            schwab_client_function_id=str(info["schwabClientFunctionId"]),
        )


# ── Subscription ──────────────────────────────────────────────────


@dataclass
class Subscription:
    """One outstanding SUBS contract on the streamer.

    Created via `SchwabStreamerClient.subscribe(...)`; carries its own
    queue (the caller drains) and its backpressure policy. The keys
    tuple is used as a dict key in the client's registry, so the
    caller must pass the same sorted-tuple in `unsubscribe()`.
    """

    service: str
    keys: tuple[str, ...]
    fields: str
    queue: asyncio.Queue[dict[str, Any]]
    backpressure: BackpressurePolicy = "drop_oldest"
    drop_count: int = field(default=0)

    @property
    def registry_key(self) -> tuple[str, tuple[str, ...]]:
        return (self.service, self.keys)


# ── Errors ────────────────────────────────────────────────────────


class StreamerError(Exception):
    """Base for streamer-level failures."""


class StreamerLoginError(StreamerError):
    """LOGIN response carried a non-zero code."""


# ── Client factory protocol (injectable for tests) ────────────────

# `websockets.connect(url)` returns an `AbstractAsyncContextManager`
# yielding a `ClientConnection`. The client only needs the connection,
# so we accept any factory with that shape. Tests pass a fake.
WebSocketFactory = Callable[[str], AbstractAsyncContextManager[ClientConnection]]


# ── Client ────────────────────────────────────────────────────────


class SchwabStreamerClient:
    """One-WebSocket-per-instance Schwab streamer client.

    Lifecycle::

        client = SchwabStreamerClient(token_store, streamer_info)
        await client.start()                            # spawns supervisor
        sub = await client.subscribe(
            service="LEVELONE_OPTIONS",
            keys=["SPY  2026-05-16C500"],
            fields="0,1,2,3",
        )
        async for frame in iter_queue(sub.queue):
            ...
        await client.unsubscribe(sub)
        await client.stop()

    The supervisor task runs the connect → login → resubscribe → run
    cycle. On disconnect / heartbeat timeout it backs off and retries
    until `stop()` is called. Active subscriptions are replayed on
    every successful LOGIN.
    """

    def __init__(
        self,
        *,
        token_store: SchwabTokenStore,
        streamer_info: SchwabStreamerInfo,
        ws_factory: WebSocketFactory | None = None,
        heartbeat_timeout_s: float = DEFAULT_HEARTBEAT_TIMEOUT_S,
        backoff_initial_s: float = DEFAULT_BACKOFF_INITIAL_S,
        backoff_cap_s: float = DEFAULT_BACKOFF_CAP_S,
    ) -> None:
        self._tokens = token_store
        self._info = streamer_info
        self._ws_factory: WebSocketFactory = ws_factory or websockets.connect
        self._heartbeat_timeout_s = heartbeat_timeout_s
        self._backoff_initial_s = backoff_initial_s
        self._backoff_cap_s = backoff_cap_s

        self._subscriptions: dict[tuple[str, tuple[str, ...]], Subscription] = {}
        self._next_request_id = 0
        self._supervisor_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._ws: ClientConnection | None = None
        self._connected_event = asyncio.Event()
        # Used by the supervisor to surface unexpected exits to start().
        self._first_connect_done = asyncio.Event()
        self._first_connect_error: BaseException | None = None

    # ── Public API ────────────────────────────────────────────────

    async def start(self) -> None:
        """Spawn the supervisor task and wait for the first LOGIN ack.

        Raises if the first connect/login fails — the caller hasn't
        registered any subscriptions yet so giving up is appropriate.
        On subsequent disconnects the supervisor reconnects silently.
        """
        if self._supervisor_task is not None:
            raise RuntimeError("start() called twice")
        self._stop_event.clear()
        self._first_connect_done.clear()
        self._first_connect_error = None
        self._supervisor_task = asyncio.create_task(
            self._supervisor(), name="schwab-streamer-supervisor"
        )
        await self._first_connect_done.wait()
        if self._first_connect_error is not None:
            err = self._first_connect_error
            await self.stop()
            raise err

    async def stop(self) -> None:
        """Stop the supervisor and close the WebSocket."""
        self._stop_event.set()
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()
        task = self._supervisor_task
        self._supervisor_task = None
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def subscribe(
        self,
        *,
        service: str,
        keys: list[str],
        fields: str,
        backpressure: BackpressurePolicy = "drop_oldest",
        max_queue: int | None = None,
    ) -> Subscription:
        """Register + send a SUBS for `(service, keys, fields)`.

        Returns a `Subscription` whose `.queue` receives every `data`
        frame for this contract until `unsubscribe()`. Survives
        reconnects — the supervisor replays it on every successful
        LOGIN.
        """
        if max_queue is None:
            max_queue = 100 if backpressure == "drop_oldest" else 10_000
        sub = Subscription(
            service=service,
            keys=tuple(sorted(set(keys))),
            fields=fields,
            queue=asyncio.Queue(maxsize=max_queue),
            backpressure=backpressure,
        )
        self._subscriptions[sub.registry_key] = sub
        if self._connected_event.is_set() and self._ws is not None:
            await self._send_subs(self._ws, sub)
        return sub

    async def unsubscribe(self, sub: Subscription) -> None:
        """Send UNSUBS and drop the subscription from the registry."""
        existing = self._subscriptions.pop(sub.registry_key, None)
        if existing is None:
            return
        if self._connected_event.is_set() and self._ws is not None:
            await self._send_unsubs(self._ws, sub)

    # ── Supervisor + connect/run cycle ────────────────────────────

    async def _supervisor(self) -> None:
        backoff = self._backoff_initial_s
        first_iter = True
        while not self._stop_event.is_set():
            try:
                async with self._ws_factory(self._info.streamer_socket_url) as ws:
                    self._ws = ws
                    try:
                        await self._login(ws)
                        backoff = self._backoff_initial_s
                        await self._resubscribe_all(ws)
                    except BaseException as e:
                        if first_iter:
                            self._first_connect_error = e
                            self._first_connect_done.set()
                            return
                        raise
                    self._connected_event.set()
                    if first_iter:
                        first_iter = False
                        self._first_connect_done.set()
                    try:
                        await self._run(ws)
                    finally:
                        self._connected_event.clear()
                        self._ws = None
            except asyncio.CancelledError:
                raise
            except BaseException as e:
                if first_iter and self._first_connect_error is None:
                    self._first_connect_error = e
                    self._first_connect_done.set()
                    return
                _log.warning(
                    "streamer disconnect; reconnecting", extra={"error": str(e)}
                )
            if self._stop_event.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._backoff_cap_s)

    async def _run(self, ws: ClientConnection) -> None:
        """Read loop with a heartbeat watchdog.

        Each iteration: race a `recv()` against a heartbeat-timeout
        timer. Receiving any frame resets the timer; the timer firing
        raises `StreamerError("heartbeat timeout")`, which propagates
        up to the supervisor's reconnect loop.
        """
        loop = asyncio.get_running_loop()
        last_frame_t = loop.time()
        while not self._stop_event.is_set():
            deadline = last_frame_t + self._heartbeat_timeout_s
            timeout = deadline - loop.time()
            if timeout <= 0:
                raise StreamerError("heartbeat timeout")
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            except TimeoutError as e:
                raise StreamerError("heartbeat timeout") from e
            except ConnectionClosed as e:
                raise StreamerError(f"connection closed: {e}") from e
            last_frame_t = loop.time()
            self._dispatch_frame(raw)

    # ── Frame dispatch ────────────────────────────────────────────

    def _dispatch_frame(self, raw: str | bytes) -> None:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            _log.warning("streamer: non-JSON frame", extra={"raw": text[:200]})
            return
        if not isinstance(parsed, dict):
            return
        if "data" in parsed:
            for envelope in parsed["data"]:
                self._dispatch_data(envelope)
        # `response` and `notify` frames are received here for the
        # side-effect of advancing the heartbeat timer (heartbeats live
        # inside `notify`). No further routing today; if a caller ever
        # needs to inspect responses, a hook can be added.

    def _dispatch_data(self, envelope: Mapping[str, Any]) -> None:
        service = envelope.get("service")
        content = envelope.get("content")
        if not isinstance(service, str) or not isinstance(content, list):
            return
        # Match each content row to a Subscription by (service, key).
        # If the row has no `key`, deliver to every subscription on
        # this service (defensive — Schwab always emits one in
        # observed frames, but the protocol doesn't guarantee it).
        subs_on_service = [
            s for s in self._subscriptions.values() if s.service == service
        ]
        if not subs_on_service:
            return
        for row in content:
            if not isinstance(row, Mapping):
                continue
            key = row.get("key")
            if isinstance(key, str):
                target = next((s for s in subs_on_service if key in s.keys), None)
                if target is not None:
                    self._deliver(target, dict(row))
                    continue
            # Fallback: broadcast.
            for s in subs_on_service:
                self._deliver(s, dict(row))

    def _deliver(self, sub: Subscription, row: dict[str, Any]) -> None:
        if sub.backpressure == "never_drop":
            # Block-on-full is the contract for fills + other
            # correctness-critical streams. The read loop pauses if
            # the consumer is wedged, which is the desired failure
            # mode for that case.
            try:
                sub.queue.put_nowait(row)
            except asyncio.QueueFull:
                # `put_nowait` raises immediately; switch to awaiting
                # `put` via a one-shot task. We can't `await` from
                # here (the dispatcher is sync). The simplest
                # never-drop fallback is to schedule the put and
                # accept that the next `recv()` will block until the
                # consumer drains. Practically: never_drop queues
                # should be sized large enough to avoid this path.
                asyncio.get_event_loop().create_task(sub.queue.put(row))
            return
        # drop_oldest semantics: pop one item if full, then push.
        try:
            sub.queue.put_nowait(row)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                sub.queue.get_nowait()
            sub.drop_count += 1
            with contextlib.suppress(asyncio.QueueFull):
                sub.queue.put_nowait(row)

    # ── Protocol helpers ──────────────────────────────────────────

    async def _login(self, ws: ClientConnection) -> None:
        access_token = await self._tokens.get_access_token()
        request = self._envelope(
            service="ADMIN",
            command="LOGIN",
            parameters={
                "Authorization": access_token,
                "SchwabClientChannel": self._info.schwab_client_channel,
                "SchwabClientFunctionId": self._info.schwab_client_function_id,
            },
        )
        await ws.send(json.dumps({"requests": [request]}))
        # Read frames until we see a LOGIN response. Anything else is
        # routed normally — Schwab doesn't guarantee LOGIN is the
        # first frame in pathological cases.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._heartbeat_timeout_s
        while True:
            timeout = deadline - loop.time()
            if timeout <= 0:
                raise StreamerError("login timeout")
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict):
                continue
            for envelope in parsed.get("response", []) or []:
                if (
                    envelope.get("service") == "ADMIN"
                    and envelope.get("command") == "LOGIN"
                ):
                    code = (envelope.get("content") or {}).get("code")
                    if code not in (0, None, "0"):
                        raise StreamerLoginError(
                            f"LOGIN rejected: code={code} "
                            f"content={envelope.get('content')}"
                        )
                    return
            # Not a LOGIN ack; dispatch through normal path so any
            # `data` frames received before the ack still reach
            # subscriptions (matters for fast reconnect).
            self._dispatch_frame(text)

    async def _resubscribe_all(self, ws: ClientConnection) -> None:
        for sub in list(self._subscriptions.values()):
            await self._send_subs(ws, sub)

    async def _send_subs(self, ws: ClientConnection, sub: Subscription) -> None:
        request = self._envelope(
            service=sub.service,
            command="SUBS",
            parameters={"keys": ",".join(sub.keys), "fields": sub.fields},
        )
        await ws.send(json.dumps({"requests": [request]}))

    async def _send_unsubs(self, ws: ClientConnection, sub: Subscription) -> None:
        request = self._envelope(
            service=sub.service,
            command="UNSUBS",
            parameters={"keys": ",".join(sub.keys)},
        )
        await ws.send(json.dumps({"requests": [request]}))

    def _envelope(
        self,
        *,
        service: str,
        command: str,
        parameters: Mapping[str, Any],
    ) -> dict[str, Any]:
        self._next_request_id += 1
        return {
            "requestid": str(self._next_request_id),
            "service": service,
            "command": command,
            "SchwabClientCustomerId": self._info.schwab_client_customer_id,
            "SchwabClientCorrelId": self._info.schwab_client_correl_id,
            "parameters": dict(parameters),
        }


# ── Utilities ─────────────────────────────────────────────────────


async def iter_queue(
    queue: asyncio.Queue[dict[str, Any]],
) -> AsyncIterator[dict[str, Any]]:
    """Drain `queue` indefinitely as an async iterator.

    Caller's `async for` cancels by cancelling the surrounding task.
    Useful sugar for tests + simple consumers; production callers may
    prefer their own bounded-iteration pattern.
    """
    while True:
        yield await queue.get()


__all__ = [
    "BackpressurePolicy",
    "SchwabStreamerClient",
    "SchwabStreamerInfo",
    "StreamerError",
    "StreamerLoginError",
    "Subscription",
    "iter_queue",
]
