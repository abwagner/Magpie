"""Wire-contract models for the research orchestrator.

Pydantic v2 models that double as FastAPI request/response schemas.
The OpenAPI document is generated from these (FastAPI introspects the
annotations), so any field rename or type change here is visible to
consumers of the API.

Shape philosophy:

* ``BacktestRunConfig`` is the single backtest unit — strategy id +
  params + date range + portfolio. Grid sweeps and walk-forward runs
  decompose into many ``BacktestRunConfig`` instances at submit time.
* ``JobSubmission`` is the request envelope; the orchestrator stamps
  a ``job_id`` and returns ``JobAccepted`` synchronously.
* ``JobStatus`` is the polling view; ``JobResult`` is the canned-or-real
  output handed back once the worker pool completes.

The skeleton (QF-110) returns canned ``JobResult`` records from a stub
worker pool. The wire shape is what consumers ought to design against;
the contents will get real numbers once the NautilusTrader worker pool
(QF-111 + downstream) lands.

Reference: ``docs/polyglot-migration-tdd.md §5.5`` (orchestrator).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ── Backtest unit ──────────────────────────────────────────────────


class BacktestRunConfig(BaseModel):
    """One backtest invocation — the smallest unit a worker runs."""

    model_config = ConfigDict(extra="forbid")

    strategy_id: str = Field(
        ...,
        description=(
            "Stable identifier for the strategy under test (e.g. "
            '"vol-forecast-spy-1d", "cl-scalp"). Resolved by the worker '
            "to a concrete strategy class."
        ),
        min_length=1,
    )
    strategy_version: str = Field(
        ...,
        description=(
            "Opaque version string for the strategy code path (e.g. "
            'a git SHA, a release tag, "v3.2"). Pinned per run so '
            "results stay reproducible."
        ),
        min_length=1,
    )
    params: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Strategy parameters for this run. Schema is strategy-"
            "specific and is validated inside the worker, not here."
        ),
    )
    start_date: str = Field(
        ...,
        description="Backtest window start, ISO-8601 date (YYYY-MM-DD).",
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    )
    end_date: str = Field(
        ...,
        description="Backtest window end, ISO-8601 date (YYYY-MM-DD).",
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    )
    portfolio: str = Field(
        ...,
        description=(
            "Portfolio identifier in config/portfolios.json — selects "
            "the starting capital, risk limits, broker, and execution "
            "profile for the run."
        ),
        min_length=1,
    )
    seed: int | None = Field(
        default=None,
        description=(
            "Optional RNG seed for deterministic reruns. Workers pass "
            "this into NumPy / numba / torch as appropriate."
        ),
    )


# ── Submission envelope ────────────────────────────────────────────


JobKind = Literal["single", "grid", "walkforward"]


class JobSubmission(BaseModel):
    """Request body to ``POST /jobs``.

    ``kind="single"`` ships one :class:`BacktestRunConfig` in
    :attr:`config`; future ``kind="grid"`` and ``kind="walkforward"``
    will introduce richer decomposition payloads. The skeleton accepts
    only ``"single"`` until those decomposers land.
    """

    model_config = ConfigDict(extra="forbid")

    kind: JobKind = Field(
        default="single",
        description="Decomposition style. Skeleton supports 'single' only.",
    )
    config: BacktestRunConfig = Field(
        ..., description="The (single) backtest configuration to run."
    )
    correlation_id: str | None = Field(
        default=None,
        description=(
            "Optional caller-supplied correlation ID. The orchestrator "
            "propagates it into structured logs for end-to-end tracing."
        ),
    )


# ── Status / result ───────────────────────────────────────────────


JobState = Literal["pending", "running", "completed", "failed"]


class JobResult(BaseModel):
    """Per-run output the orchestrator returns to callers."""

    model_config = ConfigDict(extra="forbid")

    job_id: str
    run_id: str
    strategy_id: str
    strategy_version: str
    start_date: str
    end_date: str
    portfolio: str
    metrics: dict[str, float] = Field(
        default_factory=dict,
        description=(
            "Headline performance metrics (sharpe, sortino, max DD, "
            "total return, ...). Skeleton returns canned values; the "
            "real worker pool fills these from NT's analytics surface."
        ),
    )
    trade_count: int = Field(
        default=0, description="Total fills produced during the run."
    )
    notes: str | None = Field(
        default=None,
        description=(
            "Free-form text from the worker — useful for stubbed runs "
            "to signal 'this is canned data'."
        ),
    )


class JobStatus(BaseModel):
    """Polling view returned by ``GET /jobs/{job_id}``."""

    model_config = ConfigDict(extra="forbid")

    job_id: str
    state: JobState
    submitted_at: str
    started_at: str | None = None
    completed_at: str | None = None
    correlation_id: str | None = None
    error: str | None = Field(
        default=None,
        description="Error message when ``state == 'failed'``.",
    )
    result: JobResult | None = Field(
        default=None,
        description="Populated when ``state == 'completed'``.",
    )


class JobAccepted(BaseModel):
    """Synchronous response to ``POST /jobs``."""

    model_config = ConfigDict(extra="forbid")

    job_id: str
    state: JobState = "pending"
    submitted_at: str


class JobList(BaseModel):
    """Response to ``GET /jobs``."""

    model_config = ConfigDict(extra="forbid")

    jobs: list[JobStatus]


__all__ = [
    "BacktestRunConfig",
    "JobAccepted",
    "JobKind",
    "JobList",
    "JobResult",
    "JobState",
    "JobStatus",
    "JobSubmission",
]
