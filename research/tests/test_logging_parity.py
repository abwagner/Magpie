"""Cross-runtime golden parity test for ``qf-logging`` / ``quantfoundry_logging``
/ ``server/logger.ts``.

Runs each runtime's parity harness — a small program that emits the same
fixed log line (level=info, service=parity-test, correlation_id=01PARITY…,
event=parity.smoke, payload={answer:42, label:"fixed"}) — captures stdout,
parses the JSON line, strips the ``ts`` field, and asserts the remaining
JSON is byte-identical across all three runtimes.

This is the framework's gate against schema drift. If any runtime's output
diverges from the spec in ``docs/tdd/observability.md`` §3, this test fails.

The test is **integration-style**: it shells out to ``cargo run``, ``npx tsx``,
and ``python -m`` — it requires the Rust toolchain, the project's npm
``node_modules`` (so ``tsx`` is available), and the Python package to be
installed in the workspace. In CI all three are present; locally, missing
toolchains skip the corresponding sub-assertion with a clear reason.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

# repo root: research/tests/test_logging_parity.py → ../..
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

FIXED_CORRELATION_ID = "01PARITYHARNESS0000000000A"
FIXED_EVENT = "parity.smoke"
EXPECTED_PAYLOAD = {"answer": 42, "label": "fixed"}


def _strip_ts(line: str) -> dict[str, object]:
    """Parse a JSON log line and drop the ``ts`` field — every runtime
    emits a different wall-clock time but the rest of the line must match."""
    parsed = json.loads(line)
    assert isinstance(parsed, dict)
    parsed.pop("ts", None)
    return parsed


def _run_rust_harness() -> dict[str, object]:
    if shutil.which("cargo") is None:
        pytest.skip("cargo not available; skipping Rust parity")
    manifest = REPO_ROOT / "core" / "qf-logging" / "Cargo.toml"
    result = subprocess.run(
        [
            "cargo",
            "run",
            "--quiet",
            "--manifest-path",
            str(manifest),
            "--bin",
            "parity-harness",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    line = result.stdout.strip().splitlines()[-1]
    return _strip_ts(line)


def _run_python_harness() -> dict[str, object]:
    # We're already running inside the workspace venv (pytest invoked via
    # `uv run pytest`), so `python -m quantfoundry_logging.parity_harness`
    # works as long as we use sys.executable to pick up the same interpreter.
    import sys

    result = subprocess.run(
        [sys.executable, "-m", "quantfoundry_logging.parity_harness"],
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT / "research",
    )
    line = result.stdout.strip().splitlines()[-1]
    return _strip_ts(line)


def _run_typescript_harness() -> dict[str, object]:
    if not (REPO_ROOT / "node_modules" / ".bin" / "tsx").exists():
        pytest.skip("node_modules/.bin/tsx not installed; skipping TS parity")
    result = subprocess.run(
        ["npx", "--no-install", "tsx", "scripts/log-parity-harness.ts"],
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT,
    )
    line = result.stdout.strip().splitlines()[-1]
    return _strip_ts(line)


def test_python_harness_matches_expected_schema() -> None:
    parsed = _run_python_harness()
    assert parsed == {
        "level": "info",
        "service": "parity-test",
        "correlation_id": FIXED_CORRELATION_ID,
        "event": FIXED_EVENT,
        "payload": EXPECTED_PAYLOAD,
    }


def test_rust_harness_matches_python_modulo_ts() -> None:
    py = _run_python_harness()
    rs = _run_rust_harness()
    assert rs == py, (
        f"Rust output diverged from Python output. Rust: {rs!r}\nPython: {py!r}"
    )


def test_typescript_harness_matches_python_modulo_ts() -> None:
    py = _run_python_harness()
    ts = _run_typescript_harness()
    assert ts == py, (
        f"TS output diverged from Python output. TS: {ts!r}\nPython: {py!r}"
    )


def test_all_three_runtimes_agree_on_field_order() -> None:
    """The framework requires a fixed top-level field order so log
    aggregators can build stable index schemas. Re-parse each line and
    check the JSON key order matches the spec exactly."""
    expected_order = ["level", "service", "correlation_id", "event", "payload"]
    for runtime, parsed in (
        ("python", _run_python_harness()),
        ("rust", _run_rust_harness()),
        ("typescript", _run_typescript_harness()),
    ):
        assert list(parsed.keys()) == expected_order, (
            f"{runtime} emitted keys in {list(parsed.keys())}, "
            f"expected {expected_order}"
        )
