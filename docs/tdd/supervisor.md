# Supervisor / Scheduler — Component TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md). Deployment: [deployment-topology.md](deployment-topology.md). Live schedule: [data/CRON.md](../../data/CRON.md). Job queue: [write-jobs.md](write-jobs.md).

> **Status — premise partly obsolete; documents what actually exists.**
> The "signal scheduler / supervisor process" the originating ticket
> (QF-273) named — a daemon that spawned and supervised **signal-tick
> subprocesses** — **does not exist**. It was retired with the signals
> subsystem (Architecture B / M14; see
> [signal-orchestrator.md](signal-orchestrator.md) and
> [deployment-topology.md](deployment-topology.md)). This doc therefore
> documents the **two scheduling/supervision mechanisms that are real
> today**, and explicitly records what is gone, rather than inventing a
> supervisor that no longer exists.

## What "supervision" means in Architecture B

There is no single "supervisor process." Three distinct concerns that a
monolithic supervisor would have owned are now handled separately:

| Concern                              | Owner today                                                                                                                                                      | Where    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Scheduled data ingestion**         | The ingest **scheduler** — either the `magpie-scheduler` container (`scripts/scheduler.ts`) **or** the `deploy/systemd/` user timers (pick one, not both). | §1 below |
| **Long-running daemon lifecycle**    | The container runtime / `docker compose` (for `qf-server`, `magpie-scheduler`) and `systemd` (for timers).                                                 | §2 below |
| **Per-broker NT bundle supervision** | `systemd --user`, mirroring each broker's NautilusTrader unit on the credential host.                                                                            | §3 below |

What is **not** here, because it was retired: a process that reads signal
manifests, spawns per-signal tick subprocesses (cron / interval / event
modes), restarts them on crash with backoff, and toggles a per-signal
`enabled` flag. That was the live signal orchestrator's supervisor; it
is gone. See [signal-orchestrator.md](signal-orchestrator.md).

---

## 1. The ingest scheduler

The scheduler is the closest thing to a "supervisor process" that ships
today: a long-running daemon whose only job is to fire scheduled
data-ingest jobs at the right wall-clock times. It does **not** spawn
worker subprocesses it then supervises — each fired job is a short-lived
CLI that submits a write-job to the server and exits.

### Implementation — `scripts/scheduler.ts`

