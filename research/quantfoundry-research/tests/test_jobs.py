"""Tests for ``quantfoundry_research.jobs.JobStore``."""

from __future__ import annotations

import pytest
from quantfoundry_research.config import BacktestRunConfig, JobResult
from quantfoundry_research.jobs import JobStore


def _config() -> BacktestRunConfig:
    return BacktestRunConfig(
        strategy_id="x",
        strategy_version="v1",
        start_date="2024-01-01",
        end_date="2024-12-31",
        portfolio="paper",
    )


def _result(job_id: str) -> JobResult:
    return JobResult(
        job_id=job_id,
        run_id="r",
        strategy_id="x",
        strategy_version="v1",
        start_date="2024-01-01",
        end_date="2024-12-31",
        portfolio="paper",
        metrics={"sharpe": 1.0},
        trade_count=10,
    )


class TestSubmit:
    async def test_submit_assigns_uuid_and_pending_state(self) -> None:
        store = JobStore()
        status = await store.submit(config=_config())
        assert status.state == "pending"
        assert len(status.job_id) == 32  # hex uuid

    async def test_submit_preserves_correlation_id(self) -> None:
        store = JobStore()
        status = await store.submit(config=_config(), correlation_id="cid-1")
        assert status.correlation_id == "cid-1"


class TestTransitions:
    async def test_full_lifecycle(self) -> None:
        store = JobStore()
        initial = await store.submit(config=_config())

        running = await store.mark_running(initial.job_id)
        assert running.state == "running"
        assert running.started_at is not None

        completed = await store.mark_completed(
            initial.job_id, result=_result(initial.job_id)
        )
        assert completed.state == "completed"
        assert completed.result is not None
        assert completed.completed_at is not None

    async def test_mark_failed_transitions(self) -> None:
        store = JobStore()
        initial = await store.submit(config=_config())
        await store.mark_running(initial.job_id)
        failed = await store.mark_failed(initial.job_id, error="kaboom")
        assert failed.state == "failed"
        assert failed.error == "kaboom"

    async def test_cannot_complete_a_failed_job(self) -> None:
        store = JobStore()
        initial = await store.submit(config=_config())
        await store.mark_failed(initial.job_id, error="x")
        with pytest.raises(ValueError, match="already marked failed"):
            await store.mark_completed(initial.job_id, result=_result(initial.job_id))

    async def test_cannot_fail_a_completed_job(self) -> None:
        store = JobStore()
        initial = await store.submit(config=_config())
        await store.mark_completed(initial.job_id, result=_result(initial.job_id))
        with pytest.raises(ValueError, match="already marked completed"):
            await store.mark_failed(initial.job_id, error="x")

    async def test_cannot_run_a_completed_job(self) -> None:
        store = JobStore()
        initial = await store.submit(config=_config())
        await store.mark_completed(initial.job_id, result=_result(initial.job_id))
        with pytest.raises(ValueError, match="cannot transition"):
            await store.mark_running(initial.job_id)

    async def test_missing_job_raises_keyerror(self) -> None:
        store = JobStore()
        with pytest.raises(KeyError):
            await store.mark_running("nope")


class TestQueries:
    async def test_get_returns_none_for_missing(self) -> None:
        store = JobStore()
        assert await store.get("missing") is None

    async def test_list_returns_all_in_order(self) -> None:
        store = JobStore()
        a = await store.submit(config=_config())
        b = await store.submit(config=_config())
        listed = await store.list()
        assert [j.job_id for j in listed] == [a.job_id, b.job_id]

    async def test_list_filters_by_state(self) -> None:
        store = JobStore()
        a = await store.submit(config=_config())
        b = await store.submit(config=_config())
        await store.mark_running(b.job_id)
        pending = await store.list(state="pending")
        running = await store.list(state="running")
        assert [j.job_id for j in pending] == [a.job_id]
        assert [j.job_id for j in running] == [b.job_id]

    async def test_config_of_returns_stored_config(self) -> None:
        store = JobStore()
        cfg = _config()
        status = await store.submit(config=cfg)
        retrieved = await store.config_of(status.job_id)
        assert retrieved == cfg
