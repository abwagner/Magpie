"""Provenance helpers — auto-fill ``worker_id`` and ``run_id``.

A signal's :class:`~quantfoundry_signals.types.Provenance` is the
where-did-this-come-from record. The worker shouldn't have to know how
to produce it; the SDK fills it in:

* ``worker_id`` — from ``QF_WORKER_ID`` env var, falling back to the
  hostname (``socket.gethostname()``). Stable across a worker's
  lifetime; persists across runs.
* ``run_id`` — a fresh UUID4 per :func:`new_run_id` call (typically
  one per worker invocation). Distinct between live and backfill,
  distinct between retries.
* ``input_hash`` — optional, worker-supplied if it computes one.

Reference: ``docs/polyglot-migration-tdd.md §8.1.3``.
"""

from __future__ import annotations

import os
import socket
import uuid

from quantfoundry_signals.types import Provenance

WORKER_ID_ENV_VAR = "QF_WORKER_ID"


def resolve_worker_id() -> str:
    """Return the worker-identity string for this process.

    Order of preference:
    1. ``QF_WORKER_ID`` environment variable (if set + non-empty)
    2. ``socket.gethostname()``
    3. ``"unknown-worker"`` (only if hostname resolution fails — should
       never happen in normal POSIX environments, but tests can mock
       ``socket.gethostname`` to raise)
    """
    env_val = os.environ.get(WORKER_ID_ENV_VAR, "").strip()
    if env_val:
        return env_val
    try:
        host = socket.gethostname()
    except OSError:
        return "unknown-worker"
    return host or "unknown-worker"


def new_run_id() -> str:
    """Return a fresh run-id (UUID4 hex form, 32 chars no dashes)."""
    return uuid.uuid4().hex


def build_provenance(
    *,
    worker_id: str | None = None,
    run_id: str | None = None,
    input_hash: str | None = None,
) -> Provenance:
    """Construct a :class:`Provenance` with sensible defaults.

    ``worker_id`` and ``run_id`` use the helpers above when omitted.
    Pass them explicitly to override for tests or to share a single
    run-id across a batch of related emissions.
    """
    return Provenance(
        worker_id=worker_id if worker_id is not None else resolve_worker_id(),
        run_id=run_id if run_id is not None else new_run_id(),
        input_hash=input_hash,
    )


__all__ = [
    "WORKER_ID_ENV_VAR",
    "build_provenance",
    "new_run_id",
    "resolve_worker_id",
]
