"""magpie-research — backtest orchestrator skeleton.

A FastAPI service that accepts :class:`BacktestRunConfig` submissions
and dispatches them to a worker pool. The skeleton's pool is stubbed
(returns canned :class:`JobResult` records); a future PR replaces it
with a real NautilusTrader-driven pool.

QF-111 adds NATS wiring: job-lifecycle events publish to
``research.jobs.status.<id>``, ``research.jobs.result.<id>``, and
``data.write.results``. The orchestrator never writes DuckDB
directly; the architectural guard in :mod:`guards` enforces this.

Reference: ``docs/polyglot-migration-tdd.md §5.4 + §5.5``, QF-110 +
QF-111.
"""

from magpie_research.app import (
    API_DESCRIPTION,
    API_TITLE,
    API_VERSION,
    create_app,
    create_default_app,
)
from magpie_research.config import (
    BacktestRunConfig,
    JobAccepted,
    JobKind,
    JobList,
    JobResult,
    JobState,
    JobStatus,
    JobSubmission,
)
from magpie_research.events import (
    CapturedEvent,
    CapturingEventPublisher,
    EventPublisher,
    NatsEventPublisher,
    NullEventPublisher,
    ResultEnvelope,
)
from magpie_research.guards import (
    ORCHESTRATOR_DUCKDB_GUARD_MESSAGE,
    assert_no_duckdb_writes,
)
from magpie_research.jobs import JobStore
from magpie_research.nats import (
    DATA_WRITE_RESULTS_SUBJECT,
    DEFAULT_NATS_URL,
    InMemoryNatsAdapter,
    NatsAdapter,
    RealNatsAdapter,
    result_subject,
    status_subject,
)
from magpie_research.routes import get_events, get_pool, get_store, router
from magpie_research.workers import (
    StubWorkerPool,
    SynchronousStubPool,
    WorkerPool,
    stub_run,
)

__all__ = [
    "API_DESCRIPTION",
    "API_TITLE",
    "API_VERSION",
    "DATA_WRITE_RESULTS_SUBJECT",
    "DEFAULT_NATS_URL",
    "ORCHESTRATOR_DUCKDB_GUARD_MESSAGE",
    "BacktestRunConfig",
    "CapturedEvent",
    "CapturingEventPublisher",
    "EventPublisher",
    "InMemoryNatsAdapter",
    "JobAccepted",
    "JobKind",
    "JobList",
    "JobResult",
    "JobState",
    "JobStatus",
    "JobStore",
    "JobSubmission",
    "NatsAdapter",
    "NatsEventPublisher",
    "NullEventPublisher",
    "RealNatsAdapter",
    "ResultEnvelope",
    "StubWorkerPool",
    "SynchronousStubPool",
    "WorkerPool",
    "assert_no_duckdb_writes",
    "create_app",
    "create_default_app",
    "get_events",
    "get_pool",
    "get_store",
    "result_subject",
    "router",
    "status_subject",
    "stub_run",
]
