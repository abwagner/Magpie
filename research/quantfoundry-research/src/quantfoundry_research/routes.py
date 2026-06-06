"""FastAPI router — ``/jobs`` endpoints.

The router accepts a :class:`JobStore` + :class:`WorkerPool` via
dependency injection so tests can swap in the synchronous pool and
a fresh store per test. Production wiring (in :mod:`app`) uses the
async stub pool by default; the next PR swaps it for a real pool.

Endpoints
=========

* ``POST /jobs``           — submit a job, returns :class:`JobAccepted`.
* ``GET  /jobs``           — list all jobs, optional ``state=`` filter.
* ``GET  /jobs/{job_id}``  — poll a single job's :class:`JobStatus`.

FastAPI generates the OpenAPI schema from the typed signatures, so
``/openapi.json`` and ``/docs`` are the authoritative reference.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from quantfoundry_logging import get_logger

from quantfoundry_research.config import (
    JobAccepted,
    JobList,
    JobState,
    JobStatus,
    JobSubmission,
)
from quantfoundry_research.events import EventPublisher
from quantfoundry_research.jobs import JobStore
from quantfoundry_research.workers import WorkerPool

_logger = get_logger("quantfoundry-research")


# ── Dependency placeholders ─────────────────────────────────────────
#
# These exist only as targets for ``dependency_overrides`` in the app
# factory; ``Depends(get_store)`` and ``Depends(get_pool)`` route
# calls land on the instances the app set up.


def get_store() -> JobStore:  # pragma: no cover — override target only
    raise RuntimeError("JobStore dependency not configured")


def get_pool() -> WorkerPool:  # pragma: no cover — override target only
    raise RuntimeError("WorkerPool dependency not configured")


def get_events() -> EventPublisher:  # pragma: no cover — override target only
    raise RuntimeError("EventPublisher dependency not configured")


# ── Router ──────────────────────────────────────────────────────────


router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post(
    "",
    response_model=JobAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit a backtest job",
    description=(
        "Accepts a single backtest configuration and queues it for "
        "execution by the worker pool. Returns a job id the caller "
        "can poll for status. Grid + walk-forward submissions are "
        "not yet supported by the skeleton."
    ),
)
async def submit_job(
    submission: JobSubmission,
    store: Annotated[JobStore, Depends(get_store)],
    pool: Annotated[WorkerPool, Depends(get_pool)],
    events: Annotated[EventPublisher, Depends(get_events)],
) -> JobAccepted:
    if submission.kind != "single":
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                f"job kind {submission.kind!r} not yet supported by the "
                "orchestrator skeleton (only 'single' for now)"
            ),
        )

    initial = await store.submit(
        config=submission.config,
        correlation_id=submission.correlation_id,
    )
    _logger.info(
        "job.submitted",
        payload={
            "job_id": initial.job_id,
            "strategy_id": submission.config.strategy_id,
            "strategy_version": submission.config.strategy_version,
            "portfolio": submission.config.portfolio,
            "kind": submission.kind,
        },
    )
    await events.publish_status(initial)
    await pool.dispatch(job_id=initial.job_id, store=store, events=events)
    return JobAccepted(
        job_id=initial.job_id,
        state=initial.state,
        submitted_at=initial.submitted_at,
    )


@router.get(
    "",
    response_model=JobList,
    summary="List jobs",
    description=(
        "Returns every job the orchestrator has seen during this "
        "process's lifetime, optionally filtered by ``state``. The "
        "skeleton's store is in-memory and resets on process restart."
    ),
)
async def list_jobs(
    store: Annotated[JobStore, Depends(get_store)],
    state: Annotated[
        JobState | None,
        Query(description="Filter to a single state if set."),
    ] = None,
) -> JobList:
    jobs = await store.list(state=state)
    return JobList(jobs=jobs)


@router.get(
    "/{job_id}",
    response_model=JobStatus,
    summary="Poll a single job's status",
    responses={404: {"description": "job not found"}},
)
async def get_job(
    job_id: str,
    store: Annotated[JobStore, Depends(get_store)],
) -> JobStatus:
    record = await store.get(job_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"job {job_id} not found",
        )
    return record


__all__ = ["get_events", "get_pool", "get_store", "router"]
