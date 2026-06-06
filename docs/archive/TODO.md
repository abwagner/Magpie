> **Archived 2026-04-28.** Open implementation work from this tracker now lives in [Linear → Magpie](<internal tracker>):
>
> - **Order adapter completion** (IBKR/Schwab `submitOrder()`, IBKR market-data streaming) → **M2**.
> - **Orchestrator scheduling** (event mode, cron merging) → **M3**.
> - **Manually added to-dos** (Linux secrets manager, .env.example) — not migrated; these are operator-environment items unrelated to the trading system. Either move to a personal todo file or add to Linear if they become tracked work.

---

# Trading System Implementation TODO

Tracking implementation progress against the TDD specs in `docs/tdd/`.

## Remaining Work

### Signal orchestrator

- [ ] Event schedule mode — file-watch triggered ticks for sub-minute signals
- [ ] Cron schedule merging — proper parsing when deduplicating across signals with different frequencies

### Needs live infrastructure

- IBKR order adapter `submitOrder()` — requires IB Gateway running
- Schwab order adapter `submitOrder()` — requires account hash configuration
- IBKR market data streaming — requires IB Gateway running

### Deferred (not blocking v1 functionality)

- `backfill-from-stream.ts` — only needed for NATS→Parquet migration
- Prometheus metrics instrumentation — needs `prom-client` + Grafana deployment

### Manually added to-dos

- Update Linux install to use secrets-manager creds
- Update .env.example
