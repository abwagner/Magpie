# QF Deployment Topology — Component TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md). Companions: [strategy-deployment-topology.md](strategy-deployment-topology.md), [broker-integration.md](broker-integration.md), [write-jobs.md](write-jobs.md), [RUNBOOK.md](../RUNBOOK.md).

> **Status.** Decision recorded (Option B). The "where does the QF server live"
> question that QF-201 (deploy QF server) and the M10-6 MinIO IAM rotation both
> block on is resolved. **Rollout (QF-201 / M10-7): infrastructure-as-code
> landed** — the `magpie-server` compose service, `Dockerfile.server`,
> the Prometheus scrape target, and the RUNBOOK deploy/verify steps are in the
> repo (see [§6 migration step 1](#6-migration-sequence)). The **actual deploy
> and verification on `swagner-server` remain operator-only** and are tracked
> as the handoff in [RUNBOOK §5 "QF server deployment"](../RUNBOOK.md). M10-6
> IAM rotation is unblocked once that deploy lands.

---

## 1. Purpose & scope

M10 introduced a single-writer goal: exactly one process holds MinIO write credentials, and every write funnels through it (the [write-jobs queue](write-jobs.md)). That goal only constrains the **write-dispatch** piece — but the QF server bundles dispatch with a dozen other concerns (GUI, OrderPlane, Portfolio & Risk, audit, catalog, alerts). This doc decides which box each concern runs on, so M10-6 can rotate the IAM key against a process whose home is settled.

The companion [strategy-deployment-topology.md](strategy-deployment-topology.md) decides how **NT strategies** deploy (paper-live vs prod, per-strategy state contract). This doc decides where the **QF TS server + its infrastructure** deploy. The two are orthogonal: strategy code runs inside the per-broker NT bundles regardless of where the TS server sits.

> **Naming.** The home server is referred to throughout as `your-server.example.com`, matching the anonymized convention in [RUNBOOK §1](../RUNBOOK.md) and [TRADING-SYSTEM-TDD §Language Allocation](../TRADING-SYSTEM-TDD.md#language-allocation). In the operator's environment this is the box also referred to as `swagner-server`. The ops repo holding its `docker-compose.yml` is referred to as `your-ops-repo`.

### 1.1 What changed since the ticket was filed

The QF-202 ticket was written against the M10-era architecture, where the write-dispatcher lived inside a laptop `npm start` server process, brokers were bound to the laptop, and a supervisor spawned signal-tick subprocesses. **Three of those premises are now obsolete**, and this doc evaluates the options against current reality, not the ticket text:

| Ticket-era assumption                                                              | Current reality                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker connections (Schwab REST/streaming, IBKR TWS) live in-process on the laptop | Brokers run in **per-broker NautilusTrader bundles on a credential host**, reached over NATS. The TS server holds no broker credentials and speaks no broker protocols ([broker-integration.md §Overview](broker-integration.md#overview)). What used to pin the server to the laptop no longer does. |
| `server/signals` + signal models + NATS publisher are server concerns              | The `server/signals` subsystem and signal models were retired (QF-261 / QF-281 / QF-339). NATS is still optional-degraded at boot ([server/index.ts §5b](../../server/index.ts)) but signals plumbing is gone.                                                                                        |
| A supervisor spawns signal-tick child processes on the laptop                      | That supervisor is retired. The only surviving "supervisor" notion is per-broker NT bundle supervision on the credential host via `systemd --user` ([OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md)). Backtests moved to the sibling `quant-optimizer` repo and QF never spawns them.                       |
| The dispatcher is a slice that could be extracted from a laptop server             | The dispatcher is `server/writeJobs/`, already a clean module inside an **already-containerized** `qf-server` ([TRADING-SYSTEM-TDD §Deployment Architecture](../TRADING-SYSTEM-TDD.md#deployment-architecture)).                                                                                      |

The net effect: the things that historically tied the QF server to the laptop (in-process brokers, subprocess fleet) are gone, and the system TDD already declares a single-host `docker compose` target. This doc makes the topology **explicit and justified** rather than leaving M10-6 to assume it.

---

## 2. Component catalog

Each QF-server capability, where it runs **today**, and what it depends on. (NT-side components — risk gate, ExecAlgos, per-broker bundles, strategy plugins — are catalogued in [TRADING-SYSTEM-TDD §System Components](../TRADING-SYSTEM-TDD.md#system-components) and are not repeated here; they already live on the credential host by design.)

| Capability                                  | Lives at                                                                                                                                                           | Current location                                     | State-of-the-world dependencies                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Write-dispatch queue**                    | [`server/writeJobs/`](../../server/writeJobs/)                                                                                                                     | `qf-server` process                                  | MinIO **write** creds; `write_jobs` DuckDB table; per-actor bearer tokens. The single-writer pivot ([write-jobs.md](write-jobs.md)).              |
| **HTTP API + state WebSocket**              | [`server/index.ts`](../../server/index.ts)                                                                                                                         | `qf-server` (port 3001)                              | DuckDB; NATS (optional); serves the GUI backend.                                                                                                  |
| **Vite dev server**                         | [`vite.config.js`](../../vite.config.js)                                                                                                                           | Wherever a dev runs `npm run dev` (port 5173)        | Dev-only. Prod serves the built GUI bundle as static assets from `qf-server`. Not a deployed component.                                           |
| **Operator GUI (built)**                    | [`src/`](../../src/)                                                                                                                                               | Browser; assets served by `qf-server`                | `qf-server` HTTP + state WS. The browser can run anywhere with HTTPS reach to `qf-server`.                                                        |
| **Order Plane + Portfolio & Risk**          | [`server/order/`](../../server/order/) + [`server/portfolio/`](../../server/portfolio/) + [`server/risk/`](../../server/risk/)                                     | `qf-server` process                                  | DuckDB (audit chain, halts); NATS (NT-bridge RPC + exec-report observation); the per-broker bundles for reconciliation.                           |
| **Audit chain + DuckDB**                    | [`server/store/`](../../server/store/) + writers                                                                                                                   | `qf-server`; `portfolio.duckdb` on local disk        | File-based DuckDB, single-writer by construction. Server is the canonical writer; mirrors a read snapshot to MinIO ([RUNBOOK §3](../RUNBOOK.md)). |
| **Catalog / downloads / data-plane ingest** | [`server/catalog/`](../../server/catalog/), [`server/downloads/`](../../server/downloads/), [`server/orchestrator/adapters/`](../../server/orchestrator/adapters/) | `qf-server`; submitted via write-jobs                | MinIO; the scheduler container submits jobs over HTTP.                                                                                            |
| **Alerts router**                           | [`server/alerts/`](../../server/alerts/)                                                                                                                           | `qf-server`                                          | State WS for GUI banner; optional `SLACK_WEBHOOK_URL`.                                                                                            |
| **NATS**                                    | `nats` container ([docker-compose.yml](../../docker-compose.yml))                                                                                                  | `nats` container                                     | JetStream durable storage volume. Every cross-process boundary uses it.                                                                           |
| **MinIO**                                   | external infra                                                                                                                                                     | `your-server.example.com` already                    | S3 protocol. The data lake. IAM rotation (M10-6) makes write-jobs the sole write holder.                                                          |
| **Scheduler container**                     | [`scripts/scheduler.ts`](../../scripts/scheduler.ts)                                                                                                               | `your-server.example.com` (`magpie-scheduler`) | Calls `POST /api/write-jobs` with a `submit:write-job`-scoped token. Already on the server ([data/CRON.md](../../data/CRON.md)).                  |
| **Per-broker NT bundles**                   | [`research/magpie-{schwab,ibkr}-nt/`](../../research/)                                                                                                       | credential host                                      | Broker creds; IB Gateway (loopback); NATS. Independent of where `qf-server` runs.                                                                 |

Two facts fall out of this catalog and drive the decision:

1. **The only component that must hold MinIO write creds is the write-dispatch queue** — and it already sits beside the catalog/downloads/audit code that reads them.
2. **Nothing in the `qf-server` process is intrinsically laptop-bound any more.** The browser, the broker bundles, and IB Gateway are the only edge-of-network pieces, and all three already talk to `qf-server` over the network (HTTPS / NATS / NATS).

---

## 3. The options

The ticket framed four options. Each is evaluated below against five criteria: single-writer guarantee, GUI availability, broker reachability, dev ergonomics, deployment complexity.

### Option A — Thin dispatcher on server, full server on laptop

Extract just the dispatcher (write-jobs API + handlers + token store + `write_jobs` table) into a slim service on `your-server.example.com`. The laptop keeps the full server with read-only S3 creds and `WRITE_JOB_API_BASE` pointing at the server.

- **Single-writer:** achieved — only the slim service holds write creds.
- **GUI availability:** poor — GUI dies when the laptop is off.
- **Broker reachability:** unchanged (brokers are off-process either way).
- **Dev ergonomics:** good locally, but two codebases-in-one-repo to deploy.
- **Deployment complexity:** **high and now unjustified.** Its premise — that brokers + subprocesses pin the full server to the laptop — no longer holds. It also creates the split-DuckDB problem the ticket flags: `write_jobs` on the server's DuckDB, halts/portfolio/audit on the laptop's. Extraction work for no remaining benefit.

### Option B — Full server on `your-server.example.com`, laptop is a thin client

Deploy the whole `qf-server` container on the home server. The browser (and the broker bundles / IB Gateway where broker constraints require) is the only thing on the laptop. GUI works whether the laptop is on or not.

- **Single-writer:** achieved — `qf-server` holds the sole write key, exactly the M10-6 target.
- **GUI availability:** **best** — the server is always-on; any browser with HTTPS reach loads the GUI.
- **Broker reachability:** handled by the existing NATS boundary; see §5 for the IB-Gateway placement caveat.
- **Dev ergonomics:** local dev still runs `npm start` against `file://` or read S3 creds; prod is the server container. No code branch.
- **Deployment complexity:** **lowest residual** — the system TDD already targets single-host `docker compose` ([TRADING-SYSTEM-TDD §Deployment Architecture](../TRADING-SYSTEM-TDD.md#deployment-architecture)). This is "finish landing the declared target," not a new migration. The scheduler container precedent ([data/CRON.md](../../data/CRON.md)) and the tanker-dashboard / tanker-scheduler services in `your-ops-repo`'s `docker-compose.yml` (long-lived dashboard + cron daemon on the proxy network with a traefik route) are working precedents for the same shape.

### Option C — Status quo + cancel M10-6

Accept that "single writer" stays aspirational; revisit later.

- **Single-writer:** **abandoned.** The write key lives on a laptop that other read-only clients can't be cleanly fenced from.
- **GUI availability:** unchanged (laptop-bound).
- Rejected: M10 already shipped the dispatcher and the whole audit story is built on the single-writer claim; cancelling M10-6 strands that investment.

### Option D — Hybrid (dispatcher + read-only catalog API on server, broker + GUI on laptop)

A partial split between A and B.

- Carries Option A's split-DuckDB cost and Option A's GUI-availability weakness, while adding a second deploy surface. No criterion where it beats B. Rejected.

### 3.1 Scorecard

| Criterion               | A (thin dispatcher)    | **B (full server on host)** | C (status quo)       | D (hybrid)             |
| ----------------------- | ---------------------- | --------------------------- | -------------------- | ---------------------- |
| Single-writer guarantee | ✅ achieved            | ✅ achieved                 | ❌ abandoned         | ✅ achieved            |
| GUI availability        | ❌ laptop-bound        | ✅ always-on                | ❌ laptop-bound      | ❌ laptop-bound        |
| Broker reachability     | ➖ unaffected          | ➖ unaffected (see §5)      | ➖ unaffected        | ➖ unaffected          |
| Dev ergonomics          | ➖ two deploy surfaces | ✅ one image, no branch     | ✅ nothing to change | ❌ two deploy surfaces |
| Deployment complexity   | ❌ high, split DuckDB  | ✅ lowest residual          | ✅ none              | ❌ highest             |

---

## 4. Decision

**Chosen: Option B — the full `qf-server` runs on `your-server.example.com` as the `qf-server` container; the laptop is a browser plus, where broker constraints require it, an IB-Gateway host.**

Rationale:

1. **It is the M10-6 target by construction.** A single always-on `qf-server` holding the sole MinIO write key is exactly what the IAM rotation wants to fence. No extraction, no split database.
2. **The architecture already declared it.** [TRADING-SYSTEM-TDD §Deployment Architecture](../TRADING-SYSTEM-TDD.md#deployment-architecture) targets single-host `docker compose` with an always-on `qf-server`. This doc records the explicit decision; QF-201 lands it.
3. **The laptop-pinning forces are gone.** Brokers are off-process NT bundles over NATS; the signal-tick subprocess supervisor is retired; backtests live in `quant-optimizer`. Nothing left in `qf-server` needs the laptop.
4. **GUI availability is strictly better** — the operator can check the dashboard from any browser without the laptop being awake, which matters for a system that trades while the operator is away.
5. **It keeps DuckDB single-writer trivially.** `portfolio.duckdb` stays a single file owned by the one `qf-server`; the existing read-snapshot-to-MinIO mirror ([RUNBOOK §3](../RUNBOOK.md)) continues to serve laptop read copies. Option A would have split this file across two boxes.

---

## 5. What didn't change (laptop-bound things)

Choosing Option B does **not** mean everything moves to the server. The following stay at the network edge, and operator expectations should be set accordingly:

| Thing                                        | Where it stays                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IB Gateway**                               | A host with a reliable interactive login — laptop today, candidate to move | IB Gateway needs interactive credential login + (sometimes) a GUI, and IBKR may apply IP allowlisting. The system TDD already runs it on the host OS outside compose ([TRADING-SYSTEM-TDD §Out-of-Compose infrastructure](../TRADING-SYSTEM-TDD.md#out-of-compose-infrastructure)). `qf-nt-ibkr` reaches it on a loopback port, so the gateway and the IBKR bundle must be co-located. Whether that co-located pair lives on the server or the laptop is a follow-up (§6). |
| **Schwab streaming/REST**                    | Inside `qf-nt-schwab` on the credential host                               | Schwab may IP-allowlist the app key; the credential host's egress IP must be the allowlisted one. This is a credential-host property, independent of where `qf-server` runs.                                                                                                                                                                                                                                                                                               |
| **Vite dev server (5173)**                   | Developer laptops only                                                     | Dev-only. Prod serves the built GUI bundle as static assets from `qf-server`. Never a deployed component.                                                                                                                                                                                                                                                                                                                                                                  |
| **`npm start` (server + vite concurrently)** | Developer laptops only                                                     | Dev convenience launcher. The server container runs `npm run server` (tsx) directly with read-or-write S3 creds per environment.                                                                                                                                                                                                                                                                                                                                           |
| **`quant-optimizer` + its dashboard**        | Operator/author machine                                                    | QF does not initiate backtests; QO is operator-initiated and reads the shared lake. Its localhost dashboard is unaffected by this decision ([TRADING-SYSTEM-TDD §Model & Strategy Promotion Pipeline](../TRADING-SYSTEM-TDD.md#model--strategy-promotion-pipeline)).                                                                                                                                                                                                       |

The hot-path `Storage.storeChain` exception ([write-jobs.md §"chain-store"](write-jobs.md) and [server/storage.ts](../../server/storage.ts)) is also unchanged: live-fetch chain writes stay direct (in-process, bypassing the write-jobs HTTP hop) because they're latency-sensitive. Under Option B that in-process call still runs inside the single `qf-server` that holds the write key, so the single-writer invariant holds without special handling.

---

## 6. Migration sequence

Ordered follow-up tickets to land Option B. These belong in the M10 module and should be filed against it; QF-201 and M10-6 unblock once the topology decision (this doc) merges.

1. **QF-201 — Deploy `qf-server` on `your-server.example.com`.** **IaC landed.** The server image is built from [`Dockerfile.server`](../../Dockerfile.server) (`npm run server`, node:22-bookworm-slim — Alpine breaks duckdb, QF-167; not the GUI-only [Dockerfile](../../Dockerfile)). It is added to the project [`docker-compose.yml`](../../docker-compose.yml) as the **`magpie-server`** service: port 3001, `env_file: .env` + `environment` (`APP_ENV=prod`, `NATS_URL=nats://nats:4222`), a persistent `magpie-server-data` volume for `portfolio.duckdb`, `DATA_URI=s3://…` + **write** S3 creds from `.env`, and a `/api/status` healthcheck. The `qf-server` Prometheus scrape job ([prometheus.yml](../../deploy/observability/prometheus.yml)) now also targets `magpie-server:3001`. Compose service (not systemd) because it is a long-running daemon on a shared network — same shape as `magpie-scheduler` / the ops-repo `tanker-dashboard`; the `deploy/systemd/` units are oneshot cron jobs, not daemons. **Operator-only remainder:** the actual `docker compose up -d --build magpie-server` on `swagner-server` and the reachability / M10-5 / M10-6 verification — see [RUNBOOK §5 "QF server deployment"](../RUNBOOK.md). (Traefik route / TLS for external GUI exposure stays an open item, §7.)
2. **QF-XXX — Decide IB-Gateway placement.** Choose whether the IBKR bundle + IB Gateway pair stays on the laptop (server reaches the bundle over NATS; gateway stays loopback-local to the bundle) or moves to a server-adjacent host. Document the chosen home in [broker-integration.md](broker-integration.md) and the RUNBOOK. This is the one genuinely open broker question Option B leaves.
3. **M10-6 — Rotate MinIO IAM to single-writer.** Issue a write-scoped key bound to the `qf-server` container only; reissue read-only keys for every other client (laptop dev, QO, ad-hoc tools). Verify no other process can write. Unblocked once QF-201 lands.
4. **QF-XXX — Laptop read-only profile.** Document/ship the laptop's read-only `.env` profile (`DATA_URI=s3://…` + read creds, `WRITE_JOB_API_BASE` → `your-server.example.com` for submitting jobs) so a developer can run the full GUI against the canonical lake without write creds.
5. **QF-XXX — Serve the built GUI from `qf-server` in prod.** Confirm the server serves the Vite production build as static assets so the deployed GUI needs no Vite process; retire any assumption that 5173 exists in prod.

(Ticket numbers beyond QF-201 / M10-6 are placeholders — file them in Plane against M10 when this doc merges. They are listed here as the migration contract, per the ticket's "migration sequence" deliverable.)

---

## 7. Open questions

| Question                                                          | Owner / trigger                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Does IB Gateway move off the laptop, and if so to what host?      | Migration step 2. Trigger: IBKR goes live in prod.                                                         |
| Backup/restore policy for the server's `portfolio.duckdb` volume. | Operational hardening. The MinIO read-snapshot mirror is a partial answer; a proper backup cadence is TBD. |
| TLS termination for the GUI on the server (traefik route + cert). | QF-201. Follows the tanker-dashboard traefik precedent in `your-ops-repo`.                                 |

When any of these is resolved, fold the answer back into this doc and the relevant companion (broker-integration / RUNBOOK), per the project's single-source-of-truth convention.
