# Signal Orchestrator TDD

> **Status: retired (M14-2 / QF-260).** The boot-time and periodic
> scheduled-feed refresh loop that previously lived in `server/index.js`
> has been removed. Ingestion is now owned exclusively by the M10 cron
> jobs (`ingest-fred`, `ingest-eia`, `ingest-cftc`, `databento-pull`)
> running in `scripts/scheduler.ts`.
>
> The `server/orchestrator/` module (adapter registry, manifest discovery,
> freshness checks, lifecycle, tick runner) remains in place and is still
> used by the `/api/signals/*` HTTP surface and the M10 ingest CLI.
>
> A full rewrite of this document is planned for M14-1. Until then, consult
> the source files directly — each one carries a `// Defined in:
docs/tdd/signal-orchestrator.md` header that points back here.

## What was removed (QF-260)

- `collectScheduledFeeds()` — helper that walked active manifests to build
  a list of `{ source, output, args }` tuples with `refresh.mode === "scheduled"`.
- `refreshFeed(feed)` — executed a single feed fetch via the adapter registry
  and recorded the result with `orchestratorApi.recordRefresh`.
- Startup `Promise.allSettled(scheduledFeeds.map(refreshFeed))` — fired all
  feeds in parallel at boot; root cause of the EIA HTTP 429 storm.
- `periodicTick` (`setInterval`, 15 min) — re-checked freshness and re-ran
  stale feeds on a timer.
- Dynamic imports of `getAdapter`, `adapterSupports` (from `adapter.ts`) and
  `checkFreshness` (from `freshness.ts`) that were only used by the above.

## What remains

The adapter registry, manifest discovery, freshness queries, and HTTP API
surface are unchanged. The `tankers-and-wti` signal directory and its
`orchestrator.json` entry have been removed; `vol-buyer` is the only active
signal.
