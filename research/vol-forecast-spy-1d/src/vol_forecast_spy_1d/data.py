"""Daily SPY returns loader.

The model needs a recent history of SPY daily log-returns to compute
the EWMA variance forecast. Production deployments will plug in a
real loader (the QF server's data API, a parquet file from the
nightly ingest, etc.). For tests + initial validation the package
ships a tiny synthetic fixture so the worker can produce wire-
correct signals without any external data plumbing.

The loader API is intentionally narrow — a function returning the
recent N daily log-returns sorted oldest-first. Anything more is
the model layer's job.
"""

from __future__ import annotations

import csv
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent.parent
FIXTURE_PATH = PACKAGE_DIR / "data" / "spy_returns_fixture.csv"


# ── Records ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DailyReturn:
    """One daily log-return observation."""

    date: str  # YYYY-MM-DD
    log_return: float


# ── Loader ─────────────────────────────────────────────────────────


def load_returns_csv(path: Path | str = FIXTURE_PATH) -> list[DailyReturn]:
    """Parse a two-column CSV of ``date,log_return`` rows.

    Header is required. Rows with missing/malformed log_return
    values are skipped silently — survey-grade input often has
    holes and the EWMA estimator is robust to a few drops.
    Returned list is sorted oldest-first by date.
    """
    rows: list[DailyReturn] = []
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "date" not in reader.fieldnames:
            raise ValueError(f"CSV at {path} must have a header with a 'date' column")
        for row in reader:
            date = (row.get("date") or "").strip()
            raw = (row.get("log_return") or "").strip()
            if not date or not raw:
                continue
            try:
                lr = float(raw)
            except ValueError:
                continue
            rows.append(DailyReturn(date=date, log_return=lr))
    rows.sort(key=lambda r: r.date)
    return rows


def recent_returns(
    rows: Iterable[DailyReturn],
    *,
    asof: str,
    window: int,
) -> list[DailyReturn]:
    """Return up to ``window`` most-recent returns at or before ``asof``.

    Rows after ``asof`` are excluded so the loader can produce a
    point-in-time snapshot from a longer history (avoids look-ahead
    bias when backtesting).
    """
    if window <= 0:
        raise ValueError(f"recent_returns: window must be > 0, got {window}")
    filtered = [r for r in rows if r.date <= asof]
    return filtered[-window:]


__all__ = [
    "FIXTURE_PATH",
    "DailyReturn",
    "load_returns_csv",
    "recent_returns",
]
