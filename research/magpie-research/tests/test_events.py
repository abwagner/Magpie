"""Tests for ``magpie_research.events`` — publisher fan-out."""

from __future__ import annotations

import json

import pytest
from magpie_research.config import (
    BacktestRunConfig,
    JobResult,
    JobStatus,
)
from magpie_research.events import (
    CapturingEventPublisher,
    NatsEventPublisher,
    NullEventPublisher,
    ResultEnvelope,
)
from magpie_research.nats import (
    DATA_WRITE_RESULTS_SUBJECT,
    InMemoryNatsAdapter,
    NatsAdapter,
    result_subject,
    status_subject,
)


def _status(
    *,
    job_id: str = "j1",
    state: str = "completed",
    correlation_id: str | None = None,
    with_result: bool = True,
) -> JobStatus:
    result = (
        JobResult(
            job_id=job_id,
            run_id="r1",
            strategy_id="vol-forecast-spy-1d",
            strategy_version="v3.2",
            start_date="2024-01-01",
            end_date="2024-12-31",
            portfolio="paper",
            metrics={"sharpe": 1.2},
            trade_count=42,
        )
        if with_result
        else None
    )
    return JobStatus(
        job_id=job_id,
        state=state,  # type: ignore[arg-type]
        submitted_at="2026-05-15T20:00:00Z",
        correlation_id=correlation_id,
        result=result,
    )


# ── NullEventPublisher ───────────────────────────────────────────


class TestNullEventPublisher:
    async def test_publish_methods_are_noops(self) -> None:
        pub = NullEventPublisher()
        # Should not raise on any call shape, including ones that
        # would surface "no result" warnings in other publishers.
        await pub.publish_status(_status())
        await pub.publish_result(_status(with_result=False))
        await pub.publish_write_results(_status(with_result=False))


# ── CapturingEventPublisher ──────────────────────────────────────


class TestCapturingEventPublisher:
    async def test_records_each_publish_kind(self) -> None:
        pub = CapturingEventPublisher()
        await pub.publish_status(_status(job_id="a"))
        await pub.publish_result(_status(job_id="a"))
        await pub.publish_write_results(_status(job_id="a"))
        assert pub.kinds() == ["status", "result", "write_results"]

    async def test_kinds_filtered_by_job_id(self) -> None:
        pub = CapturingEventPublisher()
        await pub.publish_status(_status(job_id="a"))
        await pub.publish_status(_status(job_id="b"))
        await pub.publish_result(_status(job_id="a"))
        assert pub.kinds(job_id="a") == ["status", "result"]
        assert pub.kinds(job_id="b") == ["status"]


# ── NatsEventPublisher ───────────────────────────────────────────


class TestNatsEventPublisher:
    async def test_publish_status_emits_on_per_job_subject(self) -> None:
        adapter = InMemoryNatsAdapter()
        pub = NatsEventPublisher(adapter)
        await pub.publish_status(_status(job_id="my-job"))
        assert len(adapter.published) == 1
        subject, payload = adapter.published[0]
        assert subject == status_subject("my-job")
        decoded = json.loads(payload.decode("utf-8"))
        assert decoded["job_id"] == "my-job"
        assert decoded["state"] == "completed"

    async def test_publish_result_emits_on_per_job_subject(self) -> None:
        adapter = InMemoryNatsAdapter()
        pub = NatsEventPublisher(adapter)
        await pub.publish_result(_status(job_id="my-job"))
        subject, payload = adapter.published[0]
        assert subject == result_subject("my-job")
        decoded = json.loads(payload.decode("utf-8"))
        # Payload is the JobResult (not the wrapping JobStatus).
        assert decoded["strategy_id"] == "vol-forecast-spy-1d"
        assert decoded["trade_count"] == 42

    async def test_publish_write_results_emits_envelope_on_shared_subject(self) -> None:
        adapter = InMemoryNatsAdapter()
        pub = NatsEventPublisher(adapter)
        await pub.publish_write_results(
            _status(job_id="my-job", correlation_id="cid-xyz")
        )
        subject, payload = adapter.published[0]
        assert subject == DATA_WRITE_RESULTS_SUBJECT
        envelope = ResultEnvelope.model_validate_json(payload.decode("utf-8"))
        assert envelope.job_id == "my-job"
        assert envelope.correlation_id == "cid-xyz"
        assert envelope.producer == "magpie-research"
        assert envelope.result.trade_count == 42
        # Timestamp is RFC-3339 Z.
        assert envelope.published_at.endswith("Z")

    async def test_publish_result_skipped_when_status_has_no_result(self) -> None:
        adapter = InMemoryNatsAdapter()
        pub = NatsEventPublisher(adapter)
        await pub.publish_result(_status(with_result=False))
        assert adapter.published == []

    async def test_publish_write_results_skipped_when_no_result(self) -> None:
        adapter = InMemoryNatsAdapter()
        pub = NatsEventPublisher(adapter)
        await pub.publish_write_results(_status(with_result=False))
        assert adapter.published == []

    async def test_adapter_failure_logged_not_raised(self) -> None:
        # The publisher absorbs adapter exceptions — a missed NATS
        # message is not a job failure (the in-memory store is the
        # source of truth).
        class _BoomAdapter(NatsAdapter):
            async def publish(self, subject: str, payload: bytes) -> None:
                raise RuntimeError("simulated nats outage")

            async def aclose(self) -> None:
                return None

            @property
            def is_connected(self) -> bool:
                return False

        pub = NatsEventPublisher(_BoomAdapter())
        # No exception bubbles up.
        await pub.publish_status(_status())
        await pub.publish_result(_status())
        await pub.publish_write_results(_status())


# ── ResultEnvelope ───────────────────────────────────────────────


class TestResultEnvelope:
    def test_round_trip(self) -> None:
        status = _status(job_id="my-job", correlation_id="cid-xyz")
        assert status.result is not None
        envelope = ResultEnvelope(
            job_id="my-job",
            correlation_id="cid-xyz",
            published_at="2026-05-15T20:00:00.000000Z",
            result=status.result,
        )
        rt = ResultEnvelope.model_validate_json(envelope.model_dump_json())
        assert rt == envelope

    def test_extra_fields_forbidden(self) -> None:
        with pytest.raises(Exception):  # pydantic ValidationError  # noqa: B017, BLE001
            ResultEnvelope(
                job_id="x",
                correlation_id=None,
                published_at="2026-05-15T20:00:00Z",
                result=None,  # type: ignore[arg-type]
                surprise="oops",  # type: ignore[call-arg]
            )

    def test_uses_orchestrator_producer_default(self) -> None:
        # The wrapping config + result combo below is also exercised
        # by TestNatsEventPublisher; this just pins the default.
        cfg = BacktestRunConfig(
            strategy_id="x",
            strategy_version="v1",
            start_date="2024-01-01",
            end_date="2024-12-31",
            portfolio="p",
        )
        # Build a minimal valid JobResult for the assertion.
        result = JobResult(
            job_id="x",
            run_id="r",
            strategy_id=cfg.strategy_id,
            strategy_version=cfg.strategy_version,
            start_date=cfg.start_date,
            end_date=cfg.end_date,
            portfolio=cfg.portfolio,
        )
        envelope = ResultEnvelope(
            job_id="x",
            correlation_id=None,
            published_at="2026-05-15T20:00:00Z",
            result=result,
        )
        assert envelope.producer == "magpie-research"
