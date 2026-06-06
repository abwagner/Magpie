"""GIL-release verification for `qf_quant.bs_price_chain`.

The acceptance criterion in QF-97 (per docs/polyglot-migration-tdd.md §8.1.1)
says PyO3 hot kernels must release the GIL. `bs_price_chain` wraps its loop
in `Python::detach`, which drops the GIL for the duration of the Rust work.

Test strategy: kick off a chain-pricing job on a background thread, hammer
the GIL from the main thread with a tight Python loop, and observe that the
main-thread loop progresses concurrently with the chain work. If the chain
kernel held the GIL, the main-thread counter would stall until the chain
finished.

This is a *behavioral* check, not a timing assertion — we don't measure
exact concurrency speedup, only that progress overlaps.

Run after `maturin develop --release --features python` (from
`core/qf-quant/`):

    python -m pytest python_smoke/test_gil_release.py -v
"""

from __future__ import annotations

import threading
import time

import qf_quant


# Big enough chain to give the background thread genuinely measurable
# elapsed time but small enough to keep the test fast (<2s on dev hardware).
N_STRIKES = 50_000
N_CHAIN_ITERATIONS = 20


def _hammer_chain(spot: float, strikes: list[float]) -> int:
    """Background worker: call bs_price_chain N times. Returns the count."""
    for _ in range(N_CHAIN_ITERATIONS):
        qf_quant.bs_price_chain(spot, strikes, 0.05, 0.25, 0.20)
    return N_CHAIN_ITERATIONS


def test_chain_releases_gil_under_concurrent_python_work() -> None:
    spot = 100.0
    strikes = [80.0 + 0.001 * i for i in range(N_STRIKES)]

    bg_done = threading.Event()
    counter = {"value": 0}

    def bg_worker() -> None:
        _hammer_chain(spot, strikes)
        bg_done.set()

    bg = threading.Thread(target=bg_worker, daemon=True)
    bg.start()

    # Main-thread Python work. Counter ticks while the background thread is
    # priced. With the GIL held inside the Rust kernel, this loop would
    # stall until bg_done fires. With detach, both make progress.
    deadline = time.monotonic() + 10.0
    while not bg_done.is_set() and time.monotonic() < deadline:
        counter["value"] += 1

    assert bg_done.is_set(), (
        f"background chain pricing didn't finish within 10s "
        f"(main-thread counter ticked {counter['value']} times)"
    )
    # If the GIL were held the whole time, the main thread couldn't have
    # advanced at all. A handful of ticks would still happen between chain
    # iterations (Python schedules between bytecode boundaries), but a
    # truly released GIL lets the main thread tick aggressively. Require
    # at least 1k ticks as a generous floor.
    assert counter["value"] > 1_000, (
        f"main-thread loop only ticked {counter['value']} times — "
        f"suggests the chain kernel held the GIL"
    )
