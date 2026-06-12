"""Runtime guards enforcing the orchestrator's architectural rules.

The single guard for now:

* **No direct DuckDB writes from the orchestrator process.** The TS
  server is the single DuckDB writer (per
  ``docs/polyglot-migration-tdd.md §5.4`` / plan §A.2 #3). Backtest
  results flow over NATS via ``data.write.results``; the orchestrator
  never opens a DuckDB connection.

The guard fires at app startup. If the ``duckdb`` module has been
imported into the orchestrator process — i.e. it appears in
``sys.modules`` — we raise loudly. That catches both deliberate
violations (someone added ``import duckdb`` to a worker) and indirect
ones (a new transitive dep brought DuckDB along).

To make the guard testable, we expose it as a callable that takes an
optional ``modules`` mapping rather than reading ``sys.modules``
directly inside the function body. Production calls
:func:`assert_no_duckdb_writes()` with no args; tests pass a fake
mapping.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from typing import Any

ORCHESTRATOR_DUCKDB_GUARD_MESSAGE = (
    "magpie-research orchestrator must not import `duckdb`. "
    "Backtest result writes flow via NATS subject `data.write.results` "
    "to the TS server, which is the single DuckDB writer. "
    "See docs/polyglot-migration-tdd.md §5.4."
)


def assert_no_duckdb_writes(
    *,
    modules: Mapping[str, Any] | None = None,
) -> None:
    """Raise :class:`RuntimeError` if ``duckdb`` has been imported.

    Parameters
    ----------
    modules:
        Module mapping to inspect. Defaults to :data:`sys.modules`.
        Tests pass a fake mapping to assert the guard fires.
    """
    mods = modules if modules is not None else sys.modules
    if "duckdb" in mods:
        raise RuntimeError(ORCHESTRATOR_DUCKDB_GUARD_MESSAGE)


__all__ = [
    "ORCHESTRATOR_DUCKDB_GUARD_MESSAGE",
    "assert_no_duckdb_writes",
]