[`scripts/scheduler.ts`](../../scripts/scheduler.ts) is a
[`croner`](https://www.npmjs.com/package/croner)-based daemon. It holds a
static `JOBS` table — `{ name, schedule, command, args }` — and registers
one `Cron` task per job in `America/New_York`, with `protect: true` so a
still-running job is not double-fired.

Jobs (schedules are ET wall-clock):

| Job                    | Schedule       | Command                                            |
| ---------------------- | -------------- | -------------------------------------------------- |
| `collect-bulk`         | `0 20 * * *`   | `npm run collect:bulk` (MarketData options chains) |
| `ingest-fred`          | `0 19 * * 1-5` | `npm run ingest -- --source fred`                  |
| `ingest-eia`           | `0 11 * * 3`   | `npm run ingest -- --source eia`                   |
| `ingest-cftc`          | `0 20 * * 5`   | `npm run ingest -- --source cftc`                  |
| `databento-pull`       | `0 18 * * 1-5` | `npm run databento:pull`                           |
| `backup-observability` | `0 3 * * *`    | `npm run backup-observability`                     |

Each fire `spawn`s the command with `stdio: "inherit"` so the child's
output is captured by the container's stdout. The job's exit code is
logged (`ok` / `failed code=…`). `SIGINT`/`SIGTERM` stop all tasks and
exit cleanly. The daemon logs each task's next firing at startup.

### What a fired job does (no in-scheduler supervision)

`npm run ingest` runs [`scripts/ingest.ts`](../../scripts/ingest.ts) — a
**thin client**. It does not do the ingestion itself; it submits an
`ingest` write-job to the server's write-dispatch API
([write-jobs.md](write-jobs.md)) and polls for completion. The server's
`ingestHandler` ([`server/writeJobs/handlers/ingest.ts`](../../server/writeJobs/handlers/ingest.ts),
registered in [`server/writeJobs/init.ts`](../../server/writeJobs/init.ts))
runs `runIngest()` from
[`server/orchestrator/ingest.ts`](../../server/orchestrator/ingest.ts)
in-process, which drives the surviving per-source adapters under
[`server/orchestrator/adapters/`](../../server/orchestrator/adapters/).

So the scheduler is purely a **timer**: cron-fire → thin client → server
write-job. The single-writer property (one process writes DuckDB) is
preserved by routing through write-jobs, not by the scheduler. This is
also why running the container scheduler **and** the systemd timers
together is harmless apart from wasted work — the write-jobs idempotency
key dedupes same-day re-submits.

### Container — `Dockerfile.ingest`

The scheduler ships as the `magpie-scheduler` service. Its image is
built from [`Dockerfile.ingest`](../../Dockerfile.ingest)
(`node:22-bookworm-slim` — Alpine breaks duckdb's prebuilt glibc binary,
QF-167) with `CMD ["npm", "run", "--silent", "scheduler"]`. It runs on
`your-server.example.com` as a sibling to the other ops-repo services;
docker captures logs and owns lifecycle (`docker compose up/down`). See
[data/CRON.md](../../data/CRON.md) and
[deployment-topology.md](deployment-topology.md).

---

## 2. systemd timers (the alternative to the container scheduler)

The same scheduled ingestion can instead run as `systemd` **user** timers
under [`deploy/systemd/`](../../deploy/systemd/) — no root, no sudo, on
`your-server.example.com`. This is the "host cron" path; pick **either**
this **or** the container scheduler, not both (the systemd README is
explicit about avoiding duplicate submissions).

| Unit                                                 | Purpose                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `magpie-ingest@.service`                       | Template — `npm run ingest -- --source %i`. Instances: `fred`, `eia`, `cftc`, `fmp`, `yfinancial`, `portwatch`, `gfw`, `ofac`, `marinecadastre`. |
| `magpie-ingest@<source>.timer`                 | One per source; triggers the matching service.                                                                                                   |
| `magpie-rebuild-catalog.service`/`.timer`      | Rebuilds `portfolio.duckdb` from MinIO + mirrors it to S3 (`CATALOG_S3_PUSH=1`); every 6h.                                                       |
| `magpie-backup-observability.service`/`.timer` | Submits a `backup-observability` write-job (Loki + Prometheus → MinIO offsite DR); daily 03:00 ET.                                               |

These are **oneshot cron jobs, not daemons** — that is why they are
systemd timers rather than a compose service (the inverse of `qf-server`
/ the scheduler container, which are long-running daemons). Install via
the idempotent [`deploy/systemd/install.sh`](../../deploy/systemd/install.sh);
operate with `systemctl --user list-timers` / `start` / `status` and
`journalctl --user`. The host must be `America/New_York` (units use
unqualified ET wall clocks) and `loginctl enable-linger <user>` set so
user timers run when the user is logged out. Full reference:
[`deploy/systemd/README.md`](../../deploy/systemd/README.md).

---

## 3. Per-broker NT bundle supervision

The only surviving notion of process **supervision** (as opposed to
scheduling) is the per-broker NautilusTrader bundles on the credential
host. They run independently of where `qf-server` runs and are kept alive
by `systemd --user` mirroring each broker's NT unit; the operator
playbook for restarting a bundle after a crash is to restart that user
unit. This is deliberately lightweight — a dedicated supervisor process
is an explicitly deferred open item, to be revisited only if crash rates
warrant it.

References:
[deployment-topology.md](deployment-topology.md) ("the only surviving
'supervisor' notion is per-broker NT bundle supervision on the credential
host via `systemd --user`"),
[OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) ("Bundle supervision … revisit
during operational hardening if crash rates warrant a dedicated
supervisor process"), and
[broker-integration.md](broker-integration.md) for the bundle contract.

---

## What was retired (the obsolete ticket premise)

QF-273 assumed a signal scheduler / supervisor process. That process —
the live signal orchestrator's supervisor — is gone:

- It read `signal.yaml` manifests and spawned per-signal **tick
  subprocesses** in `cron` / `interval` / `event` modes.
- It supervised those subprocesses: heartbeat detection, crash restart
  with exponential backoff, clean SIGTERM/SIGKILL teardown.
- It owned the per-signal `enabled` flag and generated managed crontab
  blocks for `scheduled` feeds.

All of that was removed with the signals subsystem (QF-260 / QF-261 /
QF-281 / QF-339). The current architecture has no per-signal subprocess
supervision because there are no signal-tick subprocesses — strategies
are self-contained NT bundles, and data ingestion is the plain
timer-driven flow in §1/§2. See
[signal-orchestrator.md](signal-orchestrator.md) for the full
retirement record and [deployment-topology.md](deployment-topology.md)
for the topology rationale.

For backtest-job orchestration (a separate, surviving service), see
[research-orchestrator.md](research-orchestrator.md).
</content>
