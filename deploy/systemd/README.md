# systemd ingest units (QF-79)

Server-side cron for Magpie's data ingest, running on `your-server.example.com` as systemd **user** timers (no root, no sudo). Replaces the laptop crontab listed in `data/CRON.md`.

## Layout

| Unit                                   | Purpose                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quantfoundry-ingest@.service`         | Template — runs `npm run ingest -- --source %i`. Instances: `fred`, `eia`, `cftc`, `fmp`, `yfinancial`, `portwatch`, `gfw`, `ofac`, `marinecadastre`. |
| `quantfoundry-ingest@<source>.timer`   | One per source, triggers the matching `quantfoundry-ingest@<source>.service`.                                                                         |
| `quantfoundry-rebuild-catalog.service` | Rebuilds `portfolio.duckdb` from MinIO data and mirrors it to `s3://quantfoundry-data/duckdb/portfolio.duckdb` (sets `CATALOG_S3_PUSH=1`).            |
| `quantfoundry-rebuild-catalog.timer`   | Every 6h.                                                                                                                                             |

## Assumptions

- `/srv/quantfoundry/Magpie` is a clone of this repo.
- `/srv/quantfoundry/.env` is created from `.env.example` and filled in — contains `DATA_URI`, `S3_*`, etc.
- `/srv/quantfoundry/logs/` is writable by the user running the timers.
- The **system timezone is `America/New_York`** (units use unqualified ET wall clocks). Verify with `timedatectl`. If the host is UTC, edit each timer's `OnCalendar=` accordingly.
- `npm`, `npx`, and `aws` CLIs are on `PATH`. `node_modules/` installed in `/srv/quantfoundry/Magpie`.
- `loginctl enable-linger <user>` is set so user timers run when the user isn't logged in.

## Install

```sh
cd /srv/quantfoundry/Magpie
./deploy/systemd/install.sh           # copies + enables all units
./deploy/systemd/install.sh --dry-run # preview only
```

The script is idempotent — safe to re-run after editing a unit.

## Operations

```sh
# Show all timers and next firing
systemctl --user list-timers --no-pager

# Trigger a job manually (one-shot, doesn't change the timer)
systemctl --user start quantfoundry-ingest@fred.service
systemctl --user start quantfoundry-rebuild-catalog.service

# Inspect last run
systemctl --user status quantfoundry-ingest@fred.service
journalctl --user -u quantfoundry-ingest@fred.service -n 100

# Disable a timer (e.g. retiring a source)
systemctl --user disable --now quantfoundry-ingest@gfw.timer
```

Per-source logs (in addition to journald) land at `/srv/quantfoundry/logs/ingest-<source>.log`.

## Schedules

All times are America/New_York (the assumed host TZ). Mirrors `data/CRON.md`.

| Source          | OnCalendar                |
| --------------- | ------------------------- |
| FRED            | `Mon..Fri *-*-* 19:00:00` |
| EIA             | `Wed *-*-* 22:30:00`      |
| CFTC            | `Fri *-*-* 20:00:00`      |
| FMP             | `Sun *-*-* 18:00:00`      |
| yfinancial      | `Sun *-*-* 18:30:00`      |
| PortWatch       | `Tue *-*-* 09:30:00`      |
| GFW             | `*-*-* 04:30:00`          |
| OFAC            | `*-*-* 02:00:00`          |
| MarineCadastre  | `*-*-* 07:00:00`          |
| Catalog rebuild | `*-*-* 00,06,12,18:30:00` |

Each timer has `Persistent=true` — if the host was offline at scheduled time, the next boot fires the missed run once. `RandomizedDelaySec` jitter is 60–120s to avoid thundering-herd against external APIs.

## What's not here

- **SPY chain ingest** is owned by data-signals/vol-buyer — runs from there, not Magpie. Cron lives in that repo's deployment.
- **Signal HTTP ingress** is the running server (`npm run server`), managed separately as a long-running service.
