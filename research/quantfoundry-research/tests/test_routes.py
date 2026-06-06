"""Tests for ``quantfoundry_research.routes`` — FastAPI endpoints
exercised through ``httpx.ASGITransport``.
"""

from __future__ import annotations

import httpx
import pytest
from quantfoundry_research.app import create_app
from quantfoundry_research.events import (
    CapturingEventPublisher,
    NatsEventPublisher,
)
from quantfoundry_research.jobs import JobStore
from quantfoundry_research.nats import (
    DATA_WRITE_RESULTS_SUBJECT,
    InMemoryNatsAdapter,
)
from quantfoundry_research.workers import SynchronousStubPool


@pytest.fixture
async def client() -> httpx.AsyncClient:
    store = JobStore()
    pool = SynchronousStubPool()
    app = create_app(store=store, pool=pool)
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://orchestrator.test")


def _payload(*, kind: str = "single") -> dict[str, object]:
    return {
        "kind": kind,
        "config": {
            "strategy_id": "vol-forecast-spy-1d",
            "strategy_version": "v3.2",
            "params": {"lookback": 30},
            "start_date": "2024-01-01",
            "end_date": "2024-12-31",
            "portfolio": "paper",
        },
    }


class TestSubmit:
    async def test_accepts_single_job(self, client: httpx.AsyncClient) -> None:
        async with client:
            resp = await client.post("/jobs", json=_payload())
        assert resp.status_code == 202
        body = resp.json()
        assert body["state"] == "pending"
        assert len(body["job_id"]) == 32

    async def test_rejects_grid_kind_with_501(self, client: httpx.AsyncClient) -> None:
        async with client:
            resp = await client.post("/jobs", json=_payload(kind="grid"))
        assert resp.status_code == 501
        assert "not yet supported" in resp.json()["detail"]

    async def test_rejects_missing_required_field(
        self, client: httpx.AsyncClient
    ) -> None:
        async with client:
            resp = await client.post(
                "/jobs",
                json={
                    "config": {
                        "strategy_id": "x",
                        "strategy_version": "v1",
                        "start_date": "2024-01-01",
                        # end_date missing
                        "portfolio": "p",
                    }
                },
            )
        assert resp.status_code == 422  # pydantic validation


class TestGetAndList:
    async def test_get_returns_completed_status(
        self, client: httpx.AsyncClient
    ) -> None:
        async with client:
            submit_resp = await client.post("/jobs", json=_payload())
            job_id = submit_resp.json()["job_id"]
            # Synchronous pool means the job is already completed when
            # submit returns.
            poll_resp = await client.get(f"/jobs/{job_id}")
        assert poll_resp.status_code == 200
        body = poll_resp.json()
        assert body["state"] == "completed"
        assert body["result"]["strategy_id"] == "vol-forecast-spy-1d"

    async def test_get_unknown_job_returns_404(self, client: httpx.AsyncClient) -> None:
        async with client:
            resp = await client.get("/jobs/does-not-exist")
        assert resp.status_code == 404

    async def test_list_returns_all_jobs(self, client: httpx.AsyncClient) -> None:
        async with client:
            for _ in range(3):
                await client.post("/jobs", json=_payload())
            resp = await client.get("/jobs")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["jobs"]) == 3
        assert all(j["state"] == "completed" for j in body["jobs"])

    async def test_list_filters_by_state(self, client: httpx.AsyncClient) -> None:
        async with client:
            await client.post("/jobs", json=_payload())
            resp = await client.get("/jobs", params={"state": "pending"})
        # Synchronous pool means there's nothing pending by the time
        # the list call returns.
        assert resp.status_code == 200
        assert resp.json()["jobs"] == []


class TestMeta:
    async def test_healthz(self, client: httpx.AsyncClient) -> None:
        async with client:
            resp = await client.get("/healthz")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "version" in body

    async def test_openapi_published(self, client: httpx.AsyncClient) -> None:
        async with client:
            resp = await client.get("/openapi.json")
        assert resp.status_code == 200
        doc = resp.json()
        # Sanity: the spec describes our routes.
        assert "/jobs" in doc["paths"]
        assert "/jobs/{job_id}" in doc["paths"]
        assert "/healthz" in doc["paths"]
        # Components include the wire-contract models.
        schemas = doc.get("components", {}).get("schemas", {})
        assert "BacktestRunConfig" in schemas
        assert "JobStatus" in schemas


# ── QF-111: NATS event publishing through the route layer ──────────


class TestEventPublishingThroughRoutes:
    async def test_submit_emits_pending_status_before_pool_dispatch(self) -> None:
        store = JobStore()
        pool = SynchronousStubPool()
        events = CapturingEventPublisher()
        app = create_app(store=store, pool=pool, events=events)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://orchestrator.test"
        ) as cli:
            resp = await cli.post("/jobs", json=_payload())
        assert resp.status_code == 202
        job_id = resp.json()["job_id"]
        kinds = events.kinds(job_id=job_id)
        # Pending status from the route + (running, completed,
        # result, write_results) from the synchronous pool.
        assert kinds == [
            "status",  # pending (from route handler)
            "status",  # running
            "status",  # completed
            "result",
            "write_results",
        ]

    async def test_end_to_end_publishes_data_write_results(self) -> None:
        store = JobStore()
        pool = SynchronousStubPool()
        adapter = InMemoryNatsAdapter()
        events = NatsEventPublisher(adapter)
        app = create_app(store=store, pool=pool, events=events)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://orchestrator.test"
        ) as cli:
            resp = await cli.post("/jobs", json=_payload())
        assert resp.status_code == 202
        # The `data.write.results` subject is exactly what the TS
        # server consumer subscribes to (QF-111 follow-on).
        envelopes = adapter.history(subject_prefix=DATA_WRITE_RESULTS_SUBJECT)
        assert len(envelopes) == 1
        _, payload = envelopes[0]
        assert payload["producer"] == "quantfoundry-research"
        assert payload["job_id"] == resp.json()["job_id"]
        assert payload["result"]["strategy_id"] == "vol-forecast-spy-1d"

    async def test_status_subjects_carry_per_job_id(self) -> None:
        store = JobStore()
        pool = SynchronousStubPool()
        adapter = InMemoryNatsAdapter()
        events = NatsEventPublisher(adapter)
        app = create_app(store=store, pool=pool, events=events)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://orchestrator.test"
        ) as cli:
            resp = await cli.post("/jobs", json=_payload())
        job_id = resp.json()["job_id"]
        status_subjects = [
            s for s, _ in adapter.published if s.startswith("research.jobs.status.")
        ]
        # Pending + running + completed = 3 status updates on the
        # per-job subject.
        assert len(status_subjects) == 3
        assert all(s == f"research.jobs.status.{job_id}" for s in status_subjects)
