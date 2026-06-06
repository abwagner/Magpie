"""Tests for ``quantfoundry_research.nats`` — the in-memory adapter."""

from __future__ import annotations

import json

import pytest
from quantfoundry_research.nats import (
    DATA_WRITE_RESULTS_SUBJECT,
    InMemoryNatsAdapter,
    result_subject,
    status_subject,
)


class TestSubjects:
    def test_status_subject_format(self) -> None:
        assert status_subject("abc123") == "research.jobs.status.abc123"

    def test_result_subject_format(self) -> None:
        assert result_subject("xyz999") == "research.jobs.result.xyz999"

    def test_data_write_results_subject_constant(self) -> None:
        assert DATA_WRITE_RESULTS_SUBJECT == "data.write.results"


class TestInMemoryAdapter:
    async def test_publish_records_payload(self) -> None:
        adapter = InMemoryNatsAdapter()
        await adapter.publish("foo.bar", b"payload-1")
        await adapter.publish("foo.baz", b"payload-2")
        assert adapter.published == [
            ("foo.bar", b"payload-1"),
            ("foo.baz", b"payload-2"),
        ]

    async def test_is_connected_until_closed(self) -> None:
        adapter = InMemoryNatsAdapter()
        assert adapter.is_connected
        await adapter.aclose()
        assert not adapter.is_connected

    async def test_publish_after_close_raises(self) -> None:
        adapter = InMemoryNatsAdapter()
        await adapter.aclose()
        with pytest.raises(RuntimeError, match="closed"):
            await adapter.publish("x", b"y")

    async def test_listener_fires_on_matching_prefix(self) -> None:
        adapter = InMemoryNatsAdapter()
        received: list[tuple[str, bytes]] = []
        adapter.register_listener(
            "research.jobs.", lambda s, p: received.append((s, p))
        )
        await adapter.publish("research.jobs.status.j1", b"a")
        await adapter.publish("data.write.results", b"b")  # different prefix
        await adapter.publish("research.jobs.result.j1", b"c")
        assert received == [
            ("research.jobs.status.j1", b"a"),
            ("research.jobs.result.j1", b"c"),
        ]

    async def test_empty_prefix_catches_everything(self) -> None:
        adapter = InMemoryNatsAdapter()
        received: list[str] = []
        adapter.register_listener("", lambda s, _p: received.append(s))
        await adapter.publish("a.b", b"x")
        await adapter.publish("c.d", b"y")
        assert received == ["a.b", "c.d"]

    async def test_history_decodes_json(self) -> None:
        adapter = InMemoryNatsAdapter()
        await adapter.publish("foo", json.dumps({"value": 1}).encode())
        await adapter.publish("foo", json.dumps({"value": 2}).encode())
        decoded = adapter.history()
        assert [d for _, d in decoded] == [{"value": 1}, {"value": 2}]

    async def test_history_filters_by_prefix(self) -> None:
        adapter = InMemoryNatsAdapter()
        await adapter.publish("a.b", b'{"k": "a"}')
        await adapter.publish("c.d", b'{"k": "c"}')
        filtered = adapter.history(subject_prefix="a.")
        assert [d for _, d in filtered] == [{"k": "a"}]

    async def test_history_rejects_non_object_payload(self) -> None:
        adapter = InMemoryNatsAdapter()
        await adapter.publish("foo", b'["not", "an", "object"]')
        with pytest.raises(TypeError, match="non-object"):
            adapter.history()
