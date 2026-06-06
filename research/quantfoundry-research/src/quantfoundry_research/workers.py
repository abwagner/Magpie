"""Stub worker pool — returns canned :class:`JobResult` records.

The skeleton (QF-110) doesn't run real backtests. It exists so the GUI
(QF-112), the NATS wiring (QF-111), and downstream consumers can land
in parallel with a working orchestrator that exercises the full
submit → run → result lifecycle end-to-end. The next PR swaps this
out for a real ``BacktestNode`` driver.

Two implementations live here:

* :class:`StubWorkerPool` — schedules the stub work onto the running
  event loop via :func:`asyncio.create_task`. Real-time progress is
  fine for the GUI to observe.
* :class:`SynchronousStubPool` — runs the stub inline before returning.
  Used by tests that want the result available immediately without an
  ``await asyncio.sleep`` race.

Both share :func:`stub_run` so the canned output is identical
regardless of which pool dispatched it.
"""

from __future__ import annotations

import abc
import asyncio
import hashlib
import math
import uuid

from quantfoundry_logging import get_logger, with_correlation_id

from quantfoundry_research.config import BacktestRunConfig, JobResult
from quantfoundry_research.events import EventPublisher, NullEventPublisher
from quantfoundry_research.jobs import JobStore

_logger = get_logger("quantfoundry-research")


# ── Stub work ──────────────────────────────────────────────────────


def stub_run(job_id: str, config: BacktestRunConfig) -> JobResult:
    """Compute a deterministic, plausibly-shaped fake result.

    Deterministic on ``job_id`` so the same job always returns the
    same canned numbers — makes the orchestrator's output reproducible
    in tests without monkey-patching the worker.
    """
    seed = int(
        hashlib.sha256(job_id.encode("utf-8")).hexdigest()[:8],
        16,
    )
    rng = _PseudoRandom(seed)
    sharpe = round(rng.uniform(-0.5, 2.5), 3)
    sortino = round(sharpe * rng.uniform(0.9, 1.4), 3)
    total_return = round(rng.uniform(-0.2, 0.6), 4)
    max_dd = round(-abs(rng.uniform(0.02, 0.35)), 4)
    trades = rng.randint(20, 4000)
    return JobResult(
        job_id=job_id,
        run_id=uuid.uuid4().hex,
        strategy_id=config.strategy_id,
        strategy_version=config.strategy_version,
        start_date=config.start_date,
        end_date=config.end_date,
        portfolio=config.portfolio,
        metrics={
            "sharpe": sharpe,
            "sortino": sortino,
            "total_return": total_return,
            "max_drawdown": max_dd,
        },
        trade_count=trades,
        notes="stub-result: orchestrator skeleton (QF-110)",
    )


class _PseudoRandom:
    """Tiny seeded LCG so :func:`stub_run` doesn't pull in the heavier
    ``random`` module's hidden state. Stable across Python versions."""

    _MOD = 2**31 - 1
    _A = 48271

    def __init__(self, seed: int) -> None:
        # LCG requires non-zero state in [1, _MOD-1].
        self._state = (seed % (self._MOD - 1)) + 1

    def _next(self) -> int:
        self._state = (self._A * self._state) % self._MOD
        return self._state

    def uniform(self, lo: float, hi: float) -> float:
        u = self._next() / self._MOD
        return lo + (hi - lo) * u

    def randint(self, lo: int, hi: int) -> int:
        return lo + int(math.floor(self.uniform(0, hi - lo + 1)))


# ── Pool interface ─────────────────────────────────────────────────


