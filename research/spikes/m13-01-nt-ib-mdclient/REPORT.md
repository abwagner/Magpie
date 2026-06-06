# M13-01 spike — IB Gateway at 127.0.0.1:4002, client_id=99

## NT IB DataClient spike — connectivity probe results

| Probe                   | Result | Elapsed | Detail                                                            |
| ----------------------- | ------ | ------- | ----------------------------------------------------------------- |
| tcp_reachable           | ✓      | 1ms     | connected to 127.0.0.1:4002                                       |
| ibapi_handshake         | ✓      | 44ms    | nextValidId=1 (informational: 3 status messages)                  |
| nt_config_constructible | ✓      | 468ms   | config OK: ibg_host=127.0.0.1 ibg_port=4002                       |
| nt_ibapi_wrapper        | ✓      | 0ms     | ibapi importable; nautilus_ibapi missing (NT uses upstream ibapi) |

**Connectivity probes:** 4/4 green.

## Four-paths behavioral validation — deferred to M13-06

The connectivity probe above is the M13-01 spike's hard deliverable: if all four green, NT IB DataClient has a runway and M13-06 proceeds as scoped (no Mitigation A/B). The four data paths themselves are exercised inside M13-06's `IbkrMdBridge` against the same Gateway, rather than re-implementing the bridge wiring in the spike.

The four paths M13-06 must validate:

- **snapshot_quote** — Request snapshot top-of-book for SPY via the live DataClient. Assert bid/ask both non-zero, returned within 2s. M13-06 RPC handler: marketdata.rpc.quote.ibkr.
- **chain_by_expiration** — Call expirations(SPY); pick nearest; call chain(SPY, exp); assert >=10 strikes with bid/ask present. M13-06 RPC handler: marketdata.rpc.chain.ibkr.
- **historical_chain** — Request chain(SPY, nearest_exp) as-of T-5 trading days. Assert non-empty. This is the highest-risk path — NT's IB DataClient historical depth may not cover options chains. Drives the Mitigation A/B decision in §11 Q1 of docs/tdd/market-data-via-nt.md.
- **streaming_quote** — Subscribe to streaming quotes for SPY; collect ticks for 5s; assert >=1 tick with non-zero bid/ask. M13-06 streamer fan-out: marketdata.quotes.ibkr.<SYMBOL>.
