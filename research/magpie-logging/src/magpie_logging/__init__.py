"""``magpie_logging`` — Magpie structured-logging helper.

Wraps ``structlog`` with a processor chain that emits JSON conforming to
the common log schema in ``docs/tdd/observability.md`` §3. Propagates the
correlation ID via a ``ContextVar`` so it's safe across ``await`` boundaries
in async code (unlike Rust's thread-local backing in ``qf-logging``).

Public API
==========

.. code-block:: python

    from magpie_logging import (
        get_logger,
        with_correlation_id,
        current_correlation_id,
    )

    logger = get_logger("my-service")

    with with_correlation_id("01J5V6W2H3R5T7Y9Z1B3D5F7H9"):
        logger.info("strategy.evaluated", payload={"strategy": "soxx", "intents": 3})

Schema emitted
==============

.. code-block:: json

    {
      "ts": "2026-05-13T15:04:05.123456Z",
      "level": "info",
      "service": "my-service",
      "correlation_id": "01J5V6W2H3R5T7Y9Z1B3D5F7H9",
      "event": "strategy.evaluated",
      "payload": { "strategy": "soxx", "intents": 3 }
    }

``correlation_id`` is omitted from the output when no ``with_correlation_id``
context is active.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Generator, MutableMapping
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, cast

import structlog

__all__ = [
    "current_correlation_id",
    "get_logger",
    "with_correlation_id",
]

__version__ = "0.0.1"

# The single ContextVar that backs correlation-ID propagation. Users must
# not instantiate their own — sharing this one is the whole point of the
# helper, and the framework requires a single source of truth per the
# observability TDD §4.3.
_CORRELATION_ID: ContextVar[str | None] = ContextVar(
    "magpie_logging_correlation_id", default=None
)


def current_correlation_id() -> str | None:
    """Return the correlation ID bound by the closest ``with_correlation_id``,
    or ``None`` if none is active."""
    return _CORRELATION_ID.get()


@contextmanager
def with_correlation_id(correlation_id: str) -> Generator[None]:
    """Bind ``correlation_id`` on the current async context for the duration
    of the ``with`` block. Restores the prior value (if any) on exit."""
    token = _CORRELATION_ID.set(correlation_id)
    try:
        yield
    finally:
        _CORRELATION_ID.reset(token)


def _add_ts(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Prepend ``ts`` with RFC 3339 UTC microsecond precision."""
    now = datetime.now(tz=UTC)
    # `isoformat(timespec="microseconds")` yields "+00:00"; replace with "Z"
    # so the wire format matches the Rust crate's output byte-for-byte
    # (Rfc3339 in the `time` crate uses "Z" for UTC).
    event_dict["ts"] = now.isoformat(timespec="microseconds").replace("+00:00", "Z")
    return event_dict


def _add_level(
    _logger: Any, method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Set ``level`` to the structlog method name (info / warning / error / debug)
    normalised to the framework's five levels (trace / debug / info / warn / error)."""
    # structlog method names: "trace", "debug", "info", "warning", "error", "critical".
    # Framework names: "trace", "debug", "info", "warn", "error".
    mapping = {"warning": "warn", "critical": "error"}
    event_dict["level"] = mapping.get(method, method)
    return event_dict


def _add_correlation_id(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Insert ``correlation_id`` from the ContextVar if one is bound."""
    cid = _CORRELATION_ID.get()
    if cid is not None:
        event_dict["correlation_id"] = cid
    return event_dict


def _coerce_event_and_payload(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Promote ``event`` to a top-level field and bundle everything else into
    ``payload``. structlog passes the call's first positional argument under the
    ``event`` key by default, and any ``logger.info("name", **kwargs)`` kwargs
    land at the top level — the framework wants those grouped under ``payload``.

    Special-cased keys (``ts``, ``level``, ``service``, ``correlation_id``,
    ``error``, ``event``) stay at the top level; everything else moves into
    ``payload``. An existing ``payload=`` kwarg merges with the auto-gathered
    one (caller-provided keys win).
    """
    reserved = {"ts", "level", "service", "correlation_id", "event", "error", "payload"}
    user_payload = event_dict.pop("payload", None) or {}
    auto_payload: dict[str, Any] = {}
    for key in list(event_dict.keys()):
        if key not in reserved:
            auto_payload[key] = event_dict.pop(key)
    # Caller-provided payload overrides any auto-gathered key of the same name.
    auto_payload.update(user_payload)
    event_dict["payload"] = auto_payload
    return event_dict


def _ordered_json_renderer(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> str:
    """Emit JSON with the framework's field order: ts, level, service,
    correlation_id (if present), event, payload, error (if present)."""
    ordered: dict[str, Any] = {}
    for key in ("ts", "level", "service", "correlation_id", "event", "payload"):
        if key in event_dict:
            ordered[key] = event_dict[key]
    # Any remaining keys (e.g. `error`) — preserve insertion order.
    for key, value in event_dict.items():
        if key not in ordered:
            ordered[key] = value
    return json.dumps(ordered, separators=(",", ":"), default=str)


def get_logger(service: str) -> structlog.stdlib.BoundLogger:
    """Return a structlog logger bound to ``service``. The first call also
    installs the framework processor chain globally; subsequent calls reuse
    the existing configuration.

    Arguments
    ---------
    service:
        Kebab-case component identifier (e.g. ``"signal-ingress"``,
        ``"portfolio-risk-engine"``). One service per emitting process.
    """
    _ensure_configured()
    return cast(
        "structlog.stdlib.BoundLogger",
        structlog.get_logger().bind(service=service),
    )


_configured = False


def _ensure_configured() -> None:
    """Install the framework processor chain. Idempotent."""
    global _configured  # noqa: PLW0603 — module-level singleton guard.
    if _configured:
        return
    structlog.configure(
        processors=[
            _add_ts,
            _add_level,
            _add_correlation_id,
            _coerce_event_and_payload,
            _ordered_json_renderer,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        # Write to stdout for info/warn/debug; stderr for error/critical.
        # structlog routes via its `logger_factory`; for simplicity we use
        # PrintLoggerFactory which goes to stdout uniformly, and swap to
        # stderr in a wrapper when the level warrants it (Phase 0 keeps
        # this simple — operator tooling can split on the parsed JSON's
        # `level` field instead of relying on stdout vs stderr).
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    _configured = True
