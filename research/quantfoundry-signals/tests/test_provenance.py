"""Tests for ``quantfoundry_signals.provenance``."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from quantfoundry_signals.provenance import (
    WORKER_ID_ENV_VAR,
    build_provenance,
    new_run_id,
    resolve_worker_id,
)


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv(WORKER_ID_ENV_VAR, raising=False)
    yield


class TestResolveWorkerId:
    def test_env_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(WORKER_ID_ENV_VAR, "vol-forecast-7c9")
        assert resolve_worker_id() == "vol-forecast-7c9"

    def test_falls_back_to_hostname(
        self, monkeypatch: pytest.MonkeyPatch, clean_env: None
    ) -> None:
        monkeypatch.setattr(
            "quantfoundry_signals.provenance.socket.gethostname",
            lambda: "host-from-stub",
        )
        assert resolve_worker_id() == "host-from-stub"

    def test_strips_env_whitespace(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(WORKER_ID_ENV_VAR, "  ")  # whitespace = empty
        monkeypatch.setattr(
            "quantfoundry_signals.provenance.socket.gethostname",
            lambda: "fallback",
        )
        assert resolve_worker_id() == "fallback"

    def test_handles_oserror_from_hostname(
        self, monkeypatch: pytest.MonkeyPatch, clean_env: None
    ) -> None:
        def _raise() -> str:
            raise OSError("synthetic")

        monkeypatch.setattr(
            "quantfoundry_signals.provenance.socket.gethostname", _raise
        )
        assert resolve_worker_id() == "unknown-worker"


class TestNewRunId:
    def test_returns_32_hex_chars(self) -> None:
        run_id = new_run_id()
        assert len(run_id) == 32
        assert all(c in "0123456789abcdef" for c in run_id)

    def test_unique_per_call(self) -> None:
        assert new_run_id() != new_run_id()


class TestBuildProvenance:
    def test_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(WORKER_ID_ENV_VAR, "w1")
        p = build_provenance()
        assert p.worker_id == "w1"
        assert len(p.run_id) == 32
        assert p.input_hash is None

    def test_overrides(self) -> None:
        p = build_provenance(
            worker_id="w-explicit", run_id="r-1", input_hash="sha256:x"
        )
        assert p == p.__class__(
            worker_id="w-explicit", run_id="r-1", input_hash="sha256:x"
        )

    def test_run_id_shared_across_batch(self) -> None:
        # Caller passes a single run_id explicitly so a batch of
        # related signals all share it.
        a = build_provenance(run_id="shared")
        b = build_provenance(run_id="shared")
        assert a.run_id == b.run_id == "shared"
