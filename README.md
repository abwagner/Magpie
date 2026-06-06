# Magpie

A personal-use trading control plane for active retail and quant workflows. Ingests inference signals from external model workers, evaluates portfolio risk, runs backtests, and routes orders to a broker. Operated through a dense, dock-able-panel React GUI.

The codebase started life as `portfolio-ev-lab` (an options analysis tool) and was redesigned in 2026 around a dense, dock-able-panel GUI. The trading-system core (signal ingress → strategy → risk → order plane → broker) was built underneath.

## What it does

- **Signal ingestion:** receives outputs from ML model workers via HTTP, persists to NATS JetStream and Parquet
- **Market data:** unified live + historical from IBKR, Schwab, MarketData.app with caching and quality gates
- **Strategy execution:** evaluates signals against market data and portfolio state, produces `OrderIntent`s
- **Risk management:** real-time Greeks, position limits, drawdown halts, broker reconciliation; limits live in `config/risk_limits.yaml` (operator-editable + version-controlled)
- **Strategy lifecycle:** per-strategy state machine (`registered → enabled → running → paused → halted → retired`) with append-only history
- **Order execution:** paper trading (local sim or broker paper), with a path to manual / semi-auto / auto via per-portfolio config. Live submits gated by a `FIRE` typed-confirmation
- **Backtesting:** replay historical signals + chains through strategies with optional risk-limit enforcement
- **Analytics:** signal correlation, predictive power, strategy quality metrics, ongoing signal health monitoring
- **Operator GUI:** six-workspace React shell — Operate · Investigate · Build · Signals · Strategies · Settings — with live `/ws/state` snapshot+delta stream, command palette (⌘K), kill switch (HALT typed-confirmation), and three themes

## Requirements

- Node.js 20+
- Docker (for NATS JetStream; optionally IB Gateway)

### Accounts (for market data and trading)

| Source         | Purpose                                     | Cost                           |
| -------------- | ------------------------------------------- | ------------------------------ |
| MarketData.app | Equity options (live + historical backfill) | Trader plan (100k credits/day) |
| IBKR           | Futures + futures options, order execution  | ~$10/mo data subs              |
| Schwab         | Equity positions, equity options (optional) | Free with account              |

See [docs/data/sources.md](docs/data/sources.md) for full setup details.

## Quick start

```bash
npm install
cp .env.example .env     # add credentials (MD_TOKEN, IBKR, Schwab)
npm start                 # server on :3001, GUI on :5173
```

GUI default is the new shell at `http://localhost:5173/`. The pre-redesign tab UI was removed in commit `84e3de8`.

For full setup (NATS, config files, data collection, paper trading), see the [Runbook](docs/RUNBOOK.md).

## Project structure

