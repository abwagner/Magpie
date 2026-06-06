"""Market-data NT bridge package.

The Python NATS service backing the QF TS server's `nt-bridge-md.ts` adapter.
Subpackages:

- `schwab/` — Schwab MD service. No NT runtime (Schwab streamer is bespoke).
  Reuses `quantfoundry-schwab-nt`'s parsers, streamer client, and auth.
  Filled in by M13-05.
- `ibkr/` — IBKR MD service. Wraps NT's `InteractiveBrokersDataClient`. Shares
  a `TradingNode` with `quantfoundry-ibkr-nt`'s order observer (QF-240) since
  IB Gateway permits one TWS-API connection per client-id. Filled in by
  M13-06.

Design contract: `docs/tdd/market-data-via-nt.md`.
"""
