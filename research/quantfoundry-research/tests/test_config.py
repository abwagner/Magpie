"""Tests for ``quantfoundry_research.config`` — pydantic wire schemas."""

from __future__ import annotations

import pytest
from pydantic import ValidationError
from quantfoundry_research.config import (
    BacktestRunConfig,
    JobAccepted,
    JobResult,
    JobStatus,
    JobSubmission,
)


def _valid_config() -> BacktestRunConfig:
    return BacktestRunConfig(
        strategy_id="vol-forecast-spy-1d",
        strategy_version="v3.2",
        params={"lookback": 30, "use_trend": True},
        start_date="2024-01-01",
        end_date="2024-12-31",
        portfolio="paper",
    )


class TestBacktestRunConfig:
    def test_valid_payload_round_trips(self) -> None:
        cfg = _valid_config()
        # model_dump round-trips: same values, same types.
        d = cfg.model_dump()
        assert BacktestRunConfig(**d) == cfg

    def test_seed_optional(self) -> None:
        cfg = _valid_config()
        assert cfg.seed is None

    def test_params_default_empty(self) -> None:
        cfg = BacktestRunConfig(
            strategy_id="x",
            strategy_version="v1",
            start_date="2024-01-01",
            end_date="2024-12-31",
            portfolio="p",
        )
        assert cfg.params == {}

    def test_bad_date_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BacktestRunConfig(
                strategy_id="x",
                strategy_version="v1",
                start_date="2024/01/01",
                end_date="2024-12-31",
                portfolio="p",
            )

    def test_empty_strategy_id_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BacktestRunConfig(
                strategy_id="",
                strategy_version="v1",
                start_date="2024-01-01",
                end_date="2024-12-31",
                portfolio="p",
            )

    def test_extra_fields_forbidden(self) -> None:
        with pytest.raises(ValidationError):
            BacktestRunConfig(
                strategy_id="x",
                strategy_version="v1",
                start_date="2024-01-01",
                end_date="2024-12-31",
                portfolio="p",
                surprise_field="oops",  # type: ignore[call-arg]
            )


class TestJobSubmission:
    def test_default_kind_is_single(self) -> None:
        sub = JobSubmission(config=_valid_config())
        assert sub.kind == "single"

    def test_grid_kind_accepted_at_schema_level(self) -> None:
        # The route handler enforces "single only" for the skeleton —
        # the schema itself accepts every documented kind.
        sub = JobSubmission(config=_valid_config(), kind="grid")
        assert sub.kind == "grid"

    def test_unknown_kind_rejected(self) -> None:
        with pytest.raises(ValidationError):
            JobSubmission(config=_valid_config(), kind="surprise")  # type: ignore[arg-type]

    def test_correlation_id_optional(self) -> None:
        assert JobSubmission(config=_valid_config()).correlation_id is None
        assert (
            JobSubmission(config=_valid_config(), correlation_id="cid-1").correlation_id
            == "cid-1"
        )


class TestStatusModels:
    def test_job_accepted_defaults(self) -> None:
        a = JobAccepted(job_id="j", submitted_at="2026-05-15T20:00:00Z")
        assert a.state == "pending"

    def test_job_status_completed_round_trip(self) -> None:
        result = JobResult(
            job_id="j",
            run_id="r",
            strategy_id="s",
            strategy_version="v",
            start_date="2024-01-01",
            end_date="2024-12-31",
            portfolio="p",
            metrics={"sharpe": 1.2},
            trade_count=42,
        )
        status = JobStatus(
            job_id="j",
            state="completed",
            submitted_at="2026-05-15T20:00:00Z",
            completed_at="2026-05-15T20:01:00Z",
            result=result,
        )
        d = status.model_dump()
        rt = JobStatus(**d)
        assert rt.result == result
