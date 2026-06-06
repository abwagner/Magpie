"""FastAPI application factory.

Two entry points:

* :func:`create_app` — build a wired-up FastAPI instance from an
  injected :class:`JobStore` + :class:`WorkerPool` +
  :class:`EventPublisher`. Used by tests + custom hosts that want to
  control lifecycle.
* :func:`create_default_app` — convenience for the CLI: a fresh
  in-memory store + the async :class:`StubWorkerPool` + a
  :class:`NullEventPublisher` (or a :class:`NatsEventPublisher` if a
  NATS URL is passed). Suitable for local development.

OpenAPI schema is auto-published by FastAPI at ``/openapi.json``
(JSON) and ``/docs`` (Swagger UI). ``/healthz`` is a tiny
liveness probe.

The app factory also installs the orchestrator's architectural
guards — see :func:`quantfoundry_research.guards.assert_no_duckdb_writes`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from quantfoundry_logging import get_logger

from quantfoundry_research.events import (
    EventPublisher,
    NatsEventPublisher,
    NullEventPublisher,
)
from quantfoundry_research.guards import assert_no_duckdb_writes
from quantfoundry_research.jobs import JobStore
from quantfoundry_research.nats import NatsAdapter, RealNatsAdapter
from quantfoundry_research.routes import get_events, get_pool, get_store, router
from quantfoundry_research.workers import StubWorkerPool, WorkerPool

_logger = get_logger("quantfoundry-research")

API_TITLE = "Magpie research orchestrator"
API_VERSION = "0.0.1"
API_DESCRIPTION = (
    "Backtest-run orchestrator skeleton. Accepts BacktestRunConfig "
    "submissions, dispatches to a (currently stubbed) worker pool, "
    "and exposes job status + canned results. Schema is authoritative "
    "in src/quantfoundry_research/config.py; this OpenAPI document is "
    "auto-generated from those Pydantic models. "
    "Job-lifecycle events stream to NATS subjects "
    "`research.jobs.status.<id>`, `research.jobs.result.<id>`, and "
    "`data.write.results` when a NATS adapter is wired."
)


def create_app(
    *,
    store: JobStore,
    pool: WorkerPool,
    events: EventPublisher | None = None,
    nats_adapter: NatsAdapter | None = None,
    enforce_no_duckdb: bool = True,
) -> FastAPI:
    """Build a wired-up app from injected dependencies.

    Parameters
    ----------
    store, pool:
        Required state + execution dependencies.
    events:
        Event publisher. Defaults to :class:`NullEventPublisher`
        when omitted. Pass a configured :class:`NatsEventPublisher`
        for the NATS pipeline.
    nats_adapter:
        Owned by the app's lifespan if passed — closed on shutdown.
        Use this when you want :func:`create_app` to manage the
        adapter's lifetime; otherwise close it yourself.
    enforce_no_duckdb:
        Run the no-DuckDB-writes guard at startup. Defaults to
        ``True``; tests that need to import duckdb themselves can
        set it to ``False``.
    """
    publisher = events if events is not None else NullEventPublisher()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if enforce_no_duckdb:
            assert_no_duckdb_writes()
        _logger.info("orchestrator.startup", payload={"version": API_VERSION})
        try:
            yield
        finally:
            _logger.info("orchestrator.shutdown")
            await pool.aclose()
            if nats_adapter is not None:
                await nats_adapter.aclose()

    app = FastAPI(
        title=API_TITLE,
        version=API_VERSION,
        description=API_DESCRIPTION,
        lifespan=lifespan,
    )
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_pool] = lambda: pool
    app.dependency_overrides[get_events] = lambda: publisher
    app.include_router(router)

    @app.get("/healthz", tags=["meta"], summary="Liveness probe")
    async def healthz() -> dict[str, Any]:
        return {"status": "ok", "version": API_VERSION}

    return app


def create_default_app(*, nats_url: str | None = None) -> FastAPI:
    """Convenience for the CLI.

    Without ``nats_url``: in-memory store + stub pool + null event
    publisher — fully self-contained.

    With ``nats_url``: same store + pool, plus a
    :class:`NatsEventPublisher` over a freshly-connected
    :class:`RealNatsAdapter`. The adapter is owned by the app's
    lifespan and closed on shutdown.
    """
    store = JobStore()
    pool = StubWorkerPool()
    if nats_url is None:
        return create_app(store=store, pool=pool)
    adapter = RealNatsAdapter(url=nats_url)
    publisher = NatsEventPublisher(adapter)
    return create_app(store=store, pool=pool, events=publisher, nats_adapter=adapter)


__all__ = [
    "API_DESCRIPTION",
    "API_TITLE",
    "API_VERSION",
    "create_app",
    "create_default_app",
]
