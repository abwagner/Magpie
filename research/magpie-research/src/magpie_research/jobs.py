"""In-memory job store.

The skeleton (QF-110) keeps job state in process memory — submitted
jobs go through pending → running → completed (or failed) and stay
queryable for the lifetime of the orchestrator process. A future PR
swaps this for the durable store the real worker pool needs (likely
DuckDB or NATS KV).

The store is the *only* place job state changes happen, so the
worker pool, the route handlers, and any internal supervisors all go
through it. That keeps state-transition rules in one file.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from magpie_research.config import (
    BacktestRunConfig,
    JobResult,
    JobState,
    JobStatus,
)


def _now_iso() -> str:
    """RFC-3339 UTC timestamp with microsecond precision."""
    return (
        datetime.now(tz=UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    )


class JobStore:
    """Per-process store of submitted jobs + their state.

    All transitions are guarded by an :class:`asyncio.Lock` so concurrent
    workers + route handlers can't race on the same job record. The
    lock is cheap (no I/O inside it) so contention should be invisible
    for any realistic submit/poll rate.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, JobStatus] = {}
        self._configs: dict[str, BacktestRunConfig] = {}
        self._lock = asyncio.Lock()

    async def submit(
        self,
        *,
        config: BacktestRunConfig,
        correlation_id: str | None = None,
    ) -> JobStatus:
        """Add a new pending job. Returns the immutable initial status."""
        job_id = uuid.uuid4().hex
        status = JobStatus(
            job_id=job_id,
            state="pending",
            submitted_at=_now_iso(),
            correlation_id=correlation_id,
        )
        async with self._lock:
            self._jobs[job_id] = status
            self._configs[job_id] = config
        return status

    async def mark_running(self, job_id: str) -> JobStatus:
        """Transition pending → running. Idempotent on running."""
        async with self._lock:
            current = self._require(job_id)
            if current.state in ("completed", "failed"):
                raise ValueError(
                    f"job {job_id}: cannot transition from {current.state} to running"
                )
            updated = current.model_copy(
                update={"state": "running", "started_at": _now_iso()}
            )
            self._jobs[job_id] = updated
            return updated

    async def mark_completed(
        self,
        job_id: str,
        *,
        result: JobResult,
    ) -> JobStatus:
        """Transition running → completed with a result."""
        async with self._lock:
            current = self._require(job_id)
            if current.state == "failed":
                raise ValueError(
                    f"job {job_id}: cannot complete a job already marked failed"
                )
            updated = current.model_copy(
                update={
                    "state": "completed",
                    "completed_at": _now_iso(),
                    "result": result,
                }
            )
            self._jobs[job_id] = updated
            return updated

    async def mark_failed(self, job_id: str, *, error: str) -> JobStatus:
        """Transition to failed with an error message."""
        async with self._lock:
            current = self._require(job_id)
            if current.state == "completed":
                raise ValueError(
                    f"job {job_id}: cannot fail a job already marked completed"
                )
            updated = current.model_copy(
                update={
                    "state": "failed",
                    "completed_at": _now_iso(),
                    "error": error,
                }
            )
            self._jobs[job_id] = updated
            return updated

    async def get(self, job_id: str) -> JobStatus | None:
        async with self._lock:
            return self._jobs.get(job_id)

    async def config_of(self, job_id: str) -> BacktestRunConfig | None:
        async with self._lock:
            return self._configs.get(job_id)

    async def list(self, *, state: JobState | None = None) -> list[JobStatus]:
        """Return jobs in insertion order, optionally filtered by state."""
        async with self._lock:
            jobs = list(self._jobs.values())
        if state is not None:
            return [j for j in jobs if j.state == state]
        return jobs

    def _require(self, job_id: str) -> JobStatus:
        existing = self._jobs.get(job_id)
        if existing is None:
            raise KeyError(f"job {job_id}: not found")
        return existing


# ── Module-level helpers ──────────────────────────────────────────


def serialise_for_test(status: JobStatus) -> dict[str, Any]:
    """Convenience shim used in tests; the real API serialises via
    FastAPI's pydantic integration."""
    return status.model_dump(mode="json")


__all__ = ["JobStore", "serialise_for_test"]
