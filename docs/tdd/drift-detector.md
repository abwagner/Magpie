# Strategy Drift Detector

How QF detects when a live strategy is behaving differently than its backtest or spec said it would — and what it does about it.

This is an **implemented** module. The drift detector ships in `server/risk/drift-detector.ts` (module entrypoint), `server/risk/fast-tier.ts` (per-fill hard-bound checks), `server/risk/slow-tier.ts` (60s timer + statistical machinery), and `server/risk/baseline-resolver.ts` (baseline source resolution). The previous design intent sketched in `portfolio-risk-engine.md` (nightly-only, auto-halt on z-score, point-estimate thresholds) has been superseded by this two-tier design now live in code.

---

## 1. The problem and the signal-vs-noise tension

Position reconciliation answers "do my books match the broker's?". Strategy drift answers "is each strategy behaving the way its backtest or spec said it would?". A strategy whose live realized P&L curve has detached from its backtest distribution, whose live hit rate has collapsed, or whose live fill rate has dropped to zero is a risk event even when every fill reconciles cleanly.

The temptation is to alert on point estimates. **Don't.** A strategy with 3 live trades and a -5% P&L is not "drifting" — it's a small sample. Alerts on tiny samples train operators to ignore the alert channel; six months of noise burns through alert fatigue, and the day a real drift fires it gets ignored.

Two design principles fall out:

- **Hard floors and distributional drift are different machinery.** "Daily realized loss exceeded $X" is a hard floor — no statistics, fire on the threshold crossing. "Realized vol has drifted outside the strategy's spec range" is a distribution check — needs sample-size gating, confidence intervals, and an alert budget.
- **Action on trip is alert, not halt** (at v1). Operators decide whether to halt the strategy. Auto-halt is deferred until we have enough live history to know which metrics, at which thresholds, justify the blast radius of cutting off a strategy.

---

## 2. Two tiers of checks

### 2.1 Fast tier — per-fill hard-bound checks

