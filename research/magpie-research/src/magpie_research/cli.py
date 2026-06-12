"""``python -m magpie_research serve`` — local dev runner.

Boots the orchestrator under uvicorn with the default store + stub
worker pool. Reads host + port from CLI args; everything else is
left to the FastAPI / uvicorn defaults.

Examples
========

.. code-block:: shell

    # Default: bind 127.0.0.1:8080
    python -m magpie_research serve

    # Bind a specific interface + port
    python -m magpie_research serve --host 0.0.0.0 --port 8181

    # Reload-on-edit during development
    python -m magpie_research serve --reload
"""

from __future__ import annotations

import argparse
import os
import sys
from functools import partial

import uvicorn

from magpie_research.app import create_default_app

NATS_URL_ENV_VAR = "QF_RESEARCH_NATS_URL"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="magpie_research",
        description="Magpie research orchestrator launcher.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Run the orchestrator API server.")
    serve.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"Bind host (default {DEFAULT_HOST}).",
    )
    serve.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Bind port (default {DEFAULT_PORT}).",
    )
    serve.add_argument(
        "--reload",
        action="store_true",
        help="Auto-reload on source edits (dev only).",
    )
    serve.add_argument(
        "--log-level",
        default="info",
        choices=("critical", "error", "warning", "info", "debug", "trace"),
        help="Uvicorn log level (default 'info').",
    )
    serve.add_argument(
        "--nats-url",
        default=os.environ.get(NATS_URL_ENV_VAR),
        help=(
            "Connect to NATS at this URL and publish job-lifecycle "
            f"events. Reads ${NATS_URL_ENV_VAR} when unset; "
            "if no URL is configured the orchestrator runs with a "
            "null event publisher."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.command == "serve":
        # `--reload` requires an import-string to re-execute the factory
        # on each reload; without reload we can pass a partial directly.
        if args.reload:
            os.environ[NATS_URL_ENV_VAR] = args.nats_url or ""
            uvicorn.run(
                "magpie_research.cli:_default_app_factory_for_reload",
                factory=True,
                host=args.host,
                port=args.port,
                reload=True,
                log_level=args.log_level,
            )
        else:
            uvicorn.run(
                partial(create_default_app, nats_url=args.nats_url),
                factory=True,
                host=args.host,
                port=args.port,
                log_level=args.log_level,
            )
        return 0
    raise SystemExit(f"unknown command: {args.command}")


def _default_app_factory_for_reload() -> object:  # pragma: no cover — reload entry
    """Reload-mode entry point. Reads the NATS URL from the env var
    the parent process plumbed in (uvicorn reload spawns a new
    interpreter; we lose the in-process args, hence the env detour)."""
    url = os.environ.get(NATS_URL_ENV_VAR) or None
    return create_default_app(nats_url=url)


if __name__ == "__main__":  # pragma: no cover — module-as-script entry
    sys.exit(main())


__all__ = ["main"]
