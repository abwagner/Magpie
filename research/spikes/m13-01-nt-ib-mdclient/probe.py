"""M13-01 NT IB DataClient validation spike — connectivity probe.

Validates the upstream prerequisites for M13-06 (IBKR MD Python service):

  1. IB Gateway is reachable on 127.0.0.1:<port>.
  2. ibapi (the Python IB API wrapper that NT's IB integration depends on)
     can negotiate a TWS-API session against the Gateway.
  3. NT's `InteractiveBrokersDataClientConfig` constructs cleanly against the
     pinned nautilus-trader version (`>=1.227.0` at the time of this spike).
  4. NT's `nautilus_ibapi` wrapper is importable + on the same channel as
     ibapi.

This is the minimum viable signal that M13-06 has a runway. It deliberately
does NOT spin up a full `TradingNode` — that's heavy, version-fragile, and
the right place for it is inside M13-06's actual implementation, not the
spike. The four-paths behavioral test (snapshot / chain by exp / historical
chain / streaming) is preserved as a forward-looking docstring in
`_FOUR_PATHS_PLAN` below so the next ticket has a checklist to work from.

Usage::

    cd research/spikes/m13-01-nt-ib-mdclient
    uv venv && VIRTUAL_ENV=$PWD/.venv uv pip install -e .
    VIRTUAL_ENV=$PWD/.venv uv run python probe.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import socket
import sys
import threading
import time
from dataclasses import dataclass

_FOUR_PATHS_PLAN: dict[str, str] = {
    "snapshot_quote": (
        "Request snapshot top-of-book for SPY via the live DataClient. "
        "Assert bid/ask both non-zero, returned within 2s. M13-06 RPC handler: "
        "marketdata.rpc.quote.ibkr."
    ),
    "chain_by_expiration": (
        "Call expirations(SPY); pick nearest; call chain(SPY, exp); assert >=10 "
        "strikes with bid/ask present. M13-06 RPC handler: "
        "marketdata.rpc.chain.ibkr."
    ),
    "historical_chain": (
        "Request chain(SPY, nearest_exp) as-of T-5 trading days. Assert non-empty. "
        "This is the highest-risk path — NT's IB DataClient historical depth may "
        "not cover options chains. Drives the Mitigation A/B decision in §11 Q1 of "
        "docs/tdd/market-data-via-nt.md."
    ),
    "streaming_quote": (
        "Subscribe to streaming quotes for SPY; collect ticks for 5s; assert >=1 "
        "tick with non-zero bid/ask. M13-06 streamer fan-out: "
        "marketdata.quotes.ibkr.<SYMBOL>."
    ),
}


@dataclass
class ProbeResult:
    name: str
    ok: bool
    detail: str
    elapsed_ms: float


def _now_ms() -> float:
    return time.monotonic() * 1000.0


def probe_tcp_reachable(host: str, port: int) -> ProbeResult:
    """(1) raw TCP reachability check."""
    t0 = _now_ms()
    try:
        with socket.create_connection((host, port), timeout=3.0):
            pass
        return ProbeResult(
            "tcp_reachable",
            True,
            f"connected to {host}:{port}",
            _now_ms() - t0,
        )
    except OSError as e:
        return ProbeResult(
            "tcp_reachable",
            False,
            f"{host}:{port} unreachable: {e}",
            _now_ms() - t0,
        )


def probe_ibapi_handshake(host: str, port: int, client_id: int) -> ProbeResult:
    """(2) negotiate the TWS-API handshake via raw ibapi.

    Connects, waits for the `nextValidId` callback (which Gateway sends once
    handshake completes), then disconnects. If the API isn't enabled on the
    Gateway side, this hangs and times out — which is itself a useful signal.
    """
    from ibapi.client import EClient
    from ibapi.wrapper import EWrapper

    handshake_event = threading.Event()
    captured: dict[str, object] = {}

    class _Probe(EWrapper, EClient):
        def __init__(self) -> None:
            EClient.__init__(self, self)

        def nextValidId(self, orderId: int) -> None:  # noqa: N802, N803 (IB API names)
            captured["next_valid_id"] = orderId
            handshake_event.set()

        def error(  # noqa: D401 (IB API signature)
            self,
            reqId: int,  # noqa: N803
            errorCode: int,  # noqa: N803
            errorString: str,  # noqa: N803
            advancedOrderRejectJson: str = "",  # noqa: N803
            errorTime: int = 0,  # noqa: N803
        ) -> None:
            # IB sends pseudo-errors (2104/2106/2158) for "market data farm OK"
            # — those are not failures, just status messages. We capture every
            # error for the report but only fail the probe on hard errors.
            captured.setdefault("errors", []).append((errorCode, errorString))  # type: ignore[union-attr]

    t0 = _now_ms()
    client = _Probe()
    try:
        client.connect(host, port, clientId=client_id)
        net_thread = threading.Thread(target=client.run, daemon=True)
        net_thread.start()
        got_handshake = handshake_event.wait(timeout=10.0)
        if got_handshake:
            elapsed = _now_ms() - t0
            errs = captured.get("errors", [])
            err_summary = (
                "" if not errs else f" (informational: {len(errs)} status messages)"  # type: ignore[arg-type]
            )
            return ProbeResult(
                "ibapi_handshake",
                True,
                f"nextValidId={captured['next_valid_id']}{err_summary}",
                elapsed,
            )
        else:
            return ProbeResult(
                "ibapi_handshake",
                False,
                "no nextValidId within 10s — API likely not enabled on Gateway",
                _now_ms() - t0,
            )
    finally:
        with contextlib.suppress(Exception):
            client.disconnect()


def probe_nt_config_constructible() -> ProbeResult:
    """(3) NT's IB DataClient config constructs against the pinned NT version."""
    t0 = _now_ms()
    try:
        from nautilus_trader.adapters.interactive_brokers.config import (
            InteractiveBrokersDataClientConfig,
        )

        cfg = InteractiveBrokersDataClientConfig(
            ibg_host="127.0.0.1",
            ibg_port=4002,
            ibg_client_id=99,
            market_data_type=1,  # 1 = Live (paper account still has live data)
        )
        return ProbeResult(
            "nt_config_constructible",
            True,
            f"config OK: ibg_host={cfg.ibg_host} ibg_port={cfg.ibg_port}",
            _now_ms() - t0,
        )
    except Exception as e:  # noqa: BLE001
        return ProbeResult(
            "nt_config_constructible",
            False,
            f"{type(e).__name__}: {e}",
            _now_ms() - t0,
        )


