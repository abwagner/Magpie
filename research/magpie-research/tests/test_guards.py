"""Tests for ``magpie_research.guards.assert_no_duckdb_writes``."""

from __future__ import annotations

import pytest
from magpie_research.guards import (
    ORCHESTRATOR_DUCKDB_GUARD_MESSAGE,
    assert_no_duckdb_writes,
)


class TestAssertNoDuckdbWrites:
    def test_passes_when_duckdb_not_in_modules(self) -> None:
        # Pass an explicit empty mapping so the test doesn't depend
        # on the real sys.modules state.
        assert_no_duckdb_writes(modules={})

    def test_raises_when_duckdb_in_modules(self) -> None:
        with pytest.raises(RuntimeError) as excinfo:
            assert_no_duckdb_writes(modules={"duckdb": object()})
        assert str(excinfo.value) == ORCHESTRATOR_DUCKDB_GUARD_MESSAGE

    def test_raises_on_real_sys_modules_after_import(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Simulate `import duckdb` by inserting a sentinel into
        # sys.modules. monkeypatch unwinds after the test.
        import sys

        monkeypatch.setitem(sys.modules, "duckdb", object())
        with pytest.raises(RuntimeError, match="single DuckDB writer"):
            assert_no_duckdb_writes()

    def test_no_raise_when_duckdb_is_not_imported(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Make sure duckdb really isn't in sys.modules for this test
        # (defensive — the workspace doesn't depend on it, but a
        # transitive import elsewhere could leak it).
        import sys

        if "duckdb" in sys.modules:
            monkeypatch.delitem(sys.modules, "duckdb")
        assert_no_duckdb_writes()

    def test_guard_message_names_the_correct_subject(self) -> None:
        # The error message has to tell the developer where the writes
        # actually go, otherwise the guard is just frustrating.
        assert "data.write.results" in ORCHESTRATOR_DUCKDB_GUARD_MESSAGE
        assert "TS server" in ORCHESTRATOR_DUCKDB_GUARD_MESSAGE
