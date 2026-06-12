# Signal Orchestrator TDD — RETIRED

> **Status: retired (Architecture B / M14).** The signal-driven trading
> loop this document described is gone. The old `server/signals/`
> ingress and the live **signal-tick orchestrator** (manifest walker,
> per-signal supervisor, boot-time + 15-min periodic scheduled-feed
> refresh loop) were removed across QF-260 / QF-261 / QF-281 / QF-339.
> There is no signal orchestrator in the codebase today.

This file is kept only as a redirect. The original document bundled
**two unrelated subsystems** under one title; they were disentangled in
QF-274. Here is where each half went:

| Old content                                                                                                                                                                                                 | Status                 | Where it lives now                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Live signal-tick orchestrator** — `server/orchestrator/` tick runner, signal manifests (`signal.yaml`), cron/interval/event schedule modes, per-tick adapter batching, `/api/signals/*` freshness surface | **Retired**            | Gone (Architecture B). See "What was retired" below.                                                                              |
| **Research / backtest-job orchestrator** — the Python `research/magpie-research/` service (job lifecycle, NATS event surface, single-writer guard)                                                    | **Surviving, current** | [research-orchestrator.md](research-orchestrator.md)                                                                              |
| **The "supervisor / scheduler process"** the orchestrator implied                                                                                                                                           | Partly obsolete        | [supervisor.md](supervisor.md) — what scheduling/supervision actually exists today (the ingest scheduler + NT-bundle supervision) |

## What was retired

- `server/signals/` (the signal ingress HTTP endpoint and the
  `signals.*` NATS subject family) — removed (QF-261 / QF-281 / QF-339).
  See [nats-subjects.md](nats-subjects.md), which no longer carries a
  signals subject family.
- The live signal-tick loop in the server: `collectScheduledFeeds()`,
  `refreshFeed()`, the boot-time `Promise.allSettled(...)` parallel
  refresh (root cause of the EIA HTTP 429 storm), and the 15-min
  `periodicTick` (`setInterval`) — removed (QF-260).
- The per-signal supervisor process that spawned signal-tick
  subprocesses (cron / interval / event modes) and managed the
  per-signal `enabled` flag — retired. The deployment doc records this:
  see [deployment-topology.md](deployment-topology.md) ("that supervisor
  is retired").
- The `tankers-and-wti` signal and `vol-buyer`'s orchestrator manifest —
  removed.

## What replaced it

In Architecture B there is no signal layer between data and strategies.
Scheduled data ingestion is now a plain cron-style scheduler, and
strategies are self-contained NautilusTrader bundles. The surviving,
load-bearing pieces are:

- **Scheduled data ingestion** — `scripts/scheduler.ts` (the
  `magpie-scheduler` container) plus the `deploy/systemd/`
  `magpie-ingest@*` timers. Documented in
  [supervisor.md](supervisor.md).
- **Data-source adapters** — `server/orchestrator/adapters/` survive as
  the per-source fetch shims invoked by the ingest job
  (`server/orchestrator/ingest.ts`). They are no longer driven by a
  signal-tick loop; they run from the scheduler's `ingest` job. See
  [deployment-topology.md](deployment-topology.md) and
  [data/CRON.md](../../data/CRON.md).
- **Research / backtest orchestration** — the Python service at
  [research-orchestrator.md](research-orchestrator.md).

For the prior full text of this TDD (the live-orchestrator design,
manifest schema, freshness model, GUI integration), consult the git
history: `git show 83cef76:docs/tdd/signal-orchestrator.md`.
</content>