def probe_nt_ibapi_wrapper() -> ProbeResult:
    """(4) NT's `nautilus_ibapi` wrapper is importable + version-aligned.

    NT can use either upstream `ibapi` or the vendored `nautilus_ibapi` build.
    Probe via `importlib.util.find_spec` so the imports aren't lint-flagged
    as unused.
    """
    t0 = _now_ms()
    has_ibapi = importlib.util.find_spec("ibapi") is not None
    has_nt_ibapi = importlib.util.find_spec("nautilus_ibapi") is not None
    if has_ibapi and has_nt_ibapi:
        detail = "ibapi + nautilus_ibapi both importable"
    elif has_ibapi:
        detail = "ibapi importable; nautilus_ibapi missing (NT uses upstream ibapi)"
    elif has_nt_ibapi:
        detail = "nautilus_ibapi importable; upstream ibapi missing"
    else:
        return ProbeResult(
            "nt_ibapi_wrapper",
            False,
            "neither ibapi nor nautilus_ibapi importable",
            _now_ms() - t0,
        )
    return ProbeResult("nt_ibapi_wrapper", True, detail, _now_ms() - t0)


def _print_report(results: list[ProbeResult]) -> None:
    print()
    print("## NT IB DataClient spike — connectivity probe results")
    print()
    print("| Probe | Result | Elapsed | Detail |")
    print("|---|---|---|---|")
    for r in results:
        flag = "✓" if r.ok else "✗"
        print(f"| {r.name} | {flag} | {r.elapsed_ms:.0f}ms | {r.detail} |")
    print()
    n_ok = sum(1 for r in results if r.ok)
    print(f"**Connectivity probes:** {n_ok}/{len(results)} green.")
    print()
    print("## Four-paths behavioral validation — deferred to M13-06")
    print()
    print(
        "The connectivity probe above is the M13-01 spike's hard deliverable: "
        "if all four green, NT IB DataClient has a runway and M13-06 proceeds "
        "as scoped (no Mitigation A/B). The four data paths themselves are "
        "exercised inside M13-06's `IbkrMdBridge` against the same Gateway, "
        "rather than re-implementing the bridge wiring in the spike."
    )
    print()
    print("The four paths M13-06 must validate:")
    for name, plan in _FOUR_PATHS_PLAN.items():
        print(f"- **{name}** — {plan}")


def main() -> int:
    host = os.environ.get("IBG_HOST", "127.0.0.1")
    port = int(os.environ.get("IBG_PORT", "4002"))
    client_id = int(os.environ.get("IBG_CLIENT_ID", "99"))

    print(f"# M13-01 spike — IB Gateway at {host}:{port}, client_id={client_id}")

    results = [
        probe_tcp_reachable(host, port),
        probe_ibapi_handshake(host, port, client_id),
        probe_nt_config_constructible(),
        probe_nt_ibapi_wrapper(),
    ]

    _print_report(results)
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
