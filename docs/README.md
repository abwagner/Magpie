# Magpie — Documentation Index

A map of everything under `docs/`, plus where to find open work.

## Where work is tracked

In-flight bugs, feature tickets, and milestones live in [Plane → Magpie](<internal tracker>). The doc tree below holds design specs, runbooks, and reference material — it is no longer where bugs / settings stubs / TODOs are tracked.

Open architectural questions live in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) as a transitional snapshot; new questions should be filed as Plane tickets going forward.

## Top-level docs

| File                                           | What it is                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TRADING-SYSTEM-TDD.md](TRADING-SYSTEM-TDD.md) | Anchor design document — components, interactions, deployment, risk limits, promotion pipeline. Includes the glossary. **Start here.**                                                                                                  |
| [RUNBOOK.md](RUNBOOK.md)                       | Operational procedures only — install, configure, paper-trade, go live, monitor, troubleshoot. **For design questions** ("how does manual liquidation work", "why is the gate failing closed"), go to the relevant component TDD below. |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)         | Consolidated architectural open questions across the live design.                                                                                                                                                                       |
| [CODING-STANDARDS.md](CODING-STANDARDS.md)     | TypeScript conventions, testing, error handling, dependency policy.                                                                                                                                                                     |
| [MIGRATION-JSX-TS.md](MIGRATION-JSX-TS.md)     | JSX → TS migration tracker. Mostly done; remaining items are `src/lib/*.js` math libs.                                                                                                                                                  |

## Component TDDs ([`tdd/`](tdd/))

**Architectural — the design intent for live trading:**

| Doc                                                                    | Subsystem                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [risk-gate-architecture.md](tdd/risk-gate-architecture.md)             | Custom NT `RiskEngine` plugin gating strategy submissions; parent-budget evaluation; closes-only fail-open.                                                                   |
| [exec-algorithms.md](tdd/exec-algorithms.md)                           | NT `ExecAlgorithm` plugin slot; stateless algos owning pricing / repeg / slicing within the gate-approved envelope.                                                           |
| [strategy-deployment-topology.md](tdd/strategy-deployment-topology.md) | Paper-live vs prod deployment modes; per-strategy state contract; dependency policy.                                                                                          |
| [nats-subjects.md](tdd/nats-subjects.md)                               | Canonical index of every NATS subject in the system — orders, risk gate, market data, signals. Payload schemas stay owned by the relevant component TDD.                      |
| [backtest-gate.md](tdd/backtest-gate.md)                               | How the QF gate evaluator runs inside quant-optimizer's BacktestEngine — TS CLI subprocess, NDJSON, phantom audit chain.                                                      |
| [drift-detector.md](tdd/drift-detector.md)                             | Per-strategy drift detection — fast tier (per-fill hard floors) + slow tier (60s timer, CI-checked distributional); alert-only, sample-size-gated, per-day alert budget.      |
| [exit-rule-monitor.md](tdd/exit-rule-monitor.md)                       | Framework-side monitor for strategy-declared exit rules (stop_loss / target / max_hold / max_drawdown). Composite-position P&L aggregation, idempotency guard, GUI surfacing. |

**Implemented and current** — describe behavior shipped in the codebase today:

| Doc                                                      | Subsystem                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [alerts.md](tdd/alerts.md)                               | Alert router — schema, three channels (log / internal / slack), rule matching, recent-alerts ring, producer callsite contract. Slack is opt-in via `SLACK_WEBHOOK_URL`. |
| [broker-integration.md](tdd/broker-integration.md)       | QF↔NT broker bridge contract; NATS subject grammar; uniform per-broker NT bundle pattern (Schwab + IBKR symmetric — both full submit + observe + MD via NT clients).    |
| [cross-cutting.md](tdd/cross-cutting.md)                 | DuckDB schemas, market calendar, portfolio config, TS migration policy.                                                                                                 |
| [greek-builder.md](tdd/greek-builder.md)                 | LP solver, Black-Scholes, margin formula. Math reference in Appendix A.                                                                                                 |
| [gui.md](tdd/gui.md)                                     | Workspaces, panels, state plumbing, themes, safety gates, file map.                                                                                                     |
| [observability.md](tdd/observability.md)                 | Cross-runtime structured logging, correlation-ID propagation, per-strategy attribution in the shared TradingNode.                                                       |
| [order-execution.md](tdd/order-execution.md)             | Order lifecycle, intent schema, state machine, position exit controls (manual liquidation + strategy-declared exit rules; no global kill switch).                       |
| [order-flow.md](tdd/order-flow.md)                       | End-to-end audit chain `audit_intents → audit_orders → audit_fills` with `source` discriminator.                                                                        |
| [portfolio-risk-engine.md](tdd/portfolio-risk-engine.md) | Portfolio state, risk evaluation, fill replay, Greeks, reconciliation, gate evaluator.                                                                                  |
| [write-jobs.md](tdd/write-jobs.md)                       | Persistent async job queue — DuckDB-backed, idempotency-keyed, one-in-flight-per-kind, token-authenticated.                                                             |

## Data ([`data/`](data/) and [`docs/data/`](data/))

Lifecycle docs for data sources and pipelines:

| Doc                                 | Topic                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [data-plane.md](data/data-plane.md) | **Data Plane Component TDD** — unified data-in: live broker MD via NATS, batch non-broker ingestion via adapters, runtime MinIO reads by NT strategies. |
| [collection.md](data/collection.md) | Offline batch ETL — MarketData.app historical chains → Parquet.                                                                                         |
| [sources.md](data/sources.md)       | Per-source costs, rate limits, auth setup, credit budgets, collection scripts.                                                                          |
| [universes.md](data/universes.md)   | Symbol universes used by strategies and backtests.                                                                                                      |
| [../data/CRON.md](../data/CRON.md)  | Live cron schedule (the `quantfoundry-scheduler` container) — job names, schedules, ops.                                                                |

## Other

- [`archive/`](archive/) — point-in-time copies of QF-ISSUES, SETTINGS-STUBS, TODO at the time work moved to Plane.

## Adding a new doc

- Component TDDs go under `tdd/` and follow the existing naming: `<component>.md`.
- Add a row to the table above when you ship a new top-level or TDD doc.
- For open work, file in Plane instead of adding a new tracker file under `docs/`.
- For open architectural questions, file as a Plane ticket; [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) is a transitional snapshot, not a growing list.