class WorkerPool(abc.ABC):
    """The orchestrator interacts with the worker pool through this
    minimal surface, so swapping the stub out for the real
    NautilusTrader pool is a single-file replacement."""

    @abc.abstractmethod
    async def dispatch(
        self,
        *,
        job_id: str,
        store: JobStore,
        events: EventPublisher,
    ) -> None:
        """Take ownership of ``job_id``: transition to running,
        execute, write result via ``store.mark_completed``. Any
        exception is recorded via ``store.mark_failed``. The pool
        publishes status + result events via ``events`` at each
        transition; emit failures must not propagate."""

    async def aclose(self) -> None:  # noqa: B027 — default no-op for stateless pools
        """Wait for outstanding dispatched jobs, then close.

        Default no-op for pools without async background tasks (e.g.
        :class:`SynchronousStubPool`). Pools that own tasks override.
        """


# ── Async stub pool ────────────────────────────────────────────────


class StubWorkerPool(WorkerPool):
    """Schedules :func:`stub_run` onto the running event loop.

    Inserts a configurable sleep before producing the result so the
    GUI can observe pending → running → completed transitions. Tests
    that don't want the sleep pass ``run_delay_s=0``.
    """

    def __init__(self, *, run_delay_s: float = 0.05) -> None:
        self._run_delay_s = run_delay_s
        self._tasks: set[asyncio.Task[None]] = set()

    async def dispatch(
        self,
        *,
        job_id: str,
        store: JobStore,
        events: EventPublisher,
    ) -> None:
        task = asyncio.create_task(self._run(job_id, store, events))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, job_id: str, store: JobStore, events: EventPublisher) -> None:
        status = await store.get(job_id)
        cid = status.correlation_id if status is not None else None
        cid_ctx = with_correlation_id(cid) if cid is not None else _NullContext()
        with cid_ctx:
            try:
                running = await store.mark_running(job_id)
                await events.publish_status(running)
                _logger.info(
                    "worker.run.start",
                    payload={"job_id": job_id, "pool": "stub"},
                )
                config = await store.config_of(job_id)
                if config is None:
                    raise RuntimeError(f"job {job_id}: config missing")
                if self._run_delay_s > 0:
                    await asyncio.sleep(self._run_delay_s)
                result = stub_run(job_id, config)
                completed = await store.mark_completed(job_id, result=result)
                await events.publish_status(completed)
                await events.publish_result(completed)
                await events.publish_write_results(completed)
                _logger.info(
                    "worker.run.complete",
                    payload={
                        "job_id": job_id,
                        "pool": "stub",
                        "trade_count": result.trade_count,
                    },
                )
            except Exception as exc:  # noqa: BLE001 — pool boundary catches all
                _logger.error(
                    "worker.run.failed",
                    payload={
                        "job_id": job_id,
                        "pool": "stub",
                        "error": str(exc),
                    },
                )
                failed = await store.mark_failed(job_id, error=str(exc))
                await events.publish_status(failed)

    async def aclose(self) -> None:
        if not self._tasks:
            return
        await asyncio.gather(*self._tasks, return_exceptions=True)


# ── Synchronous stub pool (test helper) ────────────────────────────


class SynchronousStubPool(WorkerPool):
    """Runs the stub job inline. Returns only when the job has reached
    a terminal state. Designed for tests that want predictable timing
    without ``asyncio.sleep`` races."""

    async def dispatch(
        self,
        *,
        job_id: str,
        store: JobStore,
        events: EventPublisher | None = None,
    ) -> None:
        publisher = events or NullEventPublisher()
        try:
            running = await store.mark_running(job_id)
            await publisher.publish_status(running)
            config = await store.config_of(job_id)
            if config is None:
                raise RuntimeError(f"job {job_id}: config missing")
            result = stub_run(job_id, config)
            completed = await store.mark_completed(job_id, result=result)
            await publisher.publish_status(completed)
            await publisher.publish_result(completed)
            await publisher.publish_write_results(completed)
        except Exception as exc:  # noqa: BLE001 — pool boundary catches all
            failed = await store.mark_failed(job_id, error=str(exc))
            await publisher.publish_status(failed)


# ── Helpers ────────────────────────────────────────────────────────


class _NullContext:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_: object) -> None:
        return None


__all__ = [
    "StubWorkerPool",
    "SynchronousStubPool",
    "WorkerPool",
    "stub_run",
]
