"""NATS adapter abstraction.

The orchestrator talks to NATS through a minimal :class:`NatsAdapter`
interface so production code (uses ``nats-py``) and tests (use the
in-memory adapter) share the same call sites.

What the orchestrator needs from NATS in v1:

* **Publish a payload to a subject.** Status updates, results, and
  the ``data.write.results`` envelope all flow this way. Async, fire-
  and-forget — no per-publish ack at this layer; durability is the
  server-side consumer's concern.
* **Health check.** Tests want to know "is the underlying connection
  open" so they can skip if it's a real-NATS test without a broker
  available.

Consuming subscriptions (e.g. ``research.jobs.submit`` for cross-
process submissions) is deferred — when the orchestrator gains a
real submit consumer, we'll extend :class:`NatsAdapter` with
``subscribe()`` then.

Reference: ``docs/polyglot-migration-tdd.md §5.2.1`` (NATS topology).
"""

from __future__ import annotations

import abc
import asyncio
import json
from collections.abc import Callable
from typing import Any

from magpie_logging import get_logger

_logger = get_logger("magpie-research")


# ── Adapter interface ───────────────────────────────────────────────


class NatsAdapter(abc.ABC):
    """Minimal NATS surface the orchestrator depends on."""

    @abc.abstractmethod
    async def publish(self, subject: str, payload: bytes) -> None:
        """Send ``payload`` to ``subject``. Fire-and-forget."""

    @abc.abstractmethod
    async def aclose(self) -> None:
        """Tear down the underlying connection."""

    @property
    @abc.abstractmethod
    def is_connected(self) -> bool:
        """``True`` when the adapter holds a usable connection."""


# ── In-memory adapter (tests) ───────────────────────────────────────


SubjectListener = Callable[[str, bytes], None]


class InMemoryNatsAdapter(NatsAdapter):
    """No-broker adapter — published messages are routed in-process
    to registered listeners. Tests use this to assert on the exact
    subjects + payloads the orchestrator emits without standing up a
    real NATS server.

    Subscription semantics are intentionally minimal:

    * ``register_listener(prefix, fn)`` attaches a callback that fires
      synchronously on every publish whose subject starts with
      ``prefix``. Empty prefix catches everything.
    * Published messages are also accumulated in :attr:`published`
      (a list of ``(subject, payload)`` tuples) so tests can assert
      on the full history without registering a listener.
    """

    def __init__(self) -> None:
        self.published: list[tuple[str, bytes]] = []
        self._listeners: list[tuple[str, SubjectListener]] = []
        self._closed = False

    async def publish(self, subject: str, payload: bytes) -> None:
        if self._closed:
            raise RuntimeError("InMemoryNatsAdapter: closed")
        self.published.append((subject, payload))
        for prefix, fn in self._listeners:
            if subject.startswith(prefix):
                fn(subject, payload)

    async def aclose(self) -> None:
        self._closed = True

    @property
    def is_connected(self) -> bool:
        return not self._closed

    def register_listener(self, prefix: str, fn: SubjectListener) -> None:
        """Attach a sync callback fired on each matching publish."""
        self._listeners.append((prefix, fn))

    def history(self, *, subject_prefix: str = "") -> list[tuple[str, dict[str, Any]]]:
        """Convenience: parse every recorded message as JSON and
        return the (subject, decoded) pairs that match ``subject_prefix``.

        Raises on payloads that aren't valid JSON — the orchestrator's
        emissions are all JSON, so anything else is a bug a test
        wants to fail on.
        """
        out: list[tuple[str, dict[str, Any]]] = []
        for subject, payload in self.published:
            if not subject.startswith(subject_prefix):
                continue
            decoded = json.loads(payload.decode("utf-8"))
            if not isinstance(decoded, dict):
                raise TypeError(f"non-object JSON payload on {subject!r}")
            out.append((subject, decoded))
        return out


# ── Real adapter (production) ───────────────────────────────────────


DEFAULT_NATS_URL = "nats://localhost:4222"


class RealNatsAdapter(NatsAdapter):
    """``nats-py``-backed adapter for production.

    Connects on first :meth:`publish`. Reconnection is the underlying
    client's job — ``nats-py`` reconnects with exponential backoff by
    default. If a publish lands before the reconnect finishes the
    call raises; the orchestrator's worker pool surfaces that as a
    "job failed" rather than retrying the publish itself.

    Constructed via :meth:`connect` (async) — keep the synchronous
    ``__init__`` minimal so tests can build an adapter without an
    event loop running.
    """

    def __init__(self, url: str = DEFAULT_NATS_URL) -> None:
        self._url = url
        self._nc: Any = None  # nats.aio.client.Client (untyped)
        self._lock = asyncio.Lock()

    @classmethod
    async def connect(cls, url: str = DEFAULT_NATS_URL) -> RealNatsAdapter:
        adapter = cls(url=url)
        await adapter._ensure_connected()
        return adapter

    async def _ensure_connected(self) -> None:
        if self._nc is not None and not self._nc.is_closed:
            return
        async with self._lock:
            if self._nc is not None and not self._nc.is_closed:
                return
            # Import lazily so importing this module doesn't pull
            # nats-py into every test process unless it's actually
            # used.
            import nats  # noqa: PLC0415 — runtime import is deliberate

            self._nc = await nats.connect(self._url)
            _logger.info(
                "nats.connected",
                payload={"url": self._url, "client_id": str(self._nc.client_id)},
            )

    async def publish(self, subject: str, payload: bytes) -> None:
        await self._ensure_connected()
        assert self._nc is not None
        await self._nc.publish(subject, payload)

    async def aclose(self) -> None:
        if self._nc is None:
            return
        try:
            await self._nc.drain()
        finally:
            self._nc = None

    @property
    def is_connected(self) -> bool:
        return self._nc is not None and not self._nc.is_closed


# ── Subjects ───────────────────────────────────────────────────────


def status_subject(job_id: str) -> str:
    """``research.jobs.status.<job_id>`` — per-job status update."""
    return f"research.jobs.status.{job_id}"


def result_subject(job_id: str) -> str:
    """``research.jobs.result.<job_id>`` — per-job final result."""
    return f"research.jobs.result.{job_id}"


DATA_WRITE_RESULTS_SUBJECT = "data.write.results"
"""Subject the TS server consumes to commit results to DuckDB."""


__all__ = [
    "DATA_WRITE_RESULTS_SUBJECT",
    "DEFAULT_NATS_URL",
    "InMemoryNatsAdapter",
    "NatsAdapter",
    "RealNatsAdapter",
    "SubjectListener",
    "result_subject",
    "status_subject",
]