Triggered on every insert into `audit_fills` (the existing fill observer fires the trigger; see [cross-cutting.md §5](cross-cutting.md#5-audit-chain-ddl) and [order-flow.md §4](order-flow.md#4-audit-chain)).

| Check                         | Hard bound source                                                                       | Fires when                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Daily realized-loss floor** | `strategy_spec.drift.daily_loss_floor` (per-strategy, dollars or % of allocated equity) | Today's per-strategy realized P&L crosses below the floor.                                             |
| **Notional envelope**         | `strategy_spec.drift.max_notional`                                                      | Sum of per-strategy notional (absolute, all open positions) exceeds the envelope.                      |
| **Position-count envelope**   | `strategy_spec.drift.max_positions`                                                     | Count of open positions for the strategy exceeds the cap.                                              |
| **Fill-cadence floor**        | `strategy_spec.drift.max_seconds_between_fills`                                         | More than this many seconds since the last fill **during a window the strategy spec marks as active**. |

No statistics. Cross the bound, fire the alert.

These complement (don't replace) the live gate evaluator — the gate prevents most envelope breaches at submission time, but multi-leg slippage, late fills, and operator-originated activity (manual entry, manual liquidation) can put the portfolio outside a strategy's expected envelope after the fact. The fast-tier check catches that.

### 2.2 Slow tier — 60s timer distributional checks

A scheduled handler ticks every 60s (default; configurable per-strategy via `strategy_spec.drift.tick_seconds`). For each strategy, it computes the metrics below over the rolling window declared in the spec and runs them through the §3 statistical machinery.

| Metric                         | Computed from                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| **Realized P&L distribution**  | `audit_fills` rolled up to per-strategy daily P&L.                                      |
| **Hit rate**                   | Profitable closing fills ÷ total closing fills over window.                             |
| **Mean fill-price slippage**   | `audit_fills.slippage` (see [cross-cutting.md §5](cross-cutting.md#5-audit-chain-ddl)). |
| **Mean signal-fill latency**   | `audit_fills.fill_ts - audit_intents.created_at` joined on `intent_id`.                 |
| **Realized return-volatility** | Standard deviation of daily P&L over the window.                                        |

The metrics that PRE's older drift section listed under fast-cadence concerns (fill rate as a ratio, holding period, max single-position concentration) collapse into the slow tier — they're distributional, not hard-bound. The previously-listed "position-turnover" metric is dropped at v1; it's a noisy proxy for "is the strategy doing what its backtest said" and is captured better by the realized-P&L distribution check.

---

## 3. Statistical machinery (slow tier)

Three gates between "I computed a number" and "I fire an alert". A check passes all three before it fires.

### 3.1 Minimum-sample-size gate

Each metric has a `n_min` requirement. Until the rolling window holds at least `n_min` observations, the metric is **not evaluated** — no alert can fire, but the GUI surfaces "monitoring warming up: N/n_min" so the operator knows.

Defaults (per-metric; overridable in `strategy_spec.drift.<metric>.n_min`):

| Metric                     | `n_min` default | Unit          | Why                                                      |
| -------------------------- | --------------- | ------------- | -------------------------------------------------------- |
| Realized P&L distribution  | 20              | trading days  | Below this, CIs on daily P&L mean are meaningless.       |
| Hit rate                   | 30              | closing fills | At 10 trades a single bad streak swings the rate by 30%. |
| Slippage                   | 30              | fills         | Same reasoning.                                          |
| Signal-fill latency        | 20              | fills         | Tighter — latency is more stable than P&L.               |
| Realized return-volatility | 30              | daily returns | Below this, the σ̂ estimate itself is noisy.              |

### 3.2 Confidence-interval check, not point estimate

For each metric the detector computes the 95% CI of the sample statistic (e.g., for the mean: `μ̂ ± 1.96 · σ̂ / √n`). The drift check is:

- **CI fully outside the spec range** → fire.
- **CI overlaps the spec range at all** → don't fire.

This is the strict rule. It avoids false positives at the cost of missing slow drift. v1 ships strict; if operators report missing real drift, relax to "CI overlap with spec range < 10%" as a follow-up.

For one-sided metrics (P&L too low is bad; too high is fine — high P&L "drift" is a feature, not a bug), only the bad-direction tail of the CI is checked against the spec.

### 3.3 Alert budget — multiple-comparisons awareness

Naively, checking 5 metrics × 1 tick/day at the strict rule gives ~5 alert opportunities per strategy per day. Across 10 strategies that's 50/day. Even with the CI gate keeping false positives low, operators tune out.

The rule: **at most one alert per (strategy_id, metric) per UTC day.** When a metric fires, the detector records the firing in `drift_alerts` and suppresses further alerts for that pair until 00:00 UTC. The suppression does not silence dashboards — `drift_alerts` rows are still queryable; the alert router just doesn't re-route.

This is the operationally-meaningful version of Bonferroni — operators reason about "I get at most one drift alert per strategy per metric per day" instead of about α values.

---

## 4. Baseline source

Three paths for declaring the spec range a metric is compared against. Resolved in this order per (strategy, metric):

1. **Explicit declaration in `strategy_spec.drift.<metric>.range`** — e.g., `realized_vol: { range: [0.10, 0.35] }`. Primary path. Operator-curated, version-controlled with the strategy.
2. **Pinned QO backtest archive.** When the strategy declares `strategy_spec.drift.baseline_qo_run: "s3://.../path/"`, the detector reads the archive's per-fold OOS results and computes the spec range as the per-fold mean ± per-fold σ. The pinned archive lives in MinIO at the same path the GUI's Backtests tab reads from (per `QO_ARCHIVE_URL` / `WfoSpec.archive_to_url`). Pinning is operator-controlled — re-pin on promotion.
3. **Computed from the strategy's own historical fills.** When neither (1) nor (2) is declared, the detector falls back to a rolling-window historical baseline from `audit_fills` (default `90 days`). This is the weakest baseline — drift can hide if it's been slowly happening for the entire window. Surfaced in the GUI with a "computed baseline (90d)" badge so operators know what they're looking at.

A strategy with **no** declared baseline and **insufficient historical fills** (less than `90 days` of live activity) has drift detection **disabled** for the slow tier. The GUI shows a "drift monitoring not yet active" banner. Fast-tier hard floors still apply if declared.

---

## 5. Action on trip

### 5.1 Alert routing (v1)

Drift trips emit alerts via the existing alert router (see [alerts.md](alerts.md)). Alert payload:

```ts
interface DriftAlert {
  alert_type: "drift_fast_floor" | "drift_slow_distribution";
  strategy_id: string;
  portfolio_id: string;
  metric: string;
  observed: number | { ci_lower: number; ci_upper: number };
  spec_range: [number, number] | { floor: number } | { ceiling: number };
  baseline_source: "spec" | "qo_pinned" | "computed_historical";
  sample_size: number;
  asof: string; // ISO 8601
  correlation_id: string;
}
```

Routes via the existing rules — log channel always; internal channel; slack if the per-strategy spec opts in. No new alert channels are introduced.

### 5.2 No automatic halt at v1

The drift detector does **not** move strategies to `halted` in the lifecycle registry. The operator does, via the existing per-strategy controls.

The reasoning: until we have months of live drift-alert history, we don't know which metric × threshold combinations justify the blast radius of auto-halt. Premature auto-halt rules tend to either over-halt (false positives that disrupt good strategies) or under-halt (rules so loose they don't actually fire when needed). Alert-only at v1 lets us calibrate before automating.

### 5.3 Future enhancement — per-strategy configurable halt-on-drift

Once calibration data exists, individual strategies can opt into auto-halt by declaring `strategy_spec.drift.<metric>.action: halt` (default `alert`). This change is deferred — file a follow-up ticket when the alert volume + outcome data justifies it.

---

## 6. Where it lives

```
server/risk/
  drift-detector.ts             ← module entrypoint; owns the two tiers
  drift-detector.test.ts        ← stat-machinery unit tests + tier-trigger integration tests
  fast-tier.ts                  ← per-fill hard-bound checks
  slow-tier.ts                  ← 60s timer + statistical machinery (CIs, n_min, alert budget)
  baseline-resolver.ts          ← spec → qo_pinned → computed_historical resolution
src/types/
  drift.ts                      ← shared types (DriftAlert, DriftSpec, BaselineRange)
```

**Reads from:**

- `audit_fills`, `audit_intents` (both via DuckDB) — fast tier subscribes to the same fill observer that mutates portfolio state in `server/portfolio/engine.ts`; slow tier queries on its timer.
- MinIO archive (only when `baseline_qo_run` is declared).
- Strategy specs (`config/strategies/<strategy>.json` or the equivalent).

**Writes to:**

- `drift_alerts` table (new — see §7). One row per fire, with the alert-budget enforcement reading the same table.
- Alert router (see §5.1).

**Doesn't touch:**

- Lifecycle state (at v1; see §5.2).
- The gate evaluator. Drift detection is post-hoc; the gate is at-submit.

---

## 7. The `drift_alerts` table

New table in the same DuckDB the audit chain lives in:

```sql
CREATE TABLE IF NOT EXISTS drift_alerts (
  id                VARCHAR PRIMARY KEY,         -- ULID
  alert_type        VARCHAR NOT NULL,            -- 'drift_fast_floor' | 'drift_slow_distribution'
  strategy_id       VARCHAR NOT NULL,
  portfolio_id      VARCHAR NOT NULL,
  metric            VARCHAR NOT NULL,
  observed_json     VARCHAR NOT NULL,            -- JSON: scalar OR {ci_lower, ci_upper}
  spec_range_json   VARCHAR NOT NULL,            -- JSON: [lo, hi] OR {floor} OR {ceiling}
  baseline_source   VARCHAR NOT NULL,            -- 'spec' | 'qo_pinned' | 'computed_historical'
  sample_size       INTEGER NOT NULL,
  fired_at          TIMESTAMP NOT NULL,
  fired_date_utc    DATE NOT NULL,               -- denormalized for the per-day alert budget
  correlation_id    VARCHAR NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_budget ON drift_alerts(strategy_id, metric, fired_date_utc);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_correlation ON drift_alerts(correlation_id);
```

Schema lives in [cross-cutting.md §5](cross-cutting.md#5-audit-chain-ddl) once this lands (a small addition; the audit-chain DDL section is the natural home for new DB tables in the same store).

The per-day alert budget (§3.3) is enforced by a `SELECT COUNT(*) FROM drift_alerts WHERE strategy_id=? AND metric=? AND fired_date_utc = today_utc()` check before emitting.

---

## 8. Observability

The detailed framework lives in [`observability.md`](observability.md). This section names only the events the drift detector emits. All events follow the common JSON schema: `ts`, `level`, `service` (= `"drift-detector"`), `correlation_id`, `event`, plus the event-specific payload below.

The `correlation_id` on drift events is propagated from the inbound fill that triggered the work (fast tier) or generated at the tick boundary (slow tier — a timer-driven entry point with no inbound message, so it anchors a fresh ULID per tick per [observability.md §4.1](observability.md#41-generation)). The same ID lands on the `DriftAlert` payload (§5.1) and the `drift_alerts.correlation_id` column (§7), so a fired alert reconstructs back to the fill or tick that produced it.

| Event                     | Level   | Payload (key fields)                                                                                      | Emitted when                                                                                                                                       |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drift.started`           | `info`  | `fast_tier`, `slow_tier`, `tick_seconds`                                                                  | Detector boots; names which tiers are active and the slow-tier cadence.                                                                            |
| `drift.stopped`           | `info`  | `reason`                                                                                                  | Detector shuts down (process stop / config reload).                                                                                                |
| `drift.fast.checked`      | `debug` | `strategy_id`, `portfolio_id`, `check`, `observed`, `bound`                                               | Per-fill hard-bound check ran (§2.1). Every check at `debug`; only a crossing escalates to `drift.fast.tripped`.                                   |
| `drift.fast.tripped`      | `warn`  | `strategy_id`, `portfolio_id`, `check`, `observed`, `bound`, `alert_type` (= `"drift_fast_floor"`)        | A fast-tier hard bound was crossed (§2.1). Paired with a `drift_fast_floor` alert and a `drift_checks_tripped_total` increment.                    |
| `drift.slow.evaluated`    | `debug` | `strategy_id`, `metric`, `sample_size`, `n_min`, `ci_lower`, `ci_upper`, `spec_range`, `baseline_source`  | A slow-tier metric was evaluated (§3). Carries the CI and the spec range it was compared against, whether or not it tripped.                       |
| `drift.slow.warming_up`   | `debug` | `strategy_id`, `metric`, `sample_size`, `n_min`                                                           | Metric below its `n_min` gate (§3.1); not evaluated. Mirrors the GUI "monitoring warming up" badge.                                                |
| `drift.slow.tripped`      | `warn`  | `strategy_id`, `portfolio_id`, `metric`, `observed`, `spec_range`, `baseline_source`, `sample_size`       | CI fell fully outside the spec range (§3.2) and the per-day alert budget (§3.3) had room. Paired with a `drift_slow_distribution` alert.           |
| `drift.alert.suppressed`  | `debug` | `strategy_id`, `metric`, `fired_date_utc`                                                                 | A metric would have tripped but the per-(strategy, metric) per-UTC-day budget (§3.3) was already spent. The `drift_alerts` row is **not** written. |
| `drift.alert.recorded`    | `info`  | `strategy_id`, `metric`, `alert_type`, `drift_alert_id`                                                   | A `drift_alerts` row was persisted and routed to the alert router (§5.1).                                                                          |
| `drift.baseline.resolved` | `debug` | `strategy_id`, `metric`, `baseline_source` (`spec` \| `qo_pinned` \| `computed_historical`), `spec_range` | Baseline resolution (§4) chose a source for a (strategy, metric) pair.                                                                             |
| `drift.baseline.disabled` | `info`  | `strategy_id`, `metric`, `reason`                                                                         | No declared baseline and insufficient history (§4); slow-tier drift detection disabled for the pair.                                               |

**Sampling.** The slow tier evaluates every metric every tick (default 60s) for every strategy; emitting `drift.slow.evaluated` / `drift.slow.warming_up` at `debug` keeps steady-state `info` volume to the rare trip/record events while preserving full reconstruction at `debug`. Per [observability.md §6.4](observability.md#64-sampling), the unsampled counts live in the metrics (§9), not the logs.

**Implementation note.** The module today emits `drift.started`, `drift.alert.recorded`, and `drift.stopped` (`server/risk/drift-detector.ts`); the per-check / per-metric events above are the design target the fast-tier (`fast-tier.ts`) and slow-tier (`slow-tier.ts`) modules emit as each tier fills in.

## 9. Metrics

Per [observability.md §6.4](observability.md#64-sampling), metrics carry the unsampled counts that the sampled logs above don't.

| Metric                             | Type    | Labels                          | Description                                                 |
| ---------------------------------- | ------- | ------------------------------- | ----------------------------------------------------------- |
| `drift_checks_total`               | counter | `strategy_id`, `tier`, `metric` | Every check evaluated (fast or slow), tripped or not.       |
| `drift_checks_tripped_total`       | counter | `strategy_id`, `tier`, `metric` | Checks that crossed their bound / spec range.               |
| `drift_alerts_emitted_total`       | counter | `strategy_id`, `alert_type`     | `drift_alerts` rows written + routed (post budget).         |
| `drift_alerts_suppressed_total`    | counter | `strategy_id`, `metric`         | Trips suppressed by the per-day alert budget (§3.3).        |
| `drift_slow_tick_duration_seconds` | gauge   | —                               | Wall time of the last slow-tier tick across all strategies. |

## 10. Out of scope

- **Per-strategy configurable halt-on-drift.** Deferred — see §5.3.
- **Bayesian / online-learning baselines.** v1 uses simple frequentist CIs from a rolling window. Bayesian updates would help shorter samples but add complexity not justified at v1.
- **Cross-strategy drift correlation.** "All strategies underperformed today" is a different signal than "this strategy's edge has decayed". Out of scope until we have enough strategies running to make the cross-cut meaningful.
- **Intraday auto-halt circuit-breakers.** Fast-tier hard floors fire alerts; they do not auto-halt. Operators decide. Auto-halt circuit-breakers are part of the §5.3 deferred work.
- **Backtest-based drift evaluation.** Drift detection is a live-only concern. The QO backtest archive is consumed (as a baseline source) but the detector does not run inside `BacktestEngine`.
