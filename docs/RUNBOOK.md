# Trading System Runbook

Step-by-step operational guide for setting up, running, and maintaining the trading system. For system design, see the [TDD series](tdd/). For data source details and costs, see [data/sources.md](data/sources.md). For in-flight work, see [Plane → Magpie](<internal tracker>) (the legacy `docs/TODO.md` was archived under [`archive/TODO.md`](archive/TODO.md) when work moved to Plane).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Environment setup](#2-environment-setup)
3. [Infrastructure (NATS)](#3-infrastructure-nats)
4. [Config files](#4-config-files)
5. [Historical data collection](#5-historical-data-collection)
6. [Starting the system](#6-starting-the-system)
7. [Managing strategies](#7-managing-strategies)
8. [Running backtests](#8-running-backtests)
9. [Paper trading](#9-paper-trading)
10. [Going live](#10-going-live)
11. [Monitoring](#11-monitoring)
12. [Maintenance](#12-maintenance)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prerequisites

### Software

- [ ] Node.js 20+ (LTS)
- [ ] Docker and Docker Compose (for NATS, IB Gateway)
- [ ] Git
- [ ] **For new dependencies:** see [dependency-admission.md](dependency-admission.md) for the admission workflow (5-step gate: open admission file → CI validates → peer review → pin + document → merge). Skip the gate only on revert-style PRs that go through `git revert`.

### Accounts & credentials

- [ ] **MarketData.app** — Trader plan (100k credits/day) is the assumed default for nightly universe collection. Get API token from dashboard.
- [ ] **IBKR** — Brokerage account with API access enabled. NYMEX L1 data subscription (~$10/mo) if trading futures options.
- [ ] **Schwab** (optional) — Brokerage account. Developer app created at developer.schwab.com with callback URL `https://127.0.0.1:8182`.

### Verify

```bash
node --version    # 20+
docker --version  # any recent
docker compose version
git --version
```

---

## 2. Environment setup

Magpie (this repo) is the **framework** and runs standalone — the GUI,
data lake, risk engine, and order plane work without any sibling repos. Live
NautilusTrader strategies and offline backtesting live in **separate**
repositories (`quantfoundry-strategies`, `quant-optimizer`) that you supply and
clone alongside QF; replace `your-org` below with wherever you host them. Skip
those clones if you only want the framework.

```bash
# Clone QF (and, optionally, your own strategy/optimizer repos) under one parent.
cd ~/code
git clone https://github.com/your-org/Magpie.git
# Optional siblings — only if you run Python strategies / backtests:
# git clone https://github.com/your-org/quant-optimizer.git
# git clone https://github.com/your-org/quantfoundry-strategies.git

# Install QF's npm deps
cd Magpie
npm install

# Create the gitignored `strategies/` symlink so strategies are
# discoverable from inside QF as `strategies/<name>/`.
./scripts/setup-strategies-symlink.sh

# Create env file from template
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# Required for market data
MD_TOKEN=your_marketdata_app_token

# Required for IBKR (futures data + trading)
IBKR_HOST=127.0.0.1
IBKR_PORT=4002

# Optional (Schwab equities)
SCHWAB_APP_KEY=your_schwab_app_key
SCHWAB_APP_SECRET=your_schwab_app_secret
SCHWAB_REFRESH_TOKEN=          # filled after first OAuth flow

# Optional overrides
# NATS_URL=nats://localhost:4222
# PORT=3001
# LOG_LEVEL=info
```

### Data backend (MinIO vs local filesystem)

Magpie reads/writes Parquet data through `DATA_URI`, which is either a local filesystem path or a MinIO/S3 bucket. The home server (`your-server.example.com`) is the canonical writer and points at MinIO; laptops can use either mode.

| Mode  | `DATA_URI`                        | When to use                                                                     |
| ----- | --------------------------------- | ------------------------------------------------------------------------------- |
| Local | `file:///abs/path/to/Magpie/data` | Single-machine dev, no MinIO available                                          |
| MinIO | `s3://quantfoundry-data`          | Default for the server; recommended for laptops that want the canonical dataset |

S3 mode requires four extra vars: `S3_ENDPOINT_URL=<your-s3-endpoint>`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY=…`, `S3_SECRET_KEY=…`. The full annotated list of every environment variable lives in [`.env.example`](../.env.example) — copy it to `.env` and fill in the values you need.

Legacy: `DATA_DIR=…` is still honored as a fallback when `DATA_URI` is unset (treated as a `file://` root).

### Verify

```bash
npm run test   # 368 tests should pass
npm start      # server on :3001 (via tsx), vite on :5173
```

- [ ] Tests pass
- [ ] GUI loads at http://localhost:5173
- [ ] Server health check: `curl http://localhost:3001/api/status`
- [ ] System status: `curl http://localhost:3001/api/system/status`

---

## 3. Infrastructure (NATS)

NATS JetStream is the internal message bus for signals. A `docker-compose.yml` is included in the repo.

### Start NATS

```bash
docker compose up -d nats
```

This starts NATS 2.10 with JetStream enabled, 256MB memory store, 1GB file store, data persisted in a Docker volume.

### Verify

```bash
# Check NATS is running
curl http://localhost:8222/healthz

# Check JetStream is enabled
curl http://localhost:8222/jsz
```

- [ ] NATS running on port 4222 (`docker compose ps`)
- [ ] JetStream enabled (8222/jsz returns data)

---

## 4. Config files

All config files ship with the repo with sensible defaults. Review and adjust for your deployment. Authoritative schemas live in the linked TDDs.

| File                          | Purpose                                                                            | Hot-reload?                | Schema in                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `config/portfolios.json`      | Portfolios: broker routing, initial cash, risk limits, reconciliation cadence      | No (restart required)      | [cross-cutting.md §3](tdd/cross-cutting.md#3-system-wide-config-layout) |
| `config/brokers.json`         | Per-broker bundle wiring: credential host, NATS subjects, accounts                 | No (restart required)      | [broker-integration.md](tdd/broker-integration.md)                      |
| `config/market-data.json`     | Bridge subscriptions, NATS topics, freshness rules                                 | No (restart required)      | [data-plane.md](data/data-plane.md)                                     |
| `config/market-calendar.json` | Trading hours, holidays per exchange                                               | No (restart required)      | [cross-cutting.md §2](tdd/cross-cutting.md#2-time--market-calendar)     |
| `config/risk_limits.yaml`     | Per-portfolio risk limits (bootstraps from `portfolios.json.limits` on first boot) | Yes (file-watched, ~500ms) | [portfolio-risk-engine.md §8](tdd/portfolio-risk-engine.md)             |
| `config/alerts.yaml`          | Alert rules + routing                                                              | Yes (file-watched, ~500ms) | [alerts.md](tdd/alerts.md)                                              |

### Key configuration choices

**`config/portfolios.json`** — Declares which broker each portfolio routes through, its initial cash, its risk limits, and reconciliation cadence. Strategies are **not** declared here — they're NT-resident in the `quantfoundry-strategies` repo and enabled / disabled via the lifecycle registry (`server/strategy/lifecycle.ts` per [strategy-deployment-topology.md](tdd/strategy-deployment-topology.md)). There is no `mode` field — paper vs live is a **bundle-credentials distinction**, not a QF-side code-path branch (see §9 Paper trading and §11 Going live).

**`config/risk_limits.yaml`** — On first boot, the runtime bootstraps this file from `portfolios.json.limits`. After that, this YAML is the source of truth; editing `portfolios.json.limits` post-bootstrap has no effect on running limits.

**`config/market-calendar.json`** — Must include the current year's holidays. Update once per year when exchange schedules are published. The file includes US_EQUITY and CME exchanges.

### `config/market-data.json` — `nt_bridge` block

The `nt_bridge` block gates the Python NT MD bridge (`research/quantfoundry-md-bridge/`).
Default is `enabled: false`. Schema + design at
[`docs/tdd/broker-integration.md` §6.2](tdd/broker-integration.md#62-configmarket-datajson-nt_bridge-block).

```json
"nt_bridge": {
  "enabled": false,
  "brokers": ["schwab"],
  "mode": "observe",
  "timeouts": { "quote_ms": 2000, "chain_ms": 5000 },
  "heartbeat_stale_ms": 30000
}
```

**Modes:**

- `observe` — append nt-bridge adapter at lowest priority. Legacy still owns prod;
  nt-bridge fills in only when every legacy adapter fails. Used for the initial
  bring-up window. Doesn't introduce risk.
- `first` — prepend nt-bridge at highest priority. NT becomes canonical, legacy
  is fallback. Flip here after observe-mode metrics confirm parity.
- `only` — replace legacy entirely. Final state before code-level decommission
  (M13-08 / M13-09).

**Refuse-to-start guard.** If `enabled: true` and NATS isn't reachable at boot,
the server logs an error and exits. Same posture as the QF-242 brokers config.

**Staged ramp (Q2 — recommended):**

1. **Bring up the Python services.** Start `quantfoundry-md-bridge.schwab` (and
   later `.ibkr`) via systemd:
   ```bash
   sudo systemctl enable --now schwab-md-bridge.service
   journalctl -u schwab-md-bridge.service -f
   ```
   Confirm heartbeats land:
   ```bash
   nats sub 'marketdata.>'
   # Expect: marketdata.schwab.heartbeat every ~10s
   ```
2. **Flip to `observe` for snapshot RPC only.** Edit `nt_bridge` to
   `enabled: true`, `brokers: ["schwab"]`, `mode: "observe"`. Restart the QF
   server. Inspect `/api/data/sources/health` — the nt-bridge/schwab adapter
   should appear alongside the legacy schwab adapter. Streamer subscriptions
   stay off (no symbol streams yet).
3. **Add streamer subscriptions only after snapshot parity holds for ≥ 24h.**
   Avoids running two streamer connections against Schwab simultaneously
   (Schwab caps concurrent streamer sessions per app key).
4. **Flip to `first` after error rate ≤ legacy + 0.1% and p95 latency ≤
   1.2× legacy.** NT becomes canonical; legacy is the safety net.
5. **Flip to `only` after ≥ 2 trading days stable in `first`.** Final pre-
   decommission state. M13-08 then deletes the legacy `schwab.ts` adapter.
6. **Repeat steps 1-5 for IBKR.** Important: keep the order broker → MD
   on the same shared `TradingNode` per TDD §7. IB Gateway permits one
   TWS-API client per client-id; M13-06's bridge module loads into the
   same process as QF-240's `IbkrBrokerBridge`.

**Rollback.** If anything misbehaves, revert `mode` to `observe` (or
`enabled: false`) and restart. The legacy adapter is unmodified through
M13-07; only M13-08/M13-09 delete it.

### Verify

```bash
# All configs parse without error
node -e "JSON.parse(require('fs').readFileSync('config/signals.json'))"
node -e "JSON.parse(require('fs').readFileSync('config/market-data.json'))"
node -e "JSON.parse(require('fs').readFileSync('config/portfolios.json'))"
node -e "JSON.parse(require('fs').readFileSync('config/market-calendar.json'))"
```

- [ ] All four config files present and valid JSON
- [ ] `config/market-calendar.json` has current year's holidays
- [ ] `config/portfolios.json` mode is `paper_local`

---

## 5. Historical data collection

Backtesting and model training require historical chain data in Parquet. The system includes an automated nightly collection pipeline that maximizes use of the MarketData.app API credit budget.

### Universe file

The symbol list lives in `config/universe.txt` — one ticker per line, `#` for comments. Currently includes the full S&P 500, NASDAQ-100 extras, sector ETFs, and thematic names (~540 symbols).

To add symbols, just add lines to the file. The nightly collector picks them up automatically.

### Nightly automated collection

A long-running container on the home server (`your-server.example.com`) fires four scheduled jobs via `croner`:

| Job            | When (America/New_York) | What                                                        |
| -------------- | ----------------------- | ----------------------------------------------------------- |
| `collect-bulk` | Daily 20:00             | MarketData options-chain bulk pull (`npm run collect:bulk`) |
| `ingest-fred`  | Weekdays 19:00          | FRED macro series                                           |
| `ingest-eia`   | Wednesdays 22:30        | EIA petroleum (post-WPSR)                                   |
| `ingest-cftc`  | Fridays 20:00           | CFTC COT positions                                          |

The container is defined as the `quantfoundry-scheduler` service in `your-ops-repo/docker-compose.yml` and built from [`Dockerfile.ingest`](../Dockerfile.ingest). The entrypoint is [`scripts/scheduler.ts`](../scripts/scheduler.ts) — edit the `JOBS` array there to change schedules.

`collect-bulk` writes to `data/chains/{symbol}-YYYY-MM.parquet` (or `s3://quantfoundry-data/chains/...` in S3 mode). For each symbol it determines missing date ranges and forward-fills to yesterday, stopping gracefully on rate limit (429) and resuming the next night. Target range: 2019-01-02 to yesterday (7+ years).

**Credit budget:** 100,000 credits/day. Each symbol costs ~560 credits for 2+ years of history (~1 credit per trading day). At this rate the collector processes ~170 symbols per night. A full 540-symbol universe with 5-year backfill takes about 8 days to complete, then the nightly job just collects yesterday's data going forward (~540 credits/night).

**Viewing logs / operating the container** is documented in [`data/CRON.md`](../data/CRON.md#operating-the-container). The short version:

```bash
# On the server
docker compose logs -f quantfoundry-scheduler                       # tail live
docker compose exec quantfoundry-scheduler npm run ingest -- --source fred   # force-run
```

### Manual collection

```bash
# Collect a single symbol
npm run collect -- --symbol SPY --from 2024-01-02 --to 2024-12-31

# Resume if interrupted
npm run collect -- --symbol SPY --from 2024-01-02 --to 2024-12-31 --resume

# Dry-run: see what the nightly collector would do without collecting
DRY_RUN=1 ./scripts/collect-nightly.sh

# Run nightly collector manually (uses full credit budget)
./scripts/collect-nightly.sh
```

### Monitoring collection

```bash
# Watch nightly progress (run on the server)
docker compose logs -f quantfoundry-scheduler

# Check what's been collected (per-symbol manifest, on the server)
cat ~/GitHub/Magpie/data/chains/.manifest.json | python3 -m json.tool

# Summary: total symbols, credits, contracts
cat ~/GitHub/Magpie/data/chains/.manifest.json | python3 -c "
import json, sys
m = json.load(sys.stdin)
print(f'Symbols: {len(m)}')
print(f'Credits: {sum(v.get(\"totalCredits\",0) for v in m.values()):,}')
print(f'Contracts: {sum(v.get(\"totalContracts\",0) for v in m.values()):,}')
"

# Disk usage (local mode)
du -sh data/chains/

# MinIO mode: list what's in the bucket
aws s3 ls --endpoint-url https://s3.example.com s3://quantfoundry-data/chains/ | head

# Confirm the container is up
docker compose ps quantfoundry-scheduler
```

### Fetching the catalog DB to your laptop

`portfolio.duckdb` is a file-based DB that can't live writeable in MinIO. The server is the canonical writer; it mirrors a snapshot to `s3://quantfoundry-data/duckdb/portfolio.duckdb` after each rebuild. Laptops pull a read copy:

```bash
./scripts/fetch-catalog.sh
# Pulls s3://quantfoundry-data/duckdb/portfolio.duckdb → $CATALOG_DB_PATH (default ./data/portfolio.duckdb)
```

Run this before `scripts/signal-health.ts` if you want the latest server-rebuilt catalog.

The GUI Data tab also shows an overview of all stored data — symbols, date ranges, strike depth, and contract counts.

### Futures options (IBKR)

Requires IB Gateway running (separate from the MarketData.app pipeline):

```bash
# Snapshot current day's futures chains
npm run snapshot -- --symbols CL,ES
```

Optional daily cron (30 min after equity close):

```bash
30 17 * * 1-5 cd /path/to/Magpie && npm run snapshot >> data/chains/.snapshot.log 2>&1
```

### Storage

Data is stored as Parquet files in `data/chains/` with the naming convention `SYMBOL-YYYY-MM.parquet`. Each file contains one month of daily chain snapshots for a single symbol.

- ~2 KB per contract per day (Parquet is highly compressed)
- ~540 symbols × 5 years ≈ 300–500 MB total
- Safe to delete and re-collect any file (the nightly collector will detect the gap)

### Verify

```bash
ls data/chains/
# Should see: SPY-2024-01.parquet, SPY-2024-02.parquet, etc.
```

- [ ] `config/universe.txt` contains desired symbols
- [ ] `crontab -l` shows the nightly collection job
- [ ] `data/chains/.nightly.log` shows recent successful runs
- [ ] Data tab in GUI shows stored symbols and date ranges

### Write-dispatch + fundamentals backfill (M10)

**M10-1: write-dispatch hard cutover.** As of M10-1, every MinIO write goes
through the QF server's dispatch API at `POST /api/write-jobs`. Direct-write
CLI paths are removed. Operators authenticate with a per-actor bearer token
issued via:

```bash
# One-time per operator/host. Capture the token — it is not stored in plaintext.
npm run issue-write-token -- --actor operator-yourname --scopes fmp-backfill
# Or for cron / unattended use:
npm run issue-write-token -- --actor cron-server --scopes '*'
```

Token file lives at `data/secrets/write-job-tokens.json` (override with
`WRITE_JOB_TOKEN_PATH`). Set `WRITE_JOB_TOKEN=<plaintext>` in `~/.env` so the
CLIs and scripts pick it up automatically. The M10-1 cutover supersedes the
QF-191 hotfix (PR #111) that taught the old script to load `.env` and run
against `s3://` — the new thin-client script handles both via the dispatcher.

**M10-5: cron generator cutover.** Feed-refresh cron entries no longer shell
out to the orchestrate CLI. `generateCronEntries()` now emits
`curl -X POST /api/write-jobs` lines targeting the `orchestrate-refresh` kind:

```cron
# feed: fred → macro/fred/wti_spot.parquet (consumers: vol-buyer-spy)
CRON_TZ=America/New_York
0 19 * * 1-5 curl -fsS -H "Authorization: Bearer $(cat ${WRITE_JOB_TOKEN_PATH:-data/secrets/write-job-tokens.token})" -H "Content-Type: application/json" -X POST http://localhost:3001/api/write-jobs -d '{"kind":"orchestrate-refresh","params":{"source":"fred","args":{"series":"DGS10"},"output":"macro/fred/wti_spot.parquet"}}' 2>&1 | logger -t ds-orchestrator
```

The cron host needs a plaintext-token file at the path the curl line reads. The
token-store JSON only keeps hashes; create a sibling `.token` file with the
plaintext when you issue (or pull it from your secrets manager and mount on the host).

`scripts/scheduler.ts` (the in-container scheduler for collect-bulk / ingest /
sync-to-s3) is unchanged — its JOBS array invokes `npm run …` which already
flows through the M10-3 thin clients.

**Fundamentals backfill (now a write-job).** The live fundamentals pipeline
(yfinance) produces snapshots going forward only.
For any PEG-style strategy that needs years of history, submit the FMP backfill
**once** before starting strategy work:

```bash
# Default universe (fundamentals/yfinance/universe.parquet)
npm run fmp-backfill

# Override universe parquet
npm run fmp-backfill fundamentals/sox/universe.parquet

# Bump rate-limit for FMP Premium / Ultimate
FMP_RATE_LIMIT_PER_SEC=12 npm run fmp-backfill
```

The CLI POSTs a `fmp-backfill` job to `/api/write-jobs` and polls until done.
The server-side handler pulls 7 historical kinds (dividends, splits, income /
balance / cash flow, key metrics, daily rating) per ticker into
`${DATA_URI}/fundamentals/fmp/historical_*.parquet`. Progress is tracked in
the `write_jobs` DuckDB table (`server/writeJobs/store.ts`); re-runs are
idempotent (`mergeAndWriteParquet` upserts on each kind's dedup key). Duplicate
submits with identical params collapse onto a single job_id while the original
is queued or running.

Requires `FMP_API_KEY` on the server's process (not the CLI's), `DATA_URI`,
and a `fmp-backfill`-scoped write token.

---

## 6. Starting the system

```bash
# Start NATS first (if not already running)
docker compose up -d nats

# Start the trading system (server + GUI dev server)
npm start
```

The server runs via `tsx` (TypeScript execution) on port 3001. Vite dev server for the GUI runs on port 5173.

### Startup sequence

The server initializes components in dependency order. This list mirrors the canonical sequence in the [top-level TDD](TRADING-SYSTEM-TDD.md#startup-sequence) — that TDD is the source of truth; this section is the operator-facing cross-reference.

1. DuckDB + table initialization
2. Market calendar
3. Config loaders (risk limits, quality thresholds, risk policies, brokers, portfolios)
4. Storage (`createStorage` resolves `DATA_URI`)
5. Store query interface + API
6. Catalog service + API
7. Downloads service + API
8. NATS connection + publisher
9. Portfolio Engine — one per portfolio in `config/portfolios.json`
10. Order Plane (audit writers, NT-bridge adapter, Trade Inspector, Trade Journal, metrics)
11. Strategy lifecycle + config store + risk stores + halts + alerts router
12. Write-jobs runtime
13. State WebSocket (`/ws/state`) + HTTP routes
14. Scheduled jobs (quality evaluator, retention)

If any required dependency fails (e.g., DuckDB can't initialize), the server logs the error and exits. There is no degraded-state startup at v1.

### Verify startup

```bash
# Server status (existing route)
curl http://localhost:3001/api/status

# System status (new route — shows mode, halt state, NATS, sources)
curl http://localhost:3001/api/system/status

# Store summary (signal + chain data overview)
curl http://localhost:3001/api/store/summary

# Portfolio state
curl http://localhost:3001/api/portfolio/main
```

- [ ] Server starts without errors
- [ ] `/api/system/status` returns `halted: false`, all configured portfolios listed
- [ ] `/api/portfolio/main` returns portfolio state with configured `initial_cash`
- [ ] GUI connects at http://localhost:5173, Risk Dashboard tab shows portfolio state

---

## 7. Managing strategies

Strategies are NT-resident — they live in the sibling `quantfoundry-strategies` repo and run inside the per-broker NT bundle (one `TradingNode` per broker, co-tenanting all strategies bound to that broker per [strategy-deployment-topology.md](tdd/strategy-deployment-topology.md)). The TS server maintains the **strategy lifecycle registry** (`server/strategy/lifecycle.ts`) which tracks each strategy's state and surfaces it to the GUI and the gate evaluator.

Strategy lifecycle states: `registered` → `enabled` → `running` → `paused` → `halted` → `retired`. The GUI's Strategies workspace and the API below are the operator surfaces.

### Listing strategies

```bash
# All strategies + their lifecycle state
curl http://localhost:3001/api/strategies

# Detail for one strategy: drift signals, recent gate decisions, exit policy
curl http://localhost:3001/api/strategies/<strategy_id>
```

Or use the GUI: **Strategies workspace** → strategy list → click any row.

### Transitioning strategy state

Strategy state transitions go through `POST /api/strategies/<strategy_id>/transition` (scope: `transition:strategy`). The lifecycle registry validates the transition and broadcasts the change over NATS to the bundle launcher, which calls `node.add_strategy()` / `node.stop_strategy()` on the live `TradingNode` per [strategy-deployment-topology.md §8 Rollback and hot-swap](tdd/strategy-deployment-topology.md#8-rollback-and-hot-swap).

```bash
# Enable a registered strategy (preparation; doesn't start trading yet)
curl -X POST http://localhost:3001/api/strategies/<strategy_id>/transition \
  -H 'Content-Type: application/json' \
  -d '{"to": "enabled"}'

# Start trading (transitions enabled → running)
curl -X POST http://localhost:3001/api/strategies/<strategy_id>/transition \
  -H 'Content-Type: application/json' \
  -d '{"to": "running"}'

# Operator halt — blocks new submissions, leaves existing positions open
# (per order-execution.md §5.3)
curl -X POST http://localhost:3001/api/strategies/<strategy_id>/halt

# Resume after halt
curl -X POST http://localhost:3001/api/strategies/<strategy_id>/resume

# Retire (terminal; see strategy-deployment-topology.md for offboarding semantics)
curl -X POST http://localhost:3001/api/strategies/<strategy_id>/transition \
  -H 'Content-Type: application/json' \
  -d '{"to": "retired"}'
```

Or via the GUI: each strategy row has explicit transition buttons (Enable / Run / Pause / Halt / Resume).

### Strategy config and overrides

A strategy's parameters (entry / exit thresholds, sizing, exec-algorithm settings) live in the strategy package itself (`quantfoundry-strategies/<strategy>/config.yaml` or equivalent). Mid-run overrides — most commonly tightening an exit rule's stop threshold — go in `config/strategy_overrides.yaml` per [order-execution.md §5.1](tdd/order-execution.md#51-strategy-declared-exit-rules). Activation of an override is audit-recorded; mid-trading-day changes are intentional friction.

```bash
# Inspect the strategy's current effective exit policy (declared + overrides)
curl http://localhost:3001/api/strategies/<strategy_id>/exit-policy
```

### Verify

- [ ] Strategies list visible in GUI Strategies workspace and via `GET /api/strategies`
- [ ] Strategy transitions land in the audit / lifecycle log
- [ ] A transition to `running` results in the strategy appearing on the live `TradingNode` (verify via bundle logs)

---

## 8. Running backtests

Backtests run in the sibling `quant-optimizer` repo against the shared MinIO data lake. QF does not initiate backtests. Run sweeps directly via the QO CLI on the strategy adapter — see the per-strategy READMEs under `quantfoundry-strategies/`. The GUI's **Backtests** workspace surfaces resulting `wfo_results` archives via [`server/catalog/collectors/qo-runs.ts`](../server/catalog/collectors/qo-runs.ts).

Per-run backtest metrics (Sharpe, Sortino, drawdown, etc.) for NT / QO sweeps live in `${DATA_URI}/results/qo/<sweep>/wfo_results_*.json`. The catalog collector indexes these into DuckDB so the GUI can list and drill into them without re-scanning the data lake.

### Promoting a backtest result to a pinned baseline

A pinned baseline is the reference run a strategy's live performance is compared against by the drift monitor (per [portfolio-risk-engine.md §"Strategy drift monitoring"](tdd/portfolio-risk-engine.md)). Promotion is operator-only, via the GUI's Backtests workspace → select a `wfo_results` archive → "Pin as baseline for `<strategy_id>`". The transition is audit-recorded.

### Verify

- [ ] QO sweep runs to completion against the strategy's adapter
- [ ] `wfo_results_*.json` appears under `${DATA_URI}/results/qo/<sweep>/`
- [ ] GUI Backtests workspace lists the new run after the catalog collector's next sweep (≤ 60s)

---

## 9. Paper trading

Paper trading is the pre-live ground-truth validation stage. **Paper vs live is a bundle-credentials distinction**, not a QF code-path branch: the same NT bundle code paths run against the broker's paper / sandbox endpoint instead of the live one. There is no local-simulation `fillPrice()` path anymore — that was retired with the ExecutionMode taxonomy.

### Prerequisites

- [ ] System running (§6)
- [ ] NATS running (§3)
- [ ] At least one strategy promoted from backtest to paper-ready (§8 baseline pinned)
- [ ] Paper credentials configured on the broker's NT bundle:
  - **IBKR**: IB Gateway in paper mode (default port 7497); bundle's `.env` set to use these.
  - **Schwab**: Schwab Developer sandbox app keys (`SCHWAB_APP_KEY` / `SCHWAB_APP_SECRET` / `SCHWAB_REFRESH_TOKEN`); bundle's `.env` set to sandbox.

### Run a strategy in paper

1. Start the paper-credentialed NT bundle for the strategy's broker. The bundle reads its `.env` for the broker credentials, connects to the broker's paper / sandbox endpoint, and registers with the lifecycle registry as it comes online.
2. Transition the strategy into `running` (§7 Managing strategies).
3. The strategy submits orders through its NT plugin → risk gate → paper broker. The audit chain records the full lifecycle exactly as it will in live (same `correlation_id` model, same audit-row writers).

### Verify

1. **GUI Risk Dashboard**:
   - [ ] Portfolio shows the strategy's broker (`ibkr` or `schwab`) and the broker badge / env pill reads "paper" / "sandbox"
   - [ ] Positions appear after the strategy fires its first entry
   - [ ] P&L marks to market on the bundle's MD feed
   - [ ] Risk headroom bars track vs. limit
2. **GUI Orders** (or Investigate workspace):
   - [ ] Each `audit_fills` row carries the broker's actual fill price (no synthetic `fillPrice()` values)
   - [ ] Slippage column populated from broker fill vs. intent reference price
3. **GUI Trade Inspector**:
   - [ ] `correlation_id` reconstructs the full intent → order → fill chain
4. **Reconciliation**:
   - [ ] `portfolio_reconciliation_drift_total{portfolio}` stays at 0 across recon cycles (default 60s per [portfolio-risk-engine.md §3](tdd/portfolio-risk-engine.md#3-position-reconciliation))

### Position exit controls test

Before relying on paper results, verify the exit controls work end-to-end (full design in [order-execution.md §5](tdd/order-execution.md#5-position-exit-controls)):

**Per-position liquidate:**

1. On any strategy detail page, locate an open position row.
2. Click the row's **Liquidate** button.
3. In the confirmation modal, type `LIQUIDATE` and submit.
4. Verify: a closing intent appears in the order timeline with `reason="operator_manual"`; broker fill follows on its normal latency.

**Multi-select liquidate:**

1. Tick checkboxes on N position rows (across one or more strategies).
2. Click **Liquidate selected (N)** in the toolbar.
3. Type `LIQUIDATE` and submit.
4. Verify: N closing intents emit in parallel, each with `reason="operator_manual"`.

**Per-strategy halt:**

1. On a strategy detail page, click **Halt strategy**.
2. Either (a) wait for the strategy's next decision tick that would produce an intent, or (b) submit a manual entry intent attributed to the strategy.
3. Verify: gate rejects with `reason="strategy_halted"`; no order reaches the broker; existing positions are untouched.
4. Click **Resume strategy** to re-enable.

Or via API:

```bash
# Per-position liquidate:
curl -X POST -H "Authorization: Bearer $QF_TOKEN" \
  http://localhost:3001/api/positions/<position_id>/liquidate

# Multi-select liquidate:
curl -X POST -H "Authorization: Bearer $QF_TOKEN" \
  http://localhost:3001/api/positions/liquidate \
  -H 'Content-Type: application/json' \
  -d '{"position_ids": ["pos-...", "pos-..."]}'

# Halt / resume a strategy:
curl -X POST -H "Authorization: Bearer $QF_TOKEN" http://localhost:3001/api/strategies/<strategy_id>/halt
curl -X POST -H "Authorization: Bearer $QF_TOKEN" http://localhost:3001/api/strategies/<strategy_id>/resume
```

### What to watch for

- Strategy producing too many intents? Check the strategy's decision logic and signal cadence. The gate's per-strategy submission rate / quantity limits will surface in `audit_intents.gate_decision = 'reject'` with `gate_reason`.
- Fills materially worse than backtest? Check `audit_fills.slippage` per fill; the drift monitor compares live vs. pinned baseline and surfaces this as a drift signal per [portfolio-risk-engine.md §"Strategy drift monitoring"](tdd/portfolio-risk-engine.md).
- Reconciliation drift on paper is the same money-safety signal as on live — investigate any non-zero drift immediately; the affected strategy auto-halts new submissions per [order-execution.md §5.4](tdd/order-execution.md#54-reconciliation-drift-handling).

---

## 10. Going live

**Do not proceed without completing all previous steps.** Live trading sends real orders with real money.

Going live is a **bundle-credentials switch + lifecycle transitions**, not a mode change. The same NT bundle code paths that ran against the broker's paper / sandbox endpoint now run against the live endpoint. There is no QF-side `mode: live` toggle. The operator's manual controls (typed-confirm `FIRE` on manual entry, typed-confirm `LIQUIDATE` on manual liquidation) are unchanged from paper — they apply to live orders the same way per [order-execution.md §5](tdd/order-execution.md#5-position-exit-controls).

### Pre-live checklist

- [ ] Paper trading (§9): strategy validated, P&L trajectory acceptable, no reconciliation drift
- [ ] Risk limits: reviewed and appropriate for real capital; `config/risk_limits.yaml` reflects the live envelope
- [ ] Per-strategy halt + per-position LIQUIDATE: rehearsed by the operator on paper (§9 "Position exit controls test"); both fire from the GUI and from API with the operator's bearer token
- [ ] Bundle-restart procedure (this section) rehearsed at least once on the paper bundle so the operator knows the steps cold
- [ ] Monitoring: Prometheus + Loki + Grafana stack running; dashboards loaded; alert routing destination configured (Slack / etc.) per [§11 Monitoring](#11-monitoring)
- [ ] Backtest: pinned baseline for each enabled strategy aligns with paper-trading observed metrics
- [ ] Calendar: `config/market-calendar.json` is up to date for the current year (holidays, half-days)
- [ ] Audit-chain backup: `backup-audit-chain` write-job verified running on the scheduler cron (per [cross-cutting.md §7](tdd/cross-cutting.md#audit-chain-backup-and-restore))

### Bundle restart with live credentials

The mechanism: stop the paper-credentialed bundle, start the live-credentialed bundle, enable strategies through the lifecycle registry. There is no in-place credential swap on a running bundle — restart is the only supported transition because the broker connection holds onto its session credentials and renegotiating mid-process is a worse failure mode than a clean restart.

1. **Halt every strategy on the affected broker.** In the GUI Strategies workspace, click **Halt** on each strategy bound to this broker, or via API:

   ```bash
   curl -X POST -H "Authorization: Bearer $QF_TOKEN" \
     http://localhost:3001/api/strategies/<strategy_id>/halt
   ```

   New submissions are blocked; existing positions stay open. This guards against orders flying during the brief restart window.

2. **Liquidate any open paper positions you don't want to carry into live.** Multi-select positions in the GUI Operate workspace and type `LIQUIDATE`. Paper positions don't exist on the live broker, so leaving them in QF state will produce immediate reconciliation drift on the live bundle start.

3. **Stop the paper bundle.** On the credential host (typically `your-server`):

   ```bash
   systemctl --user stop quantfoundry-nt-bundle@<broker>
   ```

   Or `docker compose stop quantfoundry-nt-bundle-<broker>` if running under compose.

4. **Switch the bundle's `.env` to live credentials.** Edit the bundle's `.env` file (separate from QF's `.env`):
   - **IBKR**: point at the live IB Gateway port (4002 typical) instead of paper (7497). Also set `BROKER_ENV=live` so the bundle's FIRE-gate check sees the live env per [gui.md §3](tdd/gui.md#3-control-primitives).
   - **Schwab**: replace the sandbox app key / secret / refresh token with the production-app trio. `BROKER_ENV=live`.

   Source these from your own secrets manager; never commit live credentials.

5. **Start the live bundle.**

   ```bash
   systemctl --user start quantfoundry-nt-bundle@<broker>
   ```

   Watch the bundle's logs (`journalctl --user -u quantfoundry-nt-bundle@<broker> -f`) for clean broker connection — broker authentication, account snapshot on startup, no recurring reconnect errors.

6. **Verify the gate is warm.** The gate plugin fails closed during rehydration on bundle start (it rebuilds its in-flight-intent state from `audit_intents` before accepting any RPCs per [risk-gate-architecture.md §5.2](tdd/risk-gate-architecture.md#52-restart-rehydration)). The GUI shows a "gate warming up" banner during this window. See [§13 Troubleshooting → Gate warming up](#13-troubleshooting) for the operator playbook if it doesn't clear quickly.

7. **Reconcile against the broker.** The position-reconciliation loop runs on its next cycle and should match the live broker's actual positions exactly (which should be the live account's current holdings, not the paper account's). Any drift here means the bundle picked up the wrong credentials or the live account has positions QF doesn't know about — stop and investigate before unhalting strategies.

8. **Resume strategies one at a time.** In the GUI, click **Resume** on the first strategy you want to take live. Watch its first ~5 minutes of activity:
   - [ ] Strategy submits its first intent through the gate; `audit_intents.gate_decision = 'approve'`
   - [ ] Broker accepts; `audit_orders.status` transitions to `submitted` then `filled`
   - [ ] No log warnings for "handler over budget" beyond warm-up
   - [ ] Reconciliation drift stays at 0

   If the first strategy looks clean, resume the next one. The operator can ladder up strategies as confidence builds — there's no requirement to enable all of them at once.

### Verify

- [ ] GUI Risk Dashboard shows the live broker name in the portfolio's broker badge; env pill reads "live"
- [ ] `GET /api/portfolio/<id>` returns the live broker's current positions
- [ ] Real orders fill at real broker prices; `audit_fills.fees` populated with broker fee data
- [ ] `portfolio_reconciliation_drift_total` stays at 0 across recon cycles
- [ ] On-call alerting routing is firing — verify with a test alert from the Alerts workspace

---

## 11. Monitoring

### Observability stack (M15 — Prometheus + Loki + Grafana + Alloy)

Magpie ships a self-hosted observability stack as an opt-in
docker-compose profile. Phase 1 (local-disk, 365-day retention,
single-host) lands in M15-1 (stack stand-up); the application-side
`prom-client` instrumentation behind `/metrics` lands in M15-2; the
starter dashboard set lands in M15-3.

**Bring the stack up:**

```bash
npm run observability:up
# under the hood: docker-compose --profile observability up -d
```

Services and ports:

| Service    | Port  | UI / endpoint                             |
| ---------- | ----- | ----------------------------------------- |
| Prometheus | 9090  | http://localhost:9090                     |
| Loki       | 3100  | http://localhost:3100/ready               |
| Grafana    | 3000  | http://localhost:3000 (admin / admin)     |
| Alloy      | 12345 | http://localhost:12345 (config + metrics) |

> **Default Grafana credentials are `admin` / `admin`.** Change them
> immediately on first login if the host is exposed beyond `localhost`.

**Bring it down:**

```bash
npm run observability:down
```

**Tail the stack logs (debugging the stack itself):**

```bash
npm run observability:logs
```

### Log shipping (Loki)

Alloy tails QF log files from `./data/logs/` and ships them to Loki.
For logs to flow, the host-side QF processes must write to those files
via the `LOG_FILE` environment variable (the JSON-schema log emitter
in `server/logger.ts` supports `LOG_FILE` for newline-delimited JSON
output in addition to stdout):

```bash
# In a dev shell (or your .env / process supervisor)
mkdir -p data/logs
export LOG_FILE_SERVER=./data/logs/server.log
export LOG_FILE_SUPERVISOR=./data/logs/supervisor.log

# Then start QF as usual:
LOG_FILE=$LOG_FILE_SERVER     npm run server
LOG_FILE=$LOG_FILE_SUPERVISOR npm run supervisor
```

Loki labels extracted by Alloy: `service`, `level`. The
`correlation_id` and `event` fields ride along as **structured
metadata** — queryable in Grafana via `| json` parsers without
inflating Loki's label index.

**Query in Grafana → Explore → Loki:**

```logql
# All warn-and-above events from the trading core
{level=~"warning|critical"}

# Reconstruct a single lifecycle by correlation_id
{service=~"qf-.+"} | json | correlation_id="01JABCD..."

# Find slow strategy evaluations
{service="strategy-runner"} | json | duration_ms > 100
```

### Metrics (Prometheus)

Prometheus scrapes:

- `host.docker.internal:3001/metrics` — main QF server (M15-2)
- `host.docker.internal:3002/metrics` — supervisor (M15-2)
- `loki:3100/metrics` — Loki self-metrics
- `alloy:12345/metrics` — Alloy self-metrics

> **Status:** `prom-client` is already a dependency (`package.json`)
> but no QF code imports it yet — instrumentation lands in M15-2 /
> QF-276. Until then, the `qf-server` and `qf-supervisor` scrape
> targets will surface in Prometheus as `DOWN` (404 on `/metrics`).
> This is expected.

Metric names per component are enumerated in their TDDs and will be
indexed in `docs/tdd/observability.md §6` once M15-2 ships.

### Dashboards (Grafana)

Dashboards are provisioned from
`deploy/observability/grafana/provisioning/dashboards/`. The starter
set (5 dashboards — trading pipeline health, broker & reconciliation,
portfolio, signal orchestrator freshness, logs explorer with a
`correlation_id` template variable) ships in M15-3 / QF-277. Until
then, the Grafana UI is empty but functional; **Explore → Loki** and
**Explore → Prometheus** work the moment the stack is up.

### Retention and backup

#### Observability stack

Retention (per the 2026-05-20 decision):

- **Loki:** 365 days warm (filesystem). Configured in
  `deploy/observability/loki-config.yaml:limits_config.retention_period`.
- **Prometheus:** 365 days warm (filesystem). Configured via the
  `--storage.tsdb.retention.time=8760h` CLI flag in
  `docker-compose.yml`.
- **Older than 365 days:** offsite cold storage via the M15-5 /
  QF-279 MinIO backup job (write-jobs handler
  `backup-observability`). Until that ships, older logs / metrics
  are purged.

#### Audit chain (`data/portfolio.duckdb`)

This file is the indefinitely-retained system of record for the audit
chain (`audit_intents` / `audit_orders` / `audit_fills` /
`portfolio_snapshots`). Backup runs nightly via the `backup-audit-chain`
write-jobs handler ([write-jobs.md §8](tdd/write-jobs.md#8-registered-handlers)).

| Concern     | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Cadence     | Nightly (`0 2 * * *`) via the `quantfoundry-scheduler` container's cron.                             |
| Destination | MinIO `quantfoundry-backups/audit/`.                                                                 |
| Naming      | `portfolio_<YYYYMMDD>_<HHMMSS>.duckdb`.                                                              |
| Retention   | 30 daily + 12 monthly (bucket lifecycle policy).                                                     |
| On-demand   | `POST /api/write-jobs {kind: "backup-audit-chain"}` from the operator GUI (Settings → Data → Audit). |

Restore procedure: see [cross-cutting.md §7 Audit-chain backup and
restore](tdd/cross-cutting.md#audit-chain-backup-and-restore). Summary:

1. Stop the TS server.
2. `aws s3 cp s3://quantfoundry-backups/audit/portfolio_<chosen>.duckdb data/portfolio.duckdb`.
3. Verify integrity with `duckdb data/portfolio.duckdb "SELECT COUNT(*) FROM audit_fills;"`.
4. Restart the server; let position-reconciliation surface broker drift on its next cycle.
5. Operator inspects drift entries and either adds missing fills or accepts the broker's view.

### Alerting (deferred per 2026-05-20)

Per the 2026-05-20 scoping decision, no alert routing destination has
been picked (Slack is a dangling requirement). Grafana Alerting and
Prometheus alert rules **ship inert** today — rules can be authored
but no contact point fires. When the destination is decided, alerts
will route through the same channel structure documented in
[`docs/tdd/alerts.md`](tdd/alerts.md). Internal in-app alerts
(`stateWs.pushAlert` banners — QF-218 quote-unavailable etc.) keep
working independent of this.

### Key metrics to watch

| Metric                                 | Healthy value        | Action if unhealthy                                                      |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `signals_rollup_lag_seconds`           | < 60                 | If > 3600, signals may be lost before Parquet write. Investigate rollup. |
| `signals_rejected_total`               | Low / stable         | Spike = broken worker or misconfigured model. Check `reason` label.      |
| `portfolio_drawdown`                   | Below limit          | Approaching limit = system may auto-halt. Review positions.              |
| `portfolio_reconciliation_drift_total` | 0                    | Any non-zero = investigate immediately.                                  |
| `marketdata_source_available`          | 1 for primary source | 0 = broker down. Check connection.                                       |
| `order_submission_failed_total`        | 0                    | Non-zero = broker connectivity issues.                                   |
| `signals_consumer_poison_total`        | 0                    | Non-zero = strategy crashing on a signal. Check logs.                    |

### Structured JSON logs

All server logs are JSON to stdout. Key fields: `ts`, `level`, `component`, `msg`. Filter with `jq`:

```bash
# All errors
npm run server 2>&1 | jq 'select(.level == "error")'

# Signal ingress activity
npm run server 2>&1 | jq 'select(.component | startswith("ingress"))'

# Portfolio events
npm run server 2>&1 | jq 'select(.component | startswith("portfolio"))'
```

### Alerts (Alertmanager)

See [tdd/alerts.md](tdd/alerts.md) for the live alert routing (channels, rules, recent-alerts ring).

---

## 12. Maintenance

### Daily

- [ ] Check GUI Risk Dashboard for anomalies (drawdown, P&L)
- [ ] Review recent fills in the Orders tab
- [ ] Verify model quality metrics haven't degraded (Signals tab)

### Weekly

- [ ] Verify Schwab refresh token hasn't expired (if Schwab is enabled). The adapter logs a warning if < 24h until expiry.
- [ ] Check disk usage: `du -sh data/chains/ data/results/ data/portfolio.duckdb`
- [ ] Review server logs for repeated warnings

### Monthly

- [ ] Run signal health check: `npx tsx scripts/signal-health.ts`
- [ ] Review and adjust risk limits based on trading results
- [ ] Review model quality evaluator results — retire underperforming models

### Yearly

- [ ] Update `config/market-calendar.json` with next year's holiday schedule (both US_EQUITY and CME)
- [ ] Review data retention — the retention job runs automatically per `config/signals.json` → `retention.signals_max_age_days` (default 365)

---

## 12.5. Rollback procedures (polyglot migration)

Consolidated from the per-phase rollback paragraphs in [polyglot-migration-tdd.md §10](polyglot-migration-tdd.md). Each phase shipped with a rollback path; this section is the operator-side index. Phases 0–5 are completed; some rollbacks are now historical, but the still-actionable ones are flagged.

| Phase                                                                       | Status                                      | Rollback path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | When to invoke                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 0 — mirrors + CI scaffolding**                                      | Historical                                  | Remove mirrors from CI config; revert TDD changes. No production surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Only if a mirror operational issue blocks the project. Otherwise no-op.                                                                                                                                                                                                                     |
| **Phase 1 — `quantfoundry-quant` Rust crate**                               | Historical                                  | Remove the crate publication from the mirror; existing JS callers still work (TS port + JS lived side-by-side during the cutover).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Only if the equivalence harness reveals unreconcilable divergence. In practice the harness was the gate.                                                                                                                                                                                    |
| **Phase 1.5 — corrected CDF cutover**                                       | Historical (still highest-stakes if redone) | Revert the internal-caller switch in `quantfoundry-quant` (one-line PR per caller); close the equivalence-framework expected-divergence entry as "transition aborted"; restore pre-cutover calibration baselines from the model registry; mark affected strategies as `paused` in the lifecycle registry. The deprecated `cdf` was kept available specifically to make this rollback single-step; QF-140 (2026-05-19) removed it as part of Phase 6 decommissioning, so a future Phase 1.5 redo would not have the same single-step revert.                                                                                                                | Roll back if more than two promoted strategies fail their post-cutover paper cycle for reasons attributable to the math change. Half-corrected math is worse than fully-buggy math.                                                                                                         |
| **Phase 2 — signal SDK + worker auth + orchestrator skeleton**              | Historical                                  | Disable the server's bearer-auth requirement (config flag, set `QF_SIGNAL_AUTH_REQUIRED=0`); revert `vol-forecast-spy-1d` to its pre-SDK code; leave the orchestrator skeleton in place (no production callers).                                                                                                                                                                                                                                                                                                                                                                                                                                           | Only if the bearer-auth path causes measurable signal-loss vs the unauthenticated baseline.                                                                                                                                                                                                 |
| **Phase 3 — NautilusTrader for backtests**                                  | Historical — superseded by Phase 6          | The original rollback (redirect `server/backtest/runner.ts` to call `engine.js`; mark migrated Python strategies as `paused`) **no longer applies** — `engine.js` + the runner + the JS strategies are deleted (QF-137). The current backtest path lives in the sibling quant-optimizer repo entirely; QF does not own a backtest runner anymore. If QO produces unreliable results, "rolling back" means pinning QO to an earlier commit in `research/quant-optimizer/` — there is no QF-side fallback. Half-corrected backtest math is best handled by halting promotion (mark candidate strategies `paused`) rather than rebuilding the retired runner. | Roll back if QO produces results that materially differ from manual NT BacktestEngine runs and the operator can't reproduce the divergence. Otherwise pin-QO-to-prior-commit is the only path.                                                                                              |
| **Phase 4 — broker delegation for live (Schwab NT, IBKR-NT pending QF-19)** | **Active**                                  | Switch the relevant `BrokerAdapter` from the NT-adapter implementation back to the legacy `@stoqey/ib` adapter at `server/order/adapters/ibkr.ts`. The Rust sidecar can be left running idle. Audit chain remains coherent because both paths write fills to the same DuckDB table.                                                                                                                                                                                                                                                                                                                                                                        | Roll back if any production fill diverges materially from what the legacy path would have produced, _or_ if the operator can't reproduce the divergence after investigation.                                                                                                                |
| **Phase 5 — LP optimizer (Rust+WASM)**                                      | **Active**                                  | Ship the previous build's `javascript-lp-solver`-based Web Worker; leave the Rust crate in the mirror unused. The PyO3 binding has no automated-strategy callers yet so its rollback is no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Roll back if the WASM module produces solutions that differ from the JS solver in ways that affect Greek Builder UX. **Note:** QF-139 (2026-05-19) dropped `javascript-lp-solver` from `dependency-pins.md`; restoring it would require re-admitting via the dependency-admission workflow. |
| **Phase 6 — hardening + decommissioning**                                   | **In flight**                               | Cherry-pick a deletion's revert from git history. To "un-decommission" any dropped dep: re-admit to the mirror via the admission workflow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Don't enter Phase 6 cleanup tickets unless the criteria for that specific item are met. Individual deletions can be reverted one at a time; treat the whole phase as the irreversible step.                                                                                                 |

For the original rationale + decision criteria per phase, see [polyglot-migration-tdd.md §10](polyglot-migration-tdd.md#10-sequencing-and-phases).

---

## 12.6. Strategy rollback and hot-swap

Added 2026-05-22 alongside the prod-bundle topology in [tdd/strategy-deployment-topology.md](tdd/strategy-deployment-topology.md). The prod TradingNode hosts every strategy bound to a broker as a co-tenant; rolling back one strategy must not require restarting the others.

### Hot-swap (preferred)

Hot-swap drains and replaces a single strategy without restarting the TradingNode. Other co-tenants keep running.

**Preconditions.**

- The new strategy version's code is importable in the running bundle. In practice this means **the new version is part of the prod bundle image already** — hot-swap covers config / param / pinning changes, not code that the running process has never seen. Code-level changes require a bundle deploy (next subsection).
- The strategy is in `running` state in QF's lifecycle registry.
- No open positions you're unwilling to hold across the swap window (working orders are cancelled cleanly; existing positions persist).

**Procedure.**

1. In QF GUI → Strategies, click "Pause" on the target strategy. Or: `curl -X POST http://localhost:3001/api/strategies/<strategy_id>/pause`.
2. Verify (in GUI Investigate workspace, or `/api/orders?strategy_id=...`) that all working orders for that strategy have been cancelled. Existing filled positions remain.
3. Click "Halt" to fully stop. The bundle launcher receives the lifecycle event over NATS and calls `node.stop_strategy(strategy_id)` on the live TradingNode.
4. Update `config/strategies/<strategy_id>.yaml` (or equivalent) with the new params / version pin.
5. Click "Enable" → "Run". The bundle launcher calls `node.add_strategy(new_instance)`. The strategy resumes against its persisted state (see [strategy-deployment-topology.md §6](tdd/strategy-deployment-topology.md#6-strategy-state-contract)).
6. Monitor the strategy's first ~5 minutes of activity in GUI Operate; confirm no exceptions in logs, latency back to baseline.

**If hot-swap fails partway** (e.g. `add_strategy` rejects the new config), the strategy stays in `halted` state. Other co-tenants are unaffected. Investigate, fix, retry. The full-bundle restart below is the escape hatch.

### Full bundle restart (fallback)

Use when hot-swap isn't viable: new strategy code, new transitive deps, or a deeper config change that touches shared TradingNode wiring.

**Procedure.**

1. Pre-stage: build the new bundle image in CI. Confirm `cd research/quantfoundry-prod-bundle && uv sync && uv run pytest` is green.
2. In QF GUI, **halt every co-tenant strategy** on the affected broker (per-strategy Halt buttons, see [order-execution.md §5.3](tdd/order-execution.md#53-per-strategy-operator-halt-block-new-submissions)) so no new submissions fly during the restart. Then **manually liquidate any open positions** that you don't trust to survive a cold restart — multi-select on the position view + typed `LIQUIDATE` ([order-execution.md §5.2](tdd/order-execution.md#52-operator-manual-liquidation)). The framework no longer auto-closes — operator decides per position whether to flatten before restart or trust the strategy's §6 state-recovery flow.
3. Stop the prod bundle process: `systemctl stop quantfoundry-nt-bundle@<broker>` (or your equivalent unit name).
4. Deploy the new image.
5. Start the unit: `systemctl start quantfoundry-nt-bundle@<broker>`.
6. Launcher reads the lifecycle registry for enabled strategies, rebuilds the TradingNode with all of them, reconnects to the broker.
7. Each strategy goes through its §6 state-recovery flow: rebuild positions from broker API, restore decision state from `data/strategy_state/`, warm up indicators from market data history.
8. Verify in GUI: reconciliation passes for every portfolio, no `audit_orders` rows in unexpected states, no log warnings for "handler over budget" beyond the warm-up window.

Total downtime is typically minutes (broker reconnect + warm-up). The halt + selective liquidation in step (2) makes step (7) safe: a strategy that restarts with no positions trivially rebuilds correctly, whereas one that restarts with positions depends on its state-recovery flow being right. Operator picks per-strategy which is the lower-risk path; this is the explicit trade-off the design accepts vs. the prior auto-close-everything kill switch.

### Per-strategy version pinning

The prod bundle's `uv.lock` pins each strategy package by version. To roll back one strategy:

```
# in research/quantfoundry-prod-bundle/
uv add --upgrade-package cl-scalp==0.3.2  # pin the older version
uv lock                                    # regenerate lockfile
# review the diff, ensure no other deps moved
git commit -am "rollback: cl-scalp 0.4.0 → 0.3.2 (RUNBOOK §12.6)"
```

Then run the full bundle restart procedure above. The rollback PR + CI run is the audit trail; commit message references this section.

### Don't do this

- **Don't** restart only one strategy by killing it OS-side. The bundle launcher will not notice — it'll think the strategy is still running, the lifecycle registry will be out of sync, and your `audit_intents` chain will have a gap. Always go through the GUI / API.
- **Don't** edit `data/strategy_state/<strategy_id>.json` by hand to "fix" a stuck strategy. Halt the strategy first, let the next start go through the state-recovery flow against broker positions. The state file is a cache; the broker is the source of truth.
- **Don't** roll back a strategy and a bundle dependency in the same change. Sequential rollbacks are diagnosable; combined ones aren't.

---

## 13. Troubleshooting

### Strategy not firing

1. Is the strategy erroring? Check server logs: `jq 'select(.component == "server.strategy")'`.
2. Is the portfolio halted? Check Risk Dashboard — a halted portfolio won't generate intents.

### Reconciliation drift

1. **Don't panic.** Drift detection halts new submissions for the affected strategy/portfolio (per [order-execution.md §5.4](tdd/order-execution.md#54-reconciliation-drift-handling)) but does **not** auto-close existing positions. Nothing is being silently flattened — you have time to inspect.
2. Compare internal positions (Risk Dashboard → Positions table) with broker positions (broker's own UI).
3. Common causes:
   - Fill arrived while the process was down (the broker recorded it; the audit chain didn't). Fix: insert the missing fill directly into `audit_fills` via the DuckDB CLI (matching schema in [cross-cutting.md §5](tdd/cross-cutting.md#5-database-schema-consolidated)) and restart so the positions projector replays. Be sure to thread the right `correlation_id` so the chain reconstructs.
   - Manual trade in the broker account outside the system. Fix: either close the manual position via the broker UI, or record it as an operator manual entry in QF so the audit chain reflects it.
4. After resolving, **Resume** the affected strategy in the GUI (per-strategy resume; see [order-execution.md §5.3](tdd/order-execution.md#53-per-strategy-operator-halt-block-new-submissions)) or `POST /api/strategies/<strategy_id>/resume`.

### A strategy got halted unexpectedly

1. Check the strategy's lifecycle detail page in the GUI — the halt reason is recorded on the lifecycle transition.
2. Common causes:
   - `max_drawdown` portfolio limit tripped — market moved against positions; review the day's mark-to-market on the affected portfolio.
   - `reconciliation_drift` for the strategy — see above.
   - `hard_drift` (drift monitor) — strategy's live behavior detached from its pinned QO baseline; review the drift signals on the strategy page.
   - `exit_rule_max_drawdown` fired — the strategy hit its declared per-strategy drawdown rule and its positions are being closed. The strategy isn't halted by this event itself; the closing intents flow through normally.
3. After resolving the root cause, click **Resume strategy** in the GUI or `POST /api/strategies/<strategy_id>/resume`. Existing positions are untouched throughout — operator decides separately whether to liquidate via [order-execution.md §5.2](tdd/order-execution.md#52-operator-manual-liquidation).

### Server won't start

1. **DuckDB error**: Check `data/portfolio.duckdb` is accessible. The server creates it if missing.
2. **Config parse error**: Run the JSON validation commands from step 4.
3. **Port in use**: Check if another process is using port 3001: `lsof -i :3001`.
4. **TypeScript error**: The server runs via `tsx`. Verify with `npx tsc --noEmit`.

### NATS unreachable

1. Is the container running? `docker compose ps`
2. Can the server reach it? `curl http://localhost:8222/healthz`
3. Restart NATS: `docker compose restart nats`. Streams persist in the Docker volume.

### IB Gateway disconnected

1. Is the container running? `docker ps | grep ibgateway`
2. Check the VNC console (port 5900) — IB Gateway may need manual login after restart.
3. The Market Data adapter's `available()` check will return false and fallback to the next source.
4. The Order adapter will reject submissions with "IBKR not connected" — orders stay in `submission_failed` state.

### DuckDB issues

```bash
# Open the database directly for debugging
npx duckdb data/portfolio.duckdb

# Check table existence
.tables

# Check row counts
SELECT 'audit_intents' as tbl, count(*) as n FROM audit_intents
UNION ALL SELECT 'audit_orders', count(*) FROM audit_orders
UNION ALL SELECT 'audit_fills', count(*) FROM audit_fills
UNION ALL SELECT 'portfolio_snapshots', count(*) FROM portfolio_snapshots
UNION ALL SELECT 'write_jobs', count(*) FROM write_jobs;

# Reconstruct a single lifecycle from a correlation_id
# (per observability.md §4.2 — the framework acceptance test)
SELECT
  i.intent_id, i.source, i.action, i.symbol, i.quantity, i.status, i.created_at
FROM audit_intents i
WHERE i.correlation_id = '<correlation_id>'
ORDER BY i.created_at;
```

### WebSocket not connecting

1. The GUI connects to `ws://<server>:3001/ws/state` via the one-shot ticket exchange per [cross-cutting.md §1.3](tdd/cross-cutting.md#13-websocket-auth--one-shot-ticket-exchange) — first the GUI POSTs to `/api/ws/ticket` (Authorization Bearer), then opens the WS with the returned `?ticket=…`.
2. Check browser devtools → Network → look for the `/api/ws/ticket` POST. If it 401s, the operator's bearer token expired or was revoked — re-paste from `sessionStorage` or re-issue per [token issuance](#token-issuance-and-rotation) below. If it 200s but the subsequent WS upgrade closes with code `4400`, the ticket was already consumed (browser ran the open twice, or a stale tab grabbed it first) — the GUI will retry on its own.
3. Close codes `4401` / `4403` mean the underlying bearer is invalid or missing a scope — re-paste / re-issue.
4. If the server started but no WebSocket traffic at all, check that no firewall blocks WebSocket upgrade on port 3001.
5. The GUI shows "Reconnecting..." with exponential backoff (1s → 30s cap) and will recover automatically once the server is reachable.

### Gate warming up

On bundle restart, the QF risk-gate plugin **fails closed** (rejects all orders, including closes) until it has rehydrated its in-flight intent state from `audit_intents` per [risk-gate-architecture.md §5.2](tdd/risk-gate-architecture.md#52-restart-rehydration). The GUI shows a "gate warming up" banner during this window. Expected duration: a few seconds for the per-broker rehydration query plus NATS connect.

1. **What the operator sees:** Banner reads "Gate warming up — `<broker>` strategies blocked from submitting until rehydration completes." Strategies bound to the broker show `gate_unavailable_open_blocked` on any submission attempt.
2. **Normal duration:** under 5 seconds on a healthy machine with NATS local. Anything beyond 30 seconds is a problem.
3. **If the banner persists:**
   - [ ] Check the bundle logs (`journalctl --user -u quantfoundry-nt-bundle@<broker> -f`) for the rehydration step — there should be a `gate.rehydrate.complete` event.
   - [ ] Check `audit_intents` is queryable (DuckDB issues above) — corruption would block rehydration entirely.
   - [ ] Check NATS connectivity — the gate cannot signal "ready" without it.
   - [ ] If rehydration is genuinely stuck, halt the affected strategies before unsticking; the gate's fail-closed posture is preferable to letting submissions through against unrehydrated cross-strategy state.
4. **Closes-only fail-open** is the alternate posture: on `fail_open_mode=closes-only` (configured per [risk-gate-architecture.md §4](tdd/risk-gate-architecture.md)), the gate allows closing orders during the rehydration window. Inspect the bundle's NT config to confirm which mode is set for this deploy.

### Halted portfolio (vs halted strategy)

A halted **portfolio** blocks new submissions across all of its strategies — the auto-halt fires on portfolio-level risk-limit breaches (daily loss, drawdown, equity floor) per [portfolio-risk-engine.md §1](tdd/portfolio-risk-engine.md#1-portfolio-state). This is distinct from a per-strategy halt (§7 / [order-execution.md §5.3](tdd/order-execution.md#53-per-strategy-operator-halt-block-new-submissions)) which only halts one strategy. The GUI surfaces both:

- **Per-strategy halt:** banner on the strategy's row in the Strategies workspace; `gate_decision='reject'` with `gate_reason='strategy_halted'` for any submission attempt.
- **Portfolio-level halt:** a top-of-Operate-workspace banner (`Portfolio <id> halted: <halt_reason>`); all strategies on the portfolio see `gate_reason='portfolio_halted'` on submission. The portfolio's `halted: true` flag is also visible via `GET /api/portfolio/<id>` (`halted`, `halt_reason` fields).

To recover a halted portfolio:

1. **Identify the breach.** Check `GET /api/portfolio/<id>` → `halt_reason`. Common values: `"Daily loss N exceeds limit M"`, `"Drawdown N exceeds limit M"`.
2. **Decide whether to liquidate.** The halt blocks **new submissions** but does **not** auto-close existing positions per [order-execution.md §5](tdd/order-execution.md#5-position-exit-controls). Inspect open positions — if the breach is from adverse market movement and you don't want to absorb further losses, liquidate selectively via the multi-select LIQUIDATE flow.
3. **Reset the halt.** Once the portfolio is in an acceptable state (positions trimmed, market settled, or you've decided to override), reset via:

   ```bash
   curl -X POST -H "Authorization: Bearer $QF_TOKEN" \
     http://localhost:3001/api/portfolio/<id>/reset-halt
   ```

   Or in the GUI: Risk Dashboard → Portfolio header → **Reset halt** button (requires `write:risk-limits` scope; LIQUIDATE-style typed-confirm friction not applied here because the action is a re-enable, not a destructive one).

4. **Update risk limits if appropriate.** If the breach was from a limit that's now too tight relative to live behavior, edit `config/risk_limits.yaml` (file-watched, ~500ms reload) or `PUT /api/risk/limits/<portfolio>`. If the breach was from a strategy that's misbehaving, halt the strategy specifically (§7) before resetting the portfolio.

### Token issuance and rotation

Operator bearer tokens are issued by `npm run issue-token` on the server where the unified token store (`data/secrets/tokens.json`) lives. For operators accessing the GUI from a separate machine (laptop, etc.), this is a two-step flow:

1. **SSH to the server** (typically `your-server`):

   ```bash
   ssh your-server
   cd ~/GitHub/Magpie
   ```

2. **Issue a token** with the scopes you need. Operator standard bundle per [cross-cutting.md §1.5](tdd/cross-cutting.md#15-issuance-and-rotation):

   ```bash
   npm run issue-token -- \
     --actor "operator:$(whoami)" \
     --scopes "read:portfolio,read:audit,read:risk-limits,read:strategy,read:catalog,read:freshness,read:alerts,submit:order,cancel:order,liquidate:position,transition:strategy,notes:strategy,write:risk-limits,write:alerts,submit:write-job"
   ```

   The command prints the plaintext token **once**. Capture it immediately into your secrets manager, named per actor.

3. **Paste the token** into the GUI's token-input form on first load. It persists in `sessionStorage` under `qf-token` until tab close.

To rotate: re-issue (the new token's `token_id` is different) and revoke the old one via `POST /api/auth/revoke {token_id}` or `npm run revoke-token -- --token-id <id>`. Revoked entries are kept in `tokens.json` for audit-trail integrity.

## Pre-commit framework

The repo enforces formatting, linting, type checking, and basic hygiene on every commit via the [pre-commit](https://pre-commit.com/) framework. Configuration: [`.pre-commit-config.yaml`](../.pre-commit-config.yaml).

### One-time setup per developer machine

```bash
# Install pre-commit (one of these — pick whichever matches your tooling):
pip install pre-commit
# or:
uv tool install pre-commit
# or via your package manager:
brew install pre-commit

# Wire it into this repo's git hooks:
cd /path/to/Magpie
pre-commit install
```

After that every `git commit` runs the staged-file checks automatically.

### What runs

- **Hygiene** (yelp/pre-commit-hooks v5): trailing whitespace, EOF newline, YAML/JSON syntax, merge-conflict markers, private-key detection, files > 1 MB
- **ESLint** via [`eslint.config.js`](../eslint.config.js) — currently TS-only (`.js`/`.jsx` ignored during the JSX → TS migration)
- **Prettier** for JS/TS/JSON/YAML/Markdown — auto-fixes formatting on commit; if it changes anything, re-stage and re-commit
- **`tsc --noEmit`** — full project type check, runs once per commit when any `.ts`/`.tsx` is staged

### Common operations

```bash
# Run all hooks against every file (full-repo audit; slow on first run):
pre-commit run --all-files

# Run a specific hook only:
pre-commit run prettier --all-files
pre-commit run tsc-noemit --all-files

# Pin a hook to a newer release:
pre-commit autoupdate

# Bypass hooks for a single commit (please don't, but it's there):
git commit --no-verify -m "..."
```

### Troubleshooting

- **"Type tag 'foo' is not recognized"** — the `identify` library version in pre-commit's vendored env is too old. `pre-commit autoupdate` usually fixes it.
- **"Files were modified by this hook"** — Prettier or the EOF fixer rewrote a staged file. Just `git add` the modified file again and re-run the commit.
- **Pre-commit hangs on first install** — it's downloading and building isolated environments for each hook (ESLint + Prettier each pin their own Node deps). Subsequent runs reuse the cache.
- **`tsc --noEmit` fails on unrelated files** — the hook type-checks the whole project, so any pre-existing breakage shows up. See [docs/MIGRATION-JSX-TS.md](MIGRATION-JSX-TS.md) for the migration that's drying up the legacy surface.
