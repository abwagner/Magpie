# Grafana dashboards — Magpie starter set (QF-277 / M15-3)

Five dashboards shipped as code. Grafana provisions them on startup; the
JSON in this directory is the source of truth, not the Grafana UI.

| File                           | UID                     | Datasource(s) |
| ------------------------------ | ----------------------- | ------------- |
| `trading-pipeline-health.json` | `qf-trading-pipeline`   | Prometheus    |
| `broker-reconciliation.json`   | `qf-broker-recon`       | Prometheus    |
| `portfolio-risk.json`          | `qf-portfolio-risk`     | Prometheus    |
| `market-data-ingest.json`      | `qf-market-data-ingest` | Prometheus    |
| `logs-explorer.json`           | `qf-logs-explorer`      | Loki          |

## Provisioning wiring

This directory is **not** the provider-config directory. The split keeps
dashboard JSON away from the provider YAML so Grafana doesn't try to load
the provider file as a dashboard.

- Provider config: `../provisioning/dashboards/dashboards.yaml` — mounted
  at `/etc/grafana/provisioning` (read-only).
- Dashboard JSON (this dir): mounted at `/etc/grafana/dashboards`
  (read-only) — see the `grafana` service volumes in
  [`docker-compose.yml`](../../../../docker-compose.yml).
- The provider's `options.path` points at `/etc/grafana/dashboards`, and
  `updateIntervalSeconds: 30` reloads changed JSON without a restart.

Datasource UIDs (`prometheus`, `loki`) are fixed in
`../provisioning/datasources/datasources.yaml`; every panel references one
of those two UIDs so provisioning resolves with no manual datasource pick.

Bring the stack up with the `observability` profile:

```bash
docker compose --profile observability up -d
# Grafana → http://localhost:3000  (admin / admin, dev only)
```

## Correlation-ID click-through

Per [observability.md §1](../../../../docs/tdd/observability.md#1-purpose--acceptance-test),
the acceptance test is reconstructing one position lifecycle from a single
`correlation_id`. Two mechanisms make the metric→logs hop work:

1. **Per-panel data link.** Every panel in dashboards 1–4 carries a
   "Drill into logs (Logs Explorer)" data link that opens
   `qf-logs-explorer` with the current time range and an empty
   `correlation_id` textbox ready to paste into. The Logs Explorer also
   appears as a dashboard-level link (tag `logs`). All 20 of these links
   are byte-identical — see [Canonical panel data link](#canonical-panel-data-link)
   for the definition every panel must reuse verbatim.
2. **Loki derived field.** `correlation_id` is Loki structured metadata
   (extracted by [`alloy-config.alloy`](../../alloy-config.alloy)), and
   the Loki datasource defines a `correlation_id` derived field
   (`datasources.yaml`) that turns the ID printed in any log line into an
   Explore link pre-filtered to that one ID.

The Logs Explorer's `correlation_id` is a free-text variable: blank
matches everything, a pasted ULID narrows to one lifecycle via
`| correlation_id=~"<id>.*"`.

### Canonical panel data link

These dashboards are provisioned as raw JSON, and Grafana's dashboard
schema has no include/template mechanism for per-panel data links — each
panel must carry its own copy. To keep the 20 copies consistent, the
"Drill into logs" link has exactly one canonical form. **Every panel data
link must be byte-identical to this block** (it lives under
`fieldConfig.defaults.links` on each panel):

```json
{
  "title": "Drill into logs (Logs Explorer)",
  "url": "/d/qf-logs-explorer/logs-explorer?${__url_time_range}&var-correlation_id=",
  "targetBlank": false
}
```

Rules for any new panel or dashboard:

- Copy the block above verbatim — do not reword the `title`, change the
  `qf-logs-explorer` UID, or drop `${__url_time_range}` (it forwards the
  current time range) or the trailing `var-correlation_id=` (it lands the
  user on an empty, paste-ready `correlation_id` textbox).
- Keep `targetBlank: false` so the drill-through replaces the current tab,
  matching the rest of the set.
- After editing, confirm every copy still matches:

  ```bash
  grep -A2 '"title": "Drill into logs' \
    deploy/observability/grafana/dashboards/*.json \
    | grep -E '"url"|targetBlank' | sort | uniq -c
  ```

  Each distinct `url`/`targetBlank` line should report the same count for
  every file — any drift shows up as an extra unique line.

If a future change makes manual duplication unmanageable (e.g. many more
panels), promote the dashboards to a Jsonnet/grafonnet generator and emit
this link from a single shared constant. Until then, the verbatim copy
plus the check above is the source of truth.

## Metric → panel map

Panels target the metric names declared in the codebase exactly:

| Dashboard          | Metric(s)                                                                                                                                                                                                | Defined in                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Trading pipeline   | `orders_submitted_total`, `orders_filled_total`, `orders_rejected_total`, `orders_rejected_by_broker_total`, `orders_cancelled_total`, `order_lifecycle_duration_seconds`                                | `server/order/metrics.ts`                    |
| Broker & recon     | `orders_filled_total`, `orders_rejected_by_broker_total`, `order_lifecycle_duration_seconds`, `up`                                                                                                       | `server/order/metrics.ts` + scrape target    |
| Portfolio & risk   | `exit_rule_headroom_pct`, `exit_rule_trips_total`, `exit_rule_evaluation_duration_ms`                                                                                                                    | `server/portfolio/exit-rule-monitor.ts`      |
| Market-data ingest | `marketdata_book_budget_denied_total`, `marketdata_book_budget_reevaluation_reclaim_total`, `marketdata_subscription_dropped_events_total`, `qf_http_request_duration_seconds`, `qf_http_requests_total` | `server/market-data/*.ts`, `server/index.ts` |
| Logs explorer      | Loki `{service, level}` + structured-metadata `correlation_id`                                                                                                                                           | `alloy-config.alloy`                         |

## Known gaps — ticket vs. live metrics

The original ticket (written before QF-261 / QF-281 / QF-339) named
several metrics that the current system does **not** emit. The dashboards
are built on the metrics that exist today and substitute the closest live
signal; the panels are annotated where they do so. When the missing
metrics land, swap the queries in place.

| Ticket asked for                       | Status today                                          | Substituted with                                |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `order_signal_to_fill_seconds`         | Not emitted (`server/signals` retired in QF-261/281). | `order_lifecycle_duration_seconds` quantiles.   |
| signals/min                            | Signal ingress retired.                               | Order submit/fill/reject rates.                 |
| reconciliation drift counter           | Not emitted.                                          | Per-broker submit-to-terminal p95 + `up` probe. |
| broker connection-status gauge         | Not emitted.                                          | `up{service="qf-server"}` scrape probe.         |
| `portfolio_net_delta_gauge` / `_vega_` | Not emitted.                                          | Exit-rule headroom as the live risk proxy.      |
| drawdown gauge, position count         | Not emitted.                                          | Distinct armed `position_id` count.             |
| `orchestrator_freshness_lag_seconds`   | Orchestrator/write-jobs leg reshaped (QF-339).        | Market-data ingest health + HTTP latency.       |
| write-jobs queue depth                 | Not emitted as a Prometheus gauge.                    | (omitted — no proxy that isn't misleading)      |

Note: the OrderPlane, exit-rule, and market-data metrics live on
**isolated** `prom-client` registries (per the QF-52 module pattern) and
are not yet merged into the `/metrics` endpoint that `server/index.ts`
exposes (only `qf_*` HTTP + default metrics are wired today, QF-276).
Merging those registries into the exposed endpoint is follow-up work; the
dashboards reference the metric names as declared so they light up the
moment the registries are aggregated.