```
server/                       # Node.js server (TypeScript)
  signals/                    # Retiring per Plane → Architecture review (signal-driven trading loop)
  market-data/                # Market Data service (adapters, cache, quality gate)
  portfolio/                  # Portfolio & Risk Engine
  order/                      # Order Plane (manual + kill-switch only, post-risk-gate)
  strategy/                   # Strategy lifecycle registry
  risk/                       # Risk limits store (config/risk_limits.yaml)
  analytics/                  # Analytics API endpoints
  orchestrator/               # Data-ingestion adapters (FRED/EIA/CFTC/Databento/MarketData); supervisor half retiring per Plane → Architecture review. Cron schedule: data/CRON.md
  supervisor/                 # Retiring per Plane → Architecture review (signal scheduler process)
  qoJobs/                     # Retiring per Plane → Architecture review (QF→QO submission bridge)
  writeJobs/                  # Persistent async job queue (M10)
  alerts/                     # Alert routing (QF-61) — log / internal WS / Slack channels
  catalog/                    # DuckDB catalog + collectors (audit chain, qo_runs, fills, etc.)
  store/                      # Data lake queries, retention
  db/                         # DuckDB initialization
  calendar/                   # Market calendar
  ws-state.ts                 # /ws/state WebSocket: snapshot + diffs
core/                         # Rust crates compiled to WASM
  qf-quant/                   # BS, SABR, vol surfaces, Greeks
  qf-optimizer/               # LP solver (Greek Builder)
  qf-logging/                 # Structured JSON logging (observability.md §3)
data-signals/                 # Standalone Python project — active signal manifests + emitters
research/                     # Python research packages (ibkr-nt, schwab-nt, signals, logging, models)
deploy/                       # Deployment manifests / scripts
src/
  shell/                      # Workspace shell (header, status bar, grid renderer)
  state/                      # StateProvider (WS) + Zustand UI store
  workspaces/                 # Six WorkspaceDef entries → grid templates
  panels/                     # One file per panel kind + registry.tsx
  screens/                    # Full-page workspaces (Strategies, Settings + sub-screens)
  flows/                      # Modal/drawer flows (OrderTicket, KillConfirm)
  components/ui/              # Primitives (Panel, Modal, Drawer, TypedConfirmation, etc.)
  styles/                     # tokens.css (3 themes) + ui.css (recurring class set)
  lib/                        # Computation libs (BS, SABR, vol surface, LP optimizer)
  types/                      # Shared TypeScript type definitions
config/
  signals.json
  market-data.json
  portfolios.json             # portfolios + strategies + execution_mode (per portfolio)
  risk_limits.yaml            # per-portfolio risk caps; git-tracked
  market-calendar.json
data/                         # gitignored
  chains/                     # Historical chain Parquet files
  signals/                    # Signal Parquet files (written by rollup)
  fills/                      # Fill logs (JSONL, per portfolio)
  results/                    # Backtest results
  strategies.json             # Lifecycle registry persistence
scripts/                      # CLI tools (collect history, IBKR snapshot, analysis)
docs/                         # Documentation
  README.md                   # Index of every doc + pointer to Linear for open work
  TRADING-SYSTEM-TDD.md       # Top-level system design
  tdd/                        # Component TDDs (~17 docs)
  data/                       # Data-source guides (sources, universes, market-data)
  archive/                    # Trackers superseded by Linear (QF-ISSUES, SETTINGS-STUBS, TODO)
  MIGRATION-JSX-TS.md         # JSX → TS migration tracker
```

## GUI workspaces

