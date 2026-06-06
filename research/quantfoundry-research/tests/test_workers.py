"""Tests for ``quantfoundry_research.workers`` — stub pool + canned result."""

from __future__ import annotations

import pytest
from quantfoundry_research.config import BacktestRunConfig
from quantfoundry_research.events import (
    CapturingEventPublisher,
    NullEventPublisher,
)
from quantfoundry_research.jobs import JobStore
from quantfoundry_research.workers import (
    StubWorkerPool,
    SynchronousStubPool,
    stub_run,
)


def _config() -> BacktestRunConfig:
    return BacktestRunConfig(
        strategy_id="vol-forecast-spy-1d",
        strategy_version="v3.2",
        start_date="2024-01-01",
        end_date="2024-12-31",
        portfolio="paper",
    )


class TestStubRun:
    def test_deterministic_on_job_id(self) -> None:
        cfg = _config()
        a = stub_run("job-1", cfg)
        b = stub_run("job-1", cfg)
        # Same job_id → same metrics (run_id is allowed to vary since
        # it's a per-call UUID).
        assert a.metrics == b.metrics
        assert a.trade_count == b.trade_count

    def test_different_job_ids_produce_different_metrics(self) -> None:
        cfg = _config()
        a = stub_run("job-a", cfg)
        b = stub_run("job-b", cfg)
        # Vanishingly unlikely the LCG hits the exact same draw, but
        # don't fail on theoretical equality — just ensure at least
        # one metric differs.
        assert a.metrics != b.metrics or a.trade_count != b.trade_count

    def test_carries_config_fields_into_result(self) -> None:
        result = stub_run("job-x", _config())
        assert result.strategy_id == "vol-forecast-spy-1d"
        assert result.strategy_version == "v3.2"
        assert result.portfolio == "paper"
        assert result.notes is not None
        assert "stub" in result.notes.lower()

    def test_metrics_contain_expected_keys(self) -> None:
        result = stub_run("job-x", _config())
        assert {"sharpe", "sortino", "total_return", "max_drawdown"} <= set(
            result.metrics
        )


class TestSynchronousStubPool:
    async def test_dispatch_runs_to_completion(self) -> None:
        store = JobStore()
        pool = SynchronousStubPool()
        initial = await store.submit(config=_config())
        await pool.dispatch(
            job_id=initial.job_id, store=store, events=NullEventPublisher()
        )
        final = await store.get(initial.job_id)
        assert final is not None
        assert final.state == "completed"
        assert final.result is not None
        assert final.result.trade_count > 0

    async def test_dispatch_records_failure_when_inline_run_raises(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        def _boom(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("synthetic worker failure")

        monkeypatch.setattr("quantfoundry_research.workers.stub_run", _boom)
        store = JobStore()
        pool = SynchronousStubPool()
        initial = await store.submit(config=_config())
        await pool.dispatch(
            job_id=initial.job_id, store=store, events=NullEventPublisher()
        )
        final = await store.get(initial.job_id)
        assert final is not None
        assert final.state == "failed"
        assert final.error is not None
        assert "synthetic worker failure" in final.error

    async def test_emits_three_events_on_successful_lifecycle(self) -> None:
        store = JobStore()
        pool = SynchronousStubPool()
        events = CapturingEventPublisher()
        initial = await store.submit(config=_config())
        await pool.dispatch(job_id=initial.job_id, store=store, events=events)
        # On success we emit: status(running), status(completed),
        # result, write_results — four events. The
        # SynchronousStubPool only sees `mark_running` + `mark_completed`,
        # so the route would emit the initial pending-status (not
        # tested here; see test_routes.py).
        assert events.kinds(job_id=initial.job_id) == [
            "status",  # running
            "status",  # completed
            "result",
            "write_results",
        ]

    async def test_emits_failed_status_when_pool_fails(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            "quantfoundry_research.workers.stub_run",
            lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        store = JobStore()
        pool = SynchronousStubPool()
        events = CapturingEventPublisher()
        initial = await store.submit(config=_config())
        await pool.dispatch(job_id=initial.job_id, store=store, events=events)
        # On failure: status(running), status(failed) — no result/
        # write_results because there's nothing to publish.
        kinds = events.kinds(job_id=initial.job_id)
        assert kinds == ["status", "status"]


class TestStubWorkerPool:
    async def test_dispatch_completes_after_event_loop_drains(self) -> None:
        store = JobStore()
        pool = StubWorkerPool(run_delay_s=0)  # fastest possible
        initial = await store.submit(config=_config())
        await pool.dispatch(
            job_id=initial.job_id, store=store, events=NullEventPublisher()
        )
        # Yield until the spawned task finishes.
        await pool.aclose()
        final = await store.get(initial.job_id)
        assert final is not None
        assert final.state == "completed"

    async def test_aclose_idempotent_on_empty_pool(self) -> None:
        pool = StubWorkerPool()
        await pool.aclose()  # no outstanding tasks; must not raise

    async def test_concurrent_dispatch(self) -> None:
        store = JobStore()
        pool = StubWorkerPool(run_delay_s=0)
        jobs = []
        for _ in range(5):
            initial = await store.submit(config=_config())
            jobs.append(initial.job_id)
            await pool.dispatch(
                job_id=initial.job_id, store=store, events=NullEventPublisher()
            )
        await pool.aclose()
        for job_id in jobs:
            final = await store.get(job_id)
            assert final is not None
            assert final.state == "completed"

    async def test_correlation_id_propagated_through_context(self) -> None:
        store = JobStore()
        pool = StubWorkerPool(run_delay_s=0)
        initial = await store.submit(config=_config(), correlation_id="cid-abc")
        await pool.dispatch(
            job_id=initial.job_id, store=store, events=NullEventPublisher()
        )
        await pool.aclose()
        final = await store.get(initial.job_id)
        assert final is not None
        assert final.correlation_id == "cid-abc"
        assert final.state == "completed"

    async def test_emits_lifecycle_events_through_async_pool(self) -> None:
        store = JobStore()
        pool = StubWorkerPool(run_delay_s=0)
        events = CapturingEventPublisher()
        initial = await store.submit(config=_config())
        await pool.dispatch(job_id=initial.job_id, store=store, events=events)
        await pool.aclose()
        assert events.kinds(job_id=initial.job_id) == [
            "status",
            "status",
            "result",
            "write_results",
        ]
