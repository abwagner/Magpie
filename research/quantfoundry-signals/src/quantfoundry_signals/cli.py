"""``python -m quantfoundry_signals`` — one-shot CLI for signal workers.

Wraps :meth:`SignalWorker.run_once` so a worker can be invoked from
the command line during development or via a cron / systemd timer in
production. Loads the worker class via ``--worker module:Class``
syntax, instantiates it with no args (workers are expected to read
their own model state from disk / env), and runs against a comma-
separated symbol list.

Examples
========

.. code-block:: shell

    # One-shot run with explicit asof and symbol list
    python -m quantfoundry_signals \\
        --worker myproj.vol_forecast:VolForecast \\
        --symbols EQ:SPY,EQ:QQQ \\
        --asof 2026-05-15T20:00:00Z

    # Defaults: asof = now (UTC), reads QF_SIGNALS_TOKEN + QF_SIGNALS_URL
    QF_SIGNALS_URL=http://localhost:3001/signals \\
    QF_SIGNALS_TOKEN=... \\
    python -m quantfoundry_signals \\
        --worker myproj.vol_forecast:VolForecast \\
        --symbols EQ:SPY

Backfill mode (``--backfill-from`` / ``--backfill-to``) is deferred
to PR-2.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import os
import sys

from quantfoundry_logging import get_logger

from quantfoundry_signals.publisher import (
    DEFAULT_INGRESS_URL,
    SignalPublisher,
)
from quantfoundry_signals.worker import SignalWorker

INGRESS_URL_ENV_VAR = "QF_SIGNALS_URL"

_logger = get_logger("quantfoundry-signals")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="quantfoundry_signals",
        description="One-shot runner for a QF signal worker.",
    )
    parser.add_argument(
        "--worker",
        required=True,
        help="Worker class to run, in 'module:Class' syntax (e.g. "
        "'myproj.vol_forecast:VolForecast').",
    )
    parser.add_argument(
        "--symbols",
        required=True,
        help="Comma-separated canonical symbols (e.g. 'EQ:SPY,EQ:QQQ').",
    )
    parser.add_argument(
        "--asof",
        default=None,
        help="RFC-3339 UTC timestamp to stamp on emitted signals. "
        "Defaults to now (UTC).",
    )
    parser.add_argument(
        "--correlation-id",
        default=None,
        help="Optional correlation-ID to propagate through the SDK logs.",
    )
    parser.add_argument(
        "--ingress-url",
        default=os.environ.get(INGRESS_URL_ENV_VAR, DEFAULT_INGRESS_URL),
        help=(
            "Override the ingress URL. Defaults to $QF_SIGNALS_URL or "
            f"{DEFAULT_INGRESS_URL!r}."
        ),
    )
    return parser.parse_args(argv)


def _load_worker_class(spec: str) -> type[SignalWorker]:
    """Resolve ``module:Class`` into the class object."""
    if ":" not in spec:
        raise SystemExit(f"--worker must be 'module:Class', got {spec!r} (missing ':')")
    module_name, class_name = spec.split(":", 1)
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise SystemExit(
            f"--worker: cannot import module {module_name!r}: {exc}"
        ) from exc
    try:
        cls = getattr(module, class_name)
    except AttributeError as exc:
        raise SystemExit(
            f"--worker: module {module_name!r} has no attribute {class_name!r}"
        ) from exc
    if not isinstance(cls, type) or not issubclass(cls, SignalWorker):
        raise SystemExit(f"--worker: {spec!r} is not a SignalWorker subclass")
    return cls


async def _run(args: argparse.Namespace) -> int:
    cls = _load_worker_class(args.worker)
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    if not symbols:
        raise SystemExit("--symbols must contain at least one non-empty entry")

    publisher = SignalPublisher(ingress_url=args.ingress_url)
    worker = cls(publisher=publisher)
    try:
        result = await worker.run_once(
            symbols=symbols,
            asof=args.asof,
            correlation_id=args.correlation_id,
        )
    finally:
        await worker.aclose()
    _logger.info(
        "cli.run_once.complete",
        payload={
            "accepted": result.accepted,
            "ack": result.ack,
            "batch_id": result.batch_id,
        },
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    return asyncio.run(_run(args))


if __name__ == "__main__":  # pragma: no cover — module-as-script entry
    sys.exit(main())


__all__ = ["main"]
