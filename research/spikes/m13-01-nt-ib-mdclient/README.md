# M13-01 NT IB DataClient validation spike

**Purpose.** Validate NT's `InteractiveBrokersDataClient` against a live paper
IB Gateway for the four data paths M13-06 will rely on. Outcome determines
whether M13-06 proceeds as scoped, ships with the `@stoqey/ib`-via-Python
fallback (Mitigation A), or is deferred entirely (Mitigation B).

See [docs/tdd/market-data-via-nt.md §11 Q1 + §12](../../../docs/tdd/market-data-via-nt.md)
for the broader context.

## Prerequisites

1. **IB Gateway running** on `127.0.0.1:4002` (paper) — confirmed via
   `nc -zv 127.0.0.1 4002`.
2. **TWS API enabled** in Gateway → Configure → Settings → API → Settings.
   "Enable ActiveX and Socket Clients" checked; "Read-Only API" unchecked
   (read-only is fine for this spike, but the production bridge wants
   write-capable; using the same client-id reduces surprises).
3. **Free client-id.** This spike defaults to `99`; verify it isn't in use
   elsewhere (`netstat -an | grep 4002` should show only Gateway listening
   when the spike is idle).
4. **uv installed** (`brew install uv` / `pipx install uv`).

## Run

```bash
cd research/spikes/m13-01-nt-ib-mdclient
uv venv
uv pip install -e .
uv run python probe.py | tee REPORT.md
```

The script prints a markdown table; tee it to `REPORT.md` to capture the
outcome alongside the spike for the M13-01 PR.

## Expected output shapes

**GO (all four paths pass):**

```
| Path | Result | Elapsed | Detail |
|---|---|---|---|
| snapshot_quote | ✓ | 180ms | bid=...,ask=... |
| chain_by_expiration | ✓ | 410ms | 38 strikes returned |
| historical_chain | ✓ | 950ms | 36 strikes returned, asof=YYYY-MM-DD |
| streaming_quote | ✓ | 5012ms | 47 ticks |

**Determination:** GO — M13-06 proceeds as scoped.
```

**Mitigation A (partial failure):**

```
| historical_chain | ✗ | 30000ms | timeout / not supported |
…
**Determination:** GO WITH MITIGATION A — M13-06 adds a `@stoqey/ib`-via-Python fallback for the failing paths.
```

**Mitigation B (catastrophic):**

```
| snapshot_quote | ✗ | 30000ms | connection refused / API not enabled |
| chain_by_expiration | ✗ | n/a | upstream failed |
…
**Determination:** DEFER (Mitigation B) — M13-06 closed as deferred.
```

## State of this spike

The probe functions in `probe.py` are deliberately stubbed (raise
`NotImplementedError` with a description of the expected behaviour). The
wiring of `TradingNode` + `InteractiveBrokersDataClient` is left for the
session that runs the spike, because NT's API surface drifts between minor
versions and baking in assumptions before installing the package risks
landing wrong code.

The intended fill-in sketch is in `probe.py:main()` as a doc-comment. When
running the spike:

1. `uv pip install -e .` to pin a concrete nautilus-trader version.
2. Open `python -c "from nautilus_trader.adapters.interactive_brokers.config import InteractiveBrokersDataClientConfig; help(InteractiveBrokersDataClientConfig)"` to confirm the config shape against the pinned version.
3. Replace the stub bodies with real DataClient calls.
4. Re-run; capture REPORT.md.
5. Edit [docs/tdd/market-data-via-nt.md §12](../../../docs/tdd/market-data-via-nt.md) with the determination as part of the M13-01 PR.

This staging is intentional — the spike is shipped together with its scaffold
so a future operator (you, or someone else) can complete it without
re-discovering the prerequisites.