| Workspace     | What it shows                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operate`     | Daily driver — Risk Headroom, Broker Positions, Approvals, P&L, Recon, Live Feed                                                                                                                            |
| `investigate` | Trade Inspector (Signal → Intent → Order → Fill timeline), Recent Fills, Active Orders                                                                                                                      |
| `build`       | Manual options staging — Chain (1.6kloc legacy ChainPicker, wrapped), Payoff curve, Greek Builder (LP solver via Web Worker), Positions context                                                             |
| `signals`     | Per-model status table (15s polled), Quality chart (lightweight-charts), Live Signal feed                                                                                                                   |
| `strategies`  | Registry table + 380px detail rail (lifecycle diagram, action buttons, notes editor, transition history)                                                                                                    |
| `settings`    | Risk · Data · Models · System · Activity nav. Four sections wired (Limits, Brokers, Signals manifest, Audit log, Data catalog); 11 placeholders tracked in Linear M5 (see [docs/README.md](docs/README.md)) |

**Persistent shell chrome:** header (brand · env pills · account picker · ⌘K · theme cycler · kill switch), workspace tabs (numbered, [/] cycle), halt banner, reconnecting banner, status bar.

**Themes:** Engineered Dark (default), Higher-Contrast Dark, Engineered Light. Driven via `<body data-theme="...">`; persisted in localStorage. IBM Plex Sans/Mono self-hosted via @fontsource.

**Safety primitives:**

- Kill switch (system-wide halt) requires typing `HALT`
- Live order submit requires typing `FIRE`
- Both share `<TypedConfirmation>` — case-sensitive exact match, unit-tested

## Documentation

| Document                                                                              | Purpose                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [System TDD](docs/TRADING-SYSTEM-TDD.md)                                              | Top-level system design: components, interactions, deployment, risk limits, promotion pipeline                           |
| [Component TDDs](docs/tdd/)                                                           | Per-component design (Signal Ingress, Market Data, Strategy, Portfolio, Orders, Backtest, GUI, Analytics, Cross-cutting) |
| [GUI TDD](docs/tdd/gui.md)                                                            | Workspaces, panels, state plumbing, themes, safety gates, file map                                                       |
| [Runbook](docs/RUNBOOK.md)                                                            | Setup, configuration, paper trading, going live, monitoring, troubleshooting                                             |
| [Coding Standards](docs/CODING-STANDARDS.md)                                          | TypeScript conventions, testing, error handling, dependency policy                                                       |
| [Data Sources](docs/data/sources.md)                                                  | Per-source costs, rate limits, auth setup, credit budgets, collection scripts                                            |
| [Magpie v2 plan](../../.claude/plans/quantfoundry-v2.md)                              | Backlog of deferred items (pop-outs, drag-resize, dynamic registry, multi-account, mobile, RBAC, etc.)                   |
| [Open work tracker](<internal tracker>)                                               | Linear project — bugs, settings stubs, execution layer, etc. Authoritative tracker for all in-flight work                |
| [docs archive](docs/archive/)                                                         | Snapshot of QF-ISSUES, SETTINGS-STUBS, and TODO at the time the work moved to Linear (kept for closed-issue history)     |
| [JSX → TS migration](docs/MIGRATION-JSX-TS.md)                                        | TypeScript migration tracker (zero `.jsx` left under `src/`; remaining work is `src/lib/*.js` math libs)                 |
| [Greek Builder TDD — Appendix A](docs/tdd/greek-builder.md#appendix-a-math-reference) | Mathematical reference (Breeden-Litzenberger, SABR, edge-to-Greeks, LP)                                                  |

## CLI commands

```bash
npm start                  # server + supervisor + dev GUI (concurrently)
npm run server             # server only
npm run supervisor         # supervisor only (signal orchestration)
npm run dev                # GUI dev server only
npm run test               # vitest (754 tests)
npm run typecheck          # tsc --noEmit
npm run lint               # eslint
npm run check              # typecheck + lint + test
npm run build              # production frontend build

# Data collection
npm run collect -- --symbol SPY --from 2024-01-02 --to 2024-12-31
npm run snapshot -- --symbols CL,ES
npm run schwab-auth         # OAuth flow for Schwab access tokens

# Backtesting
npm run backtest -- --symbol SPY --from 2025-01-02 --to 2025-06-30
npm run backtest -- --symbol SPY --from 2025-01-02 --to 2025-06-30 --models vol-forecast-spy-1d --full

# Modeling
npm run scan               # scan tickers for backtest candidates

# Analysis (server-side scripts)
tsx scripts/signal-health.ts --window 60
```

## Tech stack

- **Runtime:** Node.js 20+ (TypeScript, ESM, strict mode + `noUncheckedIndexedAccess`)
- **Messaging:** NATS JetStream
- **Storage:** DuckDB + Parquet
- **Frontend:** React 18 + Vite, Zustand for ephemeral UI state, lightweight-charts + Plotly for charting
- **Fonts:** IBM Plex Sans/Mono via `@fontsource` (OFL, self-hosted)
- **Testing:** Vitest (754 tests across 70 files; React Testing Library for the UI primitives)

## Conventions

See [CLAUDE.md](CLAUDE.md) for the canonical agent guidelines (TypeScript-only, pre-commit framework, error handling, file organization). Key rules:

- Zero `.jsx` files. New React code is `.tsx` with a typed `Props` interface.
- Pre-commit enforces ESLint + Prettier + `tsc --noEmit` + hygiene checks.
- No frameworks for the HTTP server — hand-rolled `node:http` pattern.
- Strategies live in `src/lib/strategies/`. The same code runs in backtest and live mode.
- Risk limits are version-controlled (`config/risk_limits.yaml`); operator edits via the GUI become reviewable diffs.

## License

Magpie is released under the [MIT License](LICENSE).

The optional Python research workspace under `research/` depends on
[NautilusTrader](https://github.com/nautechsystems/nautilus_trader) (LGPL-3.0-or-later)
as an unmodified, separately-installed dependency. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for details. The TypeScript
framework and the Rust `core/` crates have no LGPL dependency.
