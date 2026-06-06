# Data Directory Cron Jobs

This file lists every scheduled job that writes into `Magpie/data/` (or the MinIO bucket that replaces it). Update it whenever you add, remove, or retime a cron entry.

Each entry should specify: **what writes to what, on what schedule, and which project owns the job.**

---

## Subdirectories and their owners

| Path                       | Content                                                                    | Written by                                                   |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `data/chains/`             | SPY and other options chains, one parquet per `{symbol}-{YYYY-MM}.parquet` | vol-buyer (for SPY); other strategies may add their own tickers |
| `data/macro/fred/`         | FRED macro series (VIX, treasury yields, HY OAS, USD index, etc.)          | `ingest-fred` M10 cron job                                   |
| `data/macro/eia/`          | EIA petroleum data                                                         | `ingest-eia` M10 cron job                                    |
| `data/macro/cftc/`         | CFTC COT positions                                                         | `ingest-cftc` M10 cron job                                   |
| `data/fills/`              | Execution fills                                                            | Magpie execution module                                |
| `data/results/`            | Backtest / P&L results                                                     | various                                                      |

`DATA_URI` controls where the above is written. Two modes:

| `DATA_URI`                          | Used by                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `file:///abs/path/to/Magpie/data` | Local dev on a single machine                        |
| `s3://quantfoundry-data`            | Default for the home server (writes go to MinIO)         |

S3 mode also requires `S3_ENDPOINT_URL`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. See [`.env.example`](../.env.example) for the canonical list.

---

## Where the scheduler runs

**Home server (`your-server.example.com`, LAN `192.168.x.x`) — `quantfoundry-scheduler` docker-compose service.**

Lives in `your-ops-repo/docker-compose.yml` as a sibling to `tanker-scheduler`. Builds from this repo's [`Dockerfile.ingest`](../Dockerfile.ingest) and runs [`scripts/scheduler.ts`](../scripts/scheduler.ts) — a long-running `croner`-based daemon.

Why a container, not host systemd: see the parent ticket QF-156. tl;dr — uniform pattern with the rest of the your-ops-repo stack, log capture via `docker compose logs`, lifecycle via `docker compose up/down`, scales out to additional schedules without adding host-level unit files.

### Container jobs and schedules

| Job | When (America/New_York) | What | Writes to |
| --- | --- | --- | --- |
| `collect-bulk`  | Daily 20:00      | MarketData options-chain bulk pull (`npm run collect:bulk`) | `data/chains/{symbol}-YYYY-MM.parquet` |
| `ingest-fred`   | Weekdays 19:00   | FRED macro series via `npm run ingest -- --source fred`   | `data/macro/fred/*.parquet`   |
| `ingest-eia`    | Wednesdays 22:30 | EIA petroleum data via `npm run ingest -- --source eia`   | `data/macro/eia/*.parquet`    |
| `ingest-cftc`   | Fridays 20:00    | CFTC COT positions via `npm run ingest -- --source cftc`  | `data/macro/cftc/*.parquet`   |

To change a schedule or add a job, edit the `JOBS` array in [`scripts/scheduler.ts`](../scripts/scheduler.ts), open a PR, and after it merges run `docker compose build quantfoundry-scheduler && docker compose up -d quantfoundry-scheduler` on the server.

### Operating the container

```bash
# View live logs (next-run times + per-job start/finish)
docker compose logs -f quantfoundry-scheduler

# Force-run one job ad-hoc (uses the container's env, writes to the same data store)
docker compose exec quantfoundry-scheduler npm run ingest -- --source fred

# Stop / restart
docker compose stop quantfoundry-scheduler
docker compose up -d quantfoundry-scheduler

# Rebuild after a Magpie change
cd ~/GitHub/Magpie && git pull
cd ~/GitHub/your-ops-repo && docker compose build quantfoundry-scheduler && docker compose up -d quantfoundry-scheduler
```

### Secrets / env

Mounted from `~/Magpie/.env` on the server (copy `.env.example` to `.env` and fill in your credentials). The compose service overrides `DATA_DIR=/data` and `TZ=America/New_York` regardless of the file's contents; everything else (MarketData token, FRED key, EIA key, S3 creds) comes through directly.

---

## Standalone host crons (still on the laptop)

Some scheduled jobs predate the container scheduler and live in `~/.config/systemd/user/` on your-workstation. They write to a separate `trading-data/` tree (not the Magpie MinIO bucket) and feed a different consumer (the tanker dashboard).

| Job | When | What | Where |
| --- | --- | --- | --- |
| `ais-phase1.timer` | Every 4h | Tanker AIS position snapshot | `~/GitHub/trading-data/aisstream/snapshots/` |
| `sar-ingest.timer` | Sunday 06:00 UTC | Sentinel-1 SAR ingest + detection | `~/GitHub/trading-data/sentinel_sar/` |

These do not write into the Magpie data tree. Documented here only so future hands know they're not orphaned.

---

## How to add a new ingest job

1. Add a `Job` entry to the `JOBS` array in [`scripts/scheduler.ts`](../scripts/scheduler.ts) with a unique `name`, the cron string (5-field, America/New_York), and the `npm` command to invoke.
2. If the job needs a new adapter, add it under `server/orchestrator/adapters/` and wire it into the dispatcher used by `scripts/ingest.ts`.
3. Update the table in this file (what / when / writes to where).
4. Open a PR. After merge, rebuild + restart the container on the server (see "Operating the container" above).

---

## Sidecar metadata contract

Any project writing to this data directory should write a sidecar file next to each parquet:

```json
{
  "fetched_at": "2026-04-15T13:01:27Z",
  "data_as_of": "2026-04-15",
  "rows_returned": 50,
  "http_status": 200
}
```

This lets consumers distinguish "parquet has a row dated today" from "parquet was actually refreshed today." Consumers can check `fetched_at` age to detect silently-failed ingests.

---

## Troubleshooting

- **Nothing wrote last night.** `docker compose logs quantfoundry-scheduler --since 24h` on the server. Look for `started` / `ok` / `failed code=N` lines.
- **Authentication failures against MinIO.** Confirm `S3_ENDPOINT_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` are populated in the container: `docker compose exec quantfoundry-scheduler env | grep S3_`. The credentials need read+write on the `quantfoundry-data` bucket.
- **Stale data after a code change.** The container holds the image built from a git snapshot. Pull + rebuild + restart per "Operating the container".
