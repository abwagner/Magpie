"""Event publisher — fan jobs-lifecycle events out to NATS subjects.

The orchestrator emits three logical events:

* **status** — every state transition on a job. Payload is the
  :class:`JobStatus` model serialised to JSON. Published on
  ``research.jobs.status.<job_id>``.
* **result** — terminal-state result. Payload is the :class:`JobResult`
  serialised to JSON. Published on ``research.jobs.result.<job_id>``.
* **write_results** — the same result wrapped in a
  :class:`ResultEnvelope` for the server-side DuckDB writer.
  Published on ``data.write.results``.

This module ships three publisher implementations:

* :class:`NatsEventPublisher` — production. Routes events to the
  injected :class:`NatsAdapter`. Logs (but does not raise) on
  publish failure — the orchestrator's job state of record is the
  in-memory :class:`JobStore`; NATS publish failures are
  *informational* loss (consumers miss this update), not a job
  failure.
* :class:`NullEventPublisher` — default. Drops every event silently.
  Used by tests and CLI invocations that don't care about NATS.
* :class:`CapturingEventPublisher` — test helper. Records every
  emission for assertions.

The publisher API is intentionally async + narrow so swapping
implementations is mechanical. Callers never see :class:`NatsAdapter`
directly.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict
from quantfoundry_logging import get_logger

from quantfoundry_research.config import JobResult, JobStatus
from quantfoundry_research.nats import (
    DATA_WRITE_RESULTS_SUBJECT,
    NatsAdapter,
    result_subject,
    status_subject,
)

_logger = get_logger("quantfoundry-research")


# ── Wire-payload envelope ──────────────────────────────────────────


class ResultEnvelope(BaseModel):
    """Wrapped :class:`JobResult` for the ``data.write.results``
    subject.

    Carries the result payload plus producer metadata so the
    server-side DuckDB writer can deduplicate (``job_id``), trace
    (``correlation_id``), and timestamp (``published_at``) without
    repeating itself for every consumer.
    """

    model_config = ConfigDict(extra="forbid")

    job_id: str
    correlation_id: str | None
    published_at: str
    producer: str = "quantfoundry-research"
    result: JobResult


# ── Publisher interface ────────────────────────────────────────────


class EventPublisher(abc.ABC):
    """Fan job-lifecycle events to wire subjects."""

    @abc.abstractmethod
    async def publish_status(self, status: JobStatus) -> None: ...

    @abc.abstractmethod
    async def publish_result(self, status: JobStatus) -> None: ...

    @abc.abstractmethod
    async def publish_write_results(self, status: JobStatus) -> None: ...


# ── Null implementation (default) ──────────────────────────────────


class NullEventPublisher(EventPublisher):
    """No-op publisher. The default when no NATS adapter is wired."""

    async def publish_status(self, status: JobStatus) -> None:
        return

    async def publish_result(self, status: JobStatus) -> None:
        return

    async def publish_write_results(self, status: JobStatus) -> None:
        return


# ── Capturing implementation (tests) ───────────────────────────────


@dataclass
class CapturedEvent:
    """Record of one publish call. Used by tests."""

    kind: str  # "status" / "result" / "write_results"
    job_id: str
    status: JobStatus


class CapturingEventPublisher(EventPublisher):
    """Append-only record of every publish, in chronological order."""

    def __init__(self) -> None:
        self.events: list[CapturedEvent] = []

    async def publish_status(self, status: JobStatus) -> None:
        self.events.append(
            CapturedEvent(kind="status", job_id=status.job_id, status=status)
        )

    async def publish_result(self, status: JobStatus) -> None:
        self.events.append(
            CapturedEvent(kind="result", job_id=status.job_id, status=status)
        )

    async def publish_write_results(self, status: JobStatus) -> None:
        self.events.append(
            CapturedEvent(kind="write_results", job_id=status.job_id, status=status)
        )

    def kinds(self, job_id: str | None = None) -> list[str]:
        """Return the ordered event-kind list, optionally filtered to one job."""
        return [e.kind for e in self.events if job_id is None or e.job_id == job_id]


# ── NATS implementation (production) ───────────────────────────────


class NatsEventPublisher(EventPublisher):
    """Publishes every event to the injected NATS adapter.

    Each publish is best-effort. A failure is logged but doesn't
    raise — the in-memory :class:`JobStore` is the authoritative
    state; a dropped NATS message is a consumer's missed update, not
    a job error. This matches the "fire-and-forget" semantic the
    TDD specifies for status updates.
    """

    def __init__(self, adapter: NatsAdapter) -> None:
        self._adapter = adapter

    async def publish_status(self, status: JobStatus) -> None:
        await self._publish_safely(
            subject=status_subject(status.job_id),
            payload=status.model_dump_json().encode("utf-8"),
            kind="status",
            job_id=status.job_id,
        )

    async def publish_result(self, status: JobStatus) -> None:
        if status.result is None:
            _logger.warning(
                "event.publish_result.skipped_no_result",
                payload={"job_id": status.job_id, "state": status.state},
            )
            return
        await self._publish_safely(
            subject=result_subject(status.job_id),
            payload=status.result.model_dump_json().encode("utf-8"),
            kind="result",
            job_id=status.job_id,
        )

    async def publish_write_results(self, status: JobStatus) -> None:
        if status.result is None:
            _logger.warning(
                "event.publish_write_results.skipped_no_result",
                payload={"job_id": status.job_id, "state": status.state},
            )
            return
        envelope = ResultEnvelope(
            job_id=status.job_id,
            correlation_id=status.correlation_id,
            published_at=_now_iso(),
            result=status.result,
        )
        await self._publish_safely(
            subject=DATA_WRITE_RESULTS_SUBJECT,
            payload=envelope.model_dump_json().encode("utf-8"),
            kind="write_results",
            job_id=status.job_id,
        )

    async def _publish_safely(
        self,
        *,
        subject: str,
        payload: bytes,
        kind: str,
        job_id: str,
    ) -> None:
        try:
            await self._adapter.publish(subject, payload)
        except Exception as exc:  # noqa: BLE001 — publish boundary catches all
            _logger.warning(
                "event.publish.failed",
                payload={
                    "kind": kind,
                    "job_id": job_id,
                    "subject": subject,
                    "error": str(exc),
                },
            )


# ── Helpers ────────────────────────────────────────────────────────


def _now_iso() -> str:
    return (
        datetime.now(tz=UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    )


__all__ = [
    "CapturedEvent",
    "CapturingEventPublisher",
    "EventPublisher",
    "NatsEventPublisher",
    "NullEventPublisher",
    "ResultEnvelope",
]
