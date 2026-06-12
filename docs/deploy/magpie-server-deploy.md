# Deploy `magpie-server` (QF-201 / M10-7) — Agent Runbook

> **For a Claude instance running on the Magpie home server.** Self-contained:
> read it top to bottom, execute the steps, verify, and report. You are
> _deploying + verifying_ pre-existing infrastructure-as-code — you are **not**
> writing application code. Companion reference: `docs/RUNBOOK.md` →
> "QF server deployment (M10-7 / QF-201, Option B)" and
> `docs/tdd/deployment-topology.md`.

## Your task

Bring up the `magpie-server` API container on **this server** (the Magpie home
server) and verify it is healthy and reachable by the scheduler/cron container.
Report results to the operator.

## Context (why)

Magpie is the live options-trading system. Per the **Option B** topology
(QF-202), the full API server runs here on the home server — _not_ on a laptop —
because it holds the **sole MinIO write key** (single-writer guarantee for the
audit chain / DuckDB / archive). `magpie-server` is a long-running daemon on
port **3001** (HTTP API + state WebSocket; it also serves the built GUI bundle).
It joins the existing compose project alongside `nats` and the
`magpie-scheduler` cron container, which reach it by its service DNS name.

The IaC already exists in the repo:
`docker-compose.yml` (`magpie-server` service + `magpie-server-data` volume),
`Dockerfile.server`, and the `qf-server` Prometheus scrape job (which now targets
`magpie-server:3001`). You are deploying it, not authoring it.

## Preconditions — check these first (stop if any fail)

1. **You are on the Magpie home server**, not a laptop. Confirm the hostname; do
   **not** run this on a dev machine (it would race for port 3001 and the write key).
2. The repo is cloned here and you can `git pull` to get commit **`3ef8a4a`** or later
   (the commit that renamed the service to `magpie-server`). Verify:
   `git log --oneline -1` and `git log --oneline | grep -m1 magpie-server`.
3. Docker + Docker Compose are installed and the daemon is running
   (`docker compose version`, `docker ps`).
4. The shared compose project already runs `nats` and `magpie-scheduler`
   (`docker compose ps`). `magpie-server` must end up on the **same compose
   project / network** as the scheduler (that's what step 7 verifies).
5. A `.env` file exists in the repo root with the required secrets (next section).

## Environment (`.env`) — required keys

**Do not print secret values.** Confirm presence only (e.g.
`grep -c '^S3_ACCESS_KEY_ID=' .env`). The authoritative list is the
`magpie-server` service's `env_file`/`environment` in `docker-compose.yml` — read
it to confirm; this table is the expected set:

| Key (in `.env`)        | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `S3_ACCESS_KEY_ID`     | **Write-capable** MinIO key (the M10-6 single-writer key) |
| `S3_SECRET_ACCESS_KEY` | …its secret                                               |
| `DATA_URI`             | `s3://…` data backend root                                |
| `WRITE_JOB_TOKEN_PATH` | Path to the write-job bearer token file                   |
| `FMP_API_KEY`          | Market-data provider key                                  |
| `SLACK_WEBHOOK_URL`    | Alert routing                                             |
| `MD_TOKEN`             | Market-data token                                         |

Non-secret prod invariants are pinned in the compose `environment` block (you do
**not** put these in `.env`): `APP_ENV=prod`, `PORT=3001`,
`NATS_URL=nats://nats:4222`, `CATALOG_DB_PATH=/data/portfolio.duckdb`,
`LOG_FILE=/data/logs/server.log`. Data persists on the `magpie-server-data` volume.

## Steps

```bash
# 1. Get the latest IaC (must include the magpie-server rename, 3ef8a4a+)
git pull

# 2. Confirm .env has the required keys (presence only — do NOT print values)
for k in S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY DATA_URI WRITE_JOB_TOKEN_PATH \
         FMP_API_KEY MD_TOKEN; do
  printf '%s: ' "$k"; grep -qc "^$k=" .env && echo present || echo MISSING
done

# 3. (If not already up) make sure NATS is running — magpie-server depends on it
docker compose up -d nats

# 4. Build + start the always-on Magpie API server
docker compose up -d --build magpie-server

# 5. Wait for healthy (compose healthcheck curls /api/status; start_period ~40s)
docker compose ps magpie-server          # STATUS column should reach "healthy"
docker compose logs --tail=80 magpie-server   # confirm clean boot, NATS connected, no fatal errors

# 6. /api/status reachable on 3001 from the host
curl -fsS http://localhost:3001/api/status

# 7. M10-5 path — the scheduler/cron container can reach it over the network
docker compose exec magpie-scheduler \
  curl -fsS http://magpie-server:3001/api/status
```

## Success criteria

- `docker compose ps magpie-server` → **STATUS = healthy**.
- `/api/status` returns HTTP 200 / JSON **both** from the host (step 6) **and**
  from inside the scheduler container (step 7).
- Logs show NATS connected and the data backend initialized, no repeated crash/restart.

If all of 1–7 pass, the compose deploy is **done**.

## Troubleshooting

- **Health never reaches "healthy" / container restarting:** `docker compose logs
magpie-server`. Common causes:
  - A missing `.env` key → the server throws at boot. Fix `.env`, `docker compose up -d magpie-server`.
  - **NATS not up** → run step 3 first.
  - **duckdb native load failure** → the image is `node:22-bookworm-slim` (glibc) on
    purpose (Alpine/musl breaks duckdb, QF-167). Confirm the build succeeded; rebuild with
    `docker compose build --no-cache magpie-server` if a prior bad layer is cached.
  - **Port 3001 already bound** → another server instance or a GUI dev process is
    running. Stop it (`lsof -i :3001`), then retry.
- **Step 7 fails (scheduler can't resolve `magpie-server`):** the two services must
  share a compose project + network. `docker compose ps` should list both; if the
  scheduler comes from a _separate_ compose project (e.g. an ops repo), they are not on
  the same network — either bring `magpie-server` up in that same project, or attach
  both to a shared external network. **Report this** rather than guessing at network surgery.
- **"Cannot connect to the Docker daemon":** start Docker, retry.

## Operator-only — do NOT attempt unless explicitly told

- **M10-6 MinIO IAM rotation** and the "confirm the server still writes + a read-only
  laptop key is rejected on a direct PutObject" check. That is a deliberate operator
  step; only perform it **after** the operator has rotated the IAM key and asks you to.
- **Traefik route / TLS** for external GUI exposure (topology §7) — separate, out of scope here.

## Do NOT

- Don't print secret values from `.env`.
- Don't deploy on a laptop / dev machine.
- Don't modify the IaC (`docker-compose.yml`, `Dockerfile.server`,
  `prometheus.yml`) unless a step fails due to a genuine config bug — if so, describe
  the bug and propose the **minimal** fix; do not rewrite.

## Report back to the operator

State: STATUS of `magpie-server`, the `/api/status` output (redact any secrets),
whether step 7 (scheduler reachability) passed, and any errors hit + what you did.
Conclude with: **"QF-201 compose deploy is up; M10-6 IAM-rotation verification
remains an operator step,"** or the specific blocker if not.
