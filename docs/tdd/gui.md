# Control Plane / GUI — Component TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md)
Design source: canonical tokens + primitives live in `src/styles/` and `src/components/ui/`.

---

## Overview

The GUI is the operator surface for the trading system, served from the same Node process as the API. It is a dense, professional **operations control plane** organized as **dock-able panels** arranged into named **workspaces**. The visual style is "Engineered" — near-black neutral-cool canvas, IBM Plex Sans/Mono, hairline 1px rules, 2px corner radii, tabular numerics, color-as-signal (green/red/cyan/amber, never decoration).

### Workspace inventory

The shell renders five workspaces. Each is a CSS-Grid layout of panels resolved through a static `PANEL_REGISTRY`:

| Workspace     | Subtitle                                                                | Layout                                     |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| `operate`     | Daily-driver. Risk · Positions · P&L · Reconciliation                   | 4-cell grid                                |
| `investigate` | Post-hoc analysis. Trade Inspector · Recent fills · Active orders       | 3-cell grid                                |
| `build`       | Manual staging. Chain (with Greek Builder) · Payoff · Positions context | 3-cell grid                                |
| `strategies`  | Registry · lifecycle · operator notes · live submissions · drift        | full screen (registry + 380px detail rail) |
| `settings`    | Risk · Data · Models · System · Activity                                | full screen (220px left nav + content)     |

Workspace definitions are pure data — see [src/workspaces/index.ts](../../src/workspaces/index.ts). Panels are looked up by id in [src/panels/registry.tsx](../../src/panels/registry.tsx).

#### Drag-resize + layout persistence (QF-346)

Panel boundaries inside a grid workspace are draggable. [src/shell/WorkspaceGrid.tsx](../../src/shell/WorkspaceGrid.tsx) overlays a thin handle on each internal grid line (`col-resize` / `row-resize`); a drag shifts pixel size between the two adjacent tracks, clamped so neither falls below `MIN_TRACK_PX` (80px). The drag math is pure and unit-tested in [src/shell/panel-resize.ts](../../src/shell/panel-resize.ts) — only the `gridTemplateRows` / `gridTemplateColumns` track sizes are operator-editable; the template `areas` + panel→cell mapping never change, so an override stays forward-compatible (a track-count mismatch after a workspace reshape falls back to the static template).

On drag release the new track strings are persisted server-side via `PUT /api/gui/layouts/<workspace>`, backed by [server/gui/workspace-layout.ts](../../server/gui/workspace-layout.ts) (`data/workspace-layouts.json`, atomic write-then-rename, single-operator — matching the rest of the system's actor model). Each write fires a `workspace_layout` WebSocket push so a second connected device (laptop alongside desktop) re-flows its grid live, and the initial snapshot carries `workspace_layouts` so a fresh page load starts from the persisted sizes — multi-device sync without a reload.

**Migration path.** A browser still holding a legacy `qf-layout` localStorage entry seeds the server once on first load (per-workspace, only when the server has no override yet) and then drops the local copy, so the server becomes the single source of truth.

### Persistent shell chrome

- **Header (44px)** — `Magpie · v0.42.1 · alpha` brand, env pills (`app_env` / `trading_mode`), command palette button (⌘K), theme cycler.
- **Halted-strategy banner** — appears when one or more strategies are in lifecycle state `halted` (per [order-execution.md §5.3](order-execution.md#53-per-strategy-operator-halt-block-new-submissions)). Lists which strategies, why, with a `Resume` button per strategy. No global "system halted" banner — halts are always per-strategy now.
- **Reconnecting banner** — amber pill above the canvas. While reconnecting, all live numerics dim to `--text-3` and the panels render `.stale` (italic, 55% opacity).
- **Workspace tabs (32px)** — five tabs, active one underlined with `--accent`. Numbered prefix (1–5); `[` / `]` shortcuts cycle.
- **Status bar (24px)** — connection state (`LIVE` / `Reconnecting…` / `Disconnected`), feed lag (placeholder), open-order count.

Three themes selected via `<body data-theme="...">`:

- `dark` (Engineered Dark, default)
- `dark-hc` (Higher-Contrast Dark — brighter text tiers + saturated accent)
- `light` (Engineered Light)

Themes are persisted in the Zustand UI store (localStorage key `qf-ui`). All chart libs (lightweight-charts, Plotly) read theme tokens from `getComputedStyle(document.body)` so a switch propagates without a reload.

---

### 1. Real-time updates

One WebSocket endpoint:

```
ws://<host>:<port>/ws/state     — system + portfolio + strategy state, snapshot + deltas
```

#### `/ws/state` — initial snapshot

```json
{
  "type": "snapshot",
  "system": {
    "app_env": "dev",
    "trading_mode": "paper",
    "nats_connected": true,
    "sources_available": ["schwab", "ibkr", "marketdata"],
    "schwab_token": { "available": true, "refresh_token_expires_in_s": 547800 }
  },
  "portfolios": { "main": { /* full PortfolioState including positions */ } },
  "orders": { "recent": [...] },          // OPL working + recently-terminal orders
  "fills": { "recent": [] },
  "strategies": [...],                    // Lifecycle registry — see server/strategy/lifecycle.ts
  "risk_limits": {                        // YAML-backed — see portfolio-risk-engine.md
    "version": 1,
    "portfolios": {
      "main": { "max_net_delta": 50, "max_net_vega": 100, ... }
    }
  },
  "workspace_layouts": {                   // QF-346 — drag-resized panel track sizes
    "version": 1,
    "layouts": {
      "operate": { "rows": "260px 1fr 160px", "cols": "300px 1fr 1fr 400px" }
    }
  }
}
```

Two environment-identifying fields surface in the header pills:

- **`app_env`** — deployment environment (dev/staging/prod).
- **`trading_mode`** — paper vs. live, derived from the broker bundle's `BROKER_ENV` at startup. Paper-credentialed bundles render `PAPER`; live-credentialed render `LIVE` (red).

Paper vs live is a deploy-target distinction handled by the broker bundle's credentials (see [strategy-deployment-topology.md](strategy-deployment-topology.md)); it is not a per-portfolio toggle.

#### Delta messages

```json
{"type": "portfolio_update", "portfolio": "main", "data": { /* Partial<PortfolioState>, incl. positions[] — see QF-350 surface below */ }}
{"type": "order_update", "data": { /* Order */ }}            // OPL-tracked orders
{"type": "fill", "data": { /* Fill */ }}                     // accumulates into fills.recent (cap 50); OPL fills + audit-observer fills from NT-native chains
{"type": "strategy_halt", "strategy_id": "soxx_rotation", "halted": true, "reason": "hard_drift"}
{"type": "position_exit_rule", "data": { "position_id": "pos-...", "rule": "stop_loss", "closing_intent_id": "..." }} // per-trip event; drives the in-flight closing banner
{"type": "alert", "data": { "type": "warn", "message": "..." }}
{"type": "strategy_update", "data": { /* full Strategy, incl. exit_rules[] headroom — see QF-350 surface below */ }} // patches strategies[] in place by id
{"type": "risk_limits", "data": { /* RiskLimitsConfig */ }}  // emitted when limits are saved via PUT
{"type": "workspace_layout", "data": { /* WorkspaceLayoutsConfig */ }} // QF-346 — emitted on layout save; syncs other devices
```

The reducer is pure ([applyMessage](../../src/state/StateProvider.tsx) — exported for tests):

```ts
applyMessage(prev: SystemState | null, msg: WsMessage): SystemState | null
```

#### Reconnection

On disconnect (server restart, network blip, idle timeout):

1. **Stale-state mode** — GUI marks live state as stale (the `ws-shell` element gets `.stale`) and shows the Reconnecting banner. Panels stay rendered but dimmed.
2. **Exponential backoff** — 1s, 2s, 4s, 8s, 16s, capped at 30s.
3. **Snapshot on reconnect** — server sends a fresh snapshot; reducer replaces the entire state. No diff merging across gaps.
4. **No gap recovery** — events missed during disconnect are not replayed. The audit tables (Investigate workspace) cover historical lookup if needed.

The endpoint is wrapped by [src/state/StateProvider.tsx](../../src/state/StateProvider.tsx).

#### Position + exit-rule state surface (QF-350)

The per-strategy exit-rule panel ([exit-rule-monitor.md §8](exit-rule-monitor.md#8-gui-surfacing)) and the operator Liquidate flow (§2) both depend on state the `/ws/state` stream must carry. The contract is implied above but historically under-delivered (the server pushed `positions_count` only, and the exit-rule monitor's evaluations were never wired to a push). QF-350 nails it down:

- **`portfolio_update.data.positions[]`** — the full `Position[]` rows, not just `positions_count`. This is the source for the per-strategy position view and the Liquidate target (§2.1/§2.2). `Partial<PortfolioState>` already admits the field; the server push must include it.
- **`strategy_update.data.exit_rules[]`** — per armed rule, the declared threshold + current value + headroom, derived from the exit-rule monitor's `ExitRuleEvaluation` (QF-321). Feeds the per-strategy panel's "closest to trip" display without client-side recompute:
  ```ts
  exit_rules?: {
    rule: "stop_loss" | "target" | "max_hold" | "max_drawdown";
    threshold: number;
    actual: number;
    headroom_pct: number; // ≤ 0 == tripped; mirrors ExitRuleEvaluation
  }[];
  ```
- **`position_exit_rule`** — the per-trip event (above); drives the in-flight closing banner so the operator can tell a rule-driven close from a manual one.
- **`alert` with `type: "exit_rule_tripped"`** — routed per [alerts.md](alerts.md) when a rule fires.
- **Trip history is not streamed.** The Investigate panel queries it from `audit_intents WHERE reason LIKE 'exit_rule_%'` — every exit-rule close persists `reason = exit_rule_<rule>` (manual liquidations use `reason = operator_manual`). No new store; no gap-recovery concern.

QF-350 specs this surface (design — this doc); QF-351 implements it (depends on the exit-rule monitor, QF-321) and unblocks the exit-rule GUI (QF-322) and the manual-liquidation GUI (QF-323).

---

### 2. Position exit controls

Replaces the prior system-wide kill switch (see [order-execution.md §5](order-execution.md#5-position-exit-controls)). There is no global "halt everything" button; closes are always either operator-selected positions, framework-enforced exit rules, or strategy-discretionary.

#### 2.1 Per-strategy position view + per-position exit

Each strategy's detail page renders a position list keyed by `position_id`. Each row carries a `Liquidate` button. Click → modal: "Liquidate `<position_id>` (`<strategy>` / `<symbol>` / qty `<n>`)? Type `LIQUIDATE` to confirm." `<TypedConfirmation safetyWord="LIQUIDATE">` input → button enables → `POST /api/positions/<position_id>/liquidate`. Server emits one closing `OrderIntent` with `reason="operator_manual"` and cancels any in-flight working orders on that position.

**Post-submit feedback.** On `POST /api/positions/<id>/liquidate` returning `200 {intent_id}`, the modal closes immediately and a **toast** fires: `Liquidation submitted (intent <intent_id>) — broker fill follows`. The strategy's position row gains a `closing` badge (state = `closing` per [portfolio-risk-engine.md §"Per-strategy composite positions"](portfolio-risk-engine.md#per-strategy-composite-positions--exit-rule-monitor)) and the order appears in the Investigate workspace's Active Orders panel as a fresh row in `submitted` state. When the broker fill lands, the toast is replaced by a quieter `Position closed (<symbol>)` confirmation and the row drops out of the Active Orders panel. If the close intent reaches a failure state (`rejected_by_broker`, `submission_failed`, `cancel_unknown` for >30s), the toast escalates to an error variant and the Investigate row gains a red border with `halt_reason` / `broker_reason` rendered inline.

#### 2.2 Multi-select liquidation

Rows on the per-strategy position view (and the cross-strategy position list in the portfolio drawer) carry checkboxes. Operator selects N positions → toolbar shows `Liquidate selected (N)` → modal: "Liquidate `<N>` positions across `<M>` strategies (`<list>`)? Type `LIQUIDATE` to confirm." `<TypedConfirmation safetyWord="LIQUIDATE">` → `POST /api/positions/liquidate { position_ids: [...] }`. Server emits N closing intents in parallel, each `reason="operator_manual"`, cancelling any in-flight working orders on each selected position.

**Post-submit feedback.** The response payload is `{intent_ids: [...]}`. Modal closes; a single grouped toast fires: `<N> liquidations submitted` (click the toast → opens Investigate filtered to the new `intent_ids`). Each row in the Active Orders panel tracks independently. The toolbar's `Liquidate selected` button is disabled until selection changes again, preventing double-submit. If any of the N submissions returned a partial-failure status (e.g., one position was already closing and the server rejected its close intent with `409`), the toast surfaces both the success count and the failure count: `<N-K> liquidations submitted, <K> rejected — see Investigate`.

The phrase `LIQUIDATE` is fixed (not dynamic) so operators can act under stress. There is no "select all → liquidate" shortcut — operator must explicitly toggle the rows they want closed.

#### 2.3 Per-strategy halt (block new submissions)

Strategy detail page header has `Halt strategy` and `Resume strategy` buttons reflecting the lifecycle state ([`server/strategy/lifecycle.ts`](../../server/strategy/lifecycle.ts)). `Halt` flips the strategy to `halted`, which makes the gate evaluator reject new submissions with `reason: "strategy_halted"`. **Open positions are not touched** — the operator decides whether to liquidate via 2.1 / 2.2.

#### 2.4 Auto-triggered exits

The Portfolio & Risk engine's exit-rule monitor ([portfolio-risk-engine.md](portfolio-risk-engine.md)) fires closing intents when a strategy's declared `stop_loss` / `target` / `max_hold` / `max_drawdown` rule trips ([order-execution.md §5.1](order-execution.md#51-strategy-declared-exit-rules)). These closes appear in the GUI's order timeline with `reason="exit_rule_<name>"` — the operator did not initiate them but sees them land. A toast notification fires when an exit rule trips. No confirmation primitive — these were pre-authorised at registration / override-file activation time.

The `LIQUIDATE` typed-confirmation primitive is [src/components/ui/TypedConfirmation.tsx](../../src/components/ui/TypedConfirmation.tsx) (re-uses the same component that backs the Order Ticket `FIRE` gate). Case-sensitive exact match — no trimming, no normalization. Unit-tested.

---

### 3. Order Ticket flow + FIRE gate

The Order Ticket is a 380px right-edge drawer ([src/flows/OrderTicket.tsx](../../src/flows/OrderTicket.tsx)). It is the **sole producer of OPL operator manual intents**: every QF-originated trade enters the system through this drawer. It opens when any panel calls `useUI.getState().openOrderTicket(draft)` — Greek Builder, the Build workspace's Chain panel, and (operator-initiated) the Investigate workspace's Positions panel are the staged producers.

Draft shape ([src/state/ui-store.ts](../../src/state/ui-store.ts)):

```ts
interface OrderTicketDraft {
  symbol: string;
  direction: "Long" | "Short" | "close";
  quantity: number;
  reason?: string; // free-text; operator's note, persisted to audit_intents
  exec_algorithm_id?: string; // e.g., "multi_leg_atomic"; default = NT pass-through
  legs?: OrderTicketLeg[]; // multi-leg breakdown (Greek Builder)
  totals?: OrderTicketTotals; // Δ/Γ/Θ/ν/cost/margin
}
```

Operator manual entries have no strategy context — the OrderIntent schema in [order-execution.md §1](order-execution.md#1-orderintent-schema-opl-only) is the canonical wire contract.

Submit gating depends on the broker bundle's `BROKER_ENV`:

- **`BROKER_ENV=paper`** — `Submit order` enabled immediately. The bundle is connected to a paper-credentialed account; no FIRE gate.
- **`BROKER_ENV=live`** — `Submit order` disabled until the operator types `FIRE` into the `<TypedConfirmation safetyWord="FIRE">` input. Case-sensitive exact match.

The system reports `trading_mode` (`paper` / `live`) on `/ws/state.system.trading_mode` derived from `BROKER_ENV`; the drawer reads from `useSystemState()` and chooses the gate path on render. The drawer also surfaces the bundle's broker name in the header bar so operators don't conflate paper/live across a multi-broker deploy.

Submit posts the draft to `POST /api/orders` (OPL's manual-entry ingest endpoint, per [order-execution.md §1](order-execution.md#1-orderintent-schema-opl-only)). The endpoint returns the assigned `intent_id`; the drawer closes on success and the new order appears in the `ActiveOrders` panel via `/ws/state` push.

---

### 4. Greek Builder

Lives inside `ChainPicker` ([src/components/ChainPicker.tsx](../../src/components/ChainPicker.tsx)), which the Build workspace renders via [ChainPanel](../../src/panels/ChainPanel.tsx). Four mode presets (Long Vega / Long Γ / Short Vega / Δ-Flat), per-Greek MAX/FLAT/MIN buttons, max-budget + max-legs inputs. Symbol is driven by the ChainPicker's symbol input — no hard-coded underlying.

Stage flow:

1. `expirations(symbol)` → pick nearest 30–45 DTE.
2. `chain(symbol, exp, 30)` → 30 strikes around spot.
3. Spawn the existing `greek-builder-worker` Web Worker with `{chain, options}`.
4. Worker calls `solveGreekBuilder` from [src/lib/lp-optimizer.js](../../src/lib/lp-optimizer.js).
5. On feasible result, stage legs back into ChainPicker (which the operator submits via the standard Order Ticket flow).

Math + LP details: [greek-builder.md](greek-builder.md).

---

### 5. Workspace detail

#### Operate

| Cell area | Panel                                                         | Data source                                              |
| --------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `risk`    | [RiskHeadroomPanel](../../src/panels/RiskHeadroomPanel.tsx)   | `useRiskLimits()` + `usePortfolio("main")`               |
| `pos`     | [PositionsPanel](../../src/panels/PositionsPanel.tsx)         | `usePortfolio("main").positions`                         |
| `pnl`     | [PnlMicrochartPanel](../../src/panels/PnlMicrochartPanel.tsx) | `getPortfolioSnapshots("main")` (today, intraday filter) |
| `recon`   | [ReconPanel](../../src/panels/ReconPanel.tsx)                 | `usePortfolio("main").data_stale` + positions count      |

The P&L sparkline is rendered via `lightweight-charts` (area series, color follows P&L sign through `color-mix()`).

Operators inspect what's happening live via the Strategies workspace (per-strategy submissions + drift) and the Investigate workspace (active orders, recent fills, audit inspector).

#### Investigate

| Cell area   | Panel                                                       | Data source                          |
| ----------- | ----------------------------------------------------------- | ------------------------------------ |
| `inspector` | [InspectorPanel](../../src/panels/InspectorPanel.tsx)       | `inspectTrades({...})` joined audit  |
| `fills`     | [RecentFillsPanel](../../src/panels/RecentFillsPanel.tsx)   | `useRecentFills()`                   |
| `orders`    | [ActiveOrdersPanel](../../src/panels/ActiveOrdersPanel.tsx) | `useOrders().recent` filtered active |

InspectorPanel renders each `/api/trades/inspect` row as a 3-stage card (Intent → Order → Fill). The `source` discriminator (`qf` / `qf-gated` / `nt-native`) shows as a coloured pill on the Intent stage; the `parent_order_id` chain (ExecAlgorithm parent → child orders) renders as a nested expand under the Order stage. Missing stages render dimmed so the chain shape stays consistent across partial joins.

**Rendering rejection reasons.** When an `audit_orders` row carries any of `risk_violations` / `halt_reason` / `broker_reason` (per [cross-cutting.md §5](cross-cutting.md#5-database-schema-consolidated) — exactly one is populated on a rejection row), the Order-stage card renders the populated field inline with the matching label:

- `risk_violations` → red banner: `Risk rejected — <limit> exceeded` with the full Violation JSON in an expandable detail.
- `halt_reason` → orange banner: `Halted — <strategy_halted | portfolio_halted | recon_drift>` plus a deep-link to the relevant strategy / portfolio detail page.
- `broker_reason` → red banner: `Broker rejected — <broker_reason>` (raw broker code, e.g. `INSUFFICIENT_MARGIN`, `MARKET_CLOSED`).

ActiveOrdersPanel uses the same banner treatment but compressed: a single-line red row with the broker / halt reason text directly in the row, no expandable detail. This is the operator's first surface for `rejected_by_broker` orders flowing through normal operation — no need to navigate to Investigate to see _why_ a broker rejected.

**`cancel_unknown` rendering.** Orders in `cancel_unknown` state (per [order-execution.md §3 Cancel-order failure modes](order-execution.md#cancel-order-failure-modes)) render with a spinning amber indicator + tooltip: `Cancel sent; broker view pending`. After 30s, the row escalates to a red banner: `Cancel timed out — broker view still unknown. <Investigate>`. The Investigate link opens the InspectorPanel filtered to this `order_id` for deeper inspection.

#### Build

| Cell area | Panel                                                                                     | Data source                                                                  |
| --------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `chain`   | [ChainPanel](../../src/panels/ChainPanel.tsx) wraps `ChainPicker`                         | `/api/chain`, `/api/expirations`; Greek Builder UI is embedded here (see §4) |
| `payoff`  | [PayoffPanel](../../src/panels/PayoffPanel.tsx) wraps `PayoffDiag`                        | `usePortfolio("main").positions`                                             |
| `pos2`    | [PositionsPanel](../../src/panels/PositionsPanel.tsx) (reused via `pos-context` panel id) | same as Operate                                                              |

`ChainPicker` is a 1.6kloc `.tsx` component wrapped in Magpie chrome. It owns its own state machine for chain loading, position staging, and bulk loads.

#### Strategies

Full-screen layout: registry table on the left, 380px detail rail on the right. Canonical reference for lifecycle behavior is `server/strategy/lifecycle.ts` plus the [strategy-deployment-topology.md](strategy-deployment-topology.md) treatment of "running" semantics. Action buttons in the detail rail are sourced from a single `ACTIONS_BY_STATE` table that mirrors the server-side `LIFECYCLE_TRANSITIONS` table — single source of truth.

The detail rail surfaces per-strategy telemetry: recent gate decisions (approved / rejected with reason, joined from `audit_intents` where `source='qf-gated'` and `strategy_id` matches), drift status (z-scores per metric vs. the pinned QO baseline per [portfolio-risk-engine.md](portfolio-risk-engine.md#strategy-drift-monitoring-design-intent)), and the standard registry fields (lifecycle state, operator notes, transition history, `params_provenance`).

#### Settings

220px left-rail navigator over five groups (Risk · Data · Models · System · Activity).

| Section                   | Status    | Surface                                                                                                               |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| Risk → Limits             | **wired** | [RiskLimitsScreen](../../src/screens/RiskLimitsScreen.tsx) — read/write `config/risk_limits.yaml`                     |
| Risk → Policies           | **wired** | [RiskPoliciesScreen](../../src/screens/RiskPoliciesScreen.tsx) — policy editor (`server/risk/policies.ts`)            |
| Risk → Emergency          | **wired** | [EmergencyScreen](../../src/screens/EmergencyScreen.tsx) — halt switch UI                                             |
| Data → Brokers            | **wired** | [BrokersScreen](../../src/screens/BrokersScreen.tsx) — read-only adapter cards                                        |
| Data → Catalog            | **wired** | [DataCatalogTab](../../src/components/DataCatalogTab.tsx) — `/api/catalog` browser                                    |
| Data → Fundamentals       | **wired** | [FundamentalsScreen](../../src/screens/FundamentalsScreen.tsx) — FMP backfill status                                  |
| Data → Market data health | **wired** | [MarketDataHealthScreen](../../src/screens/MarketDataHealthScreen.tsx)                                                |
| Data → Exports            | **wired** | [ExportsScreen](../../src/screens/ExportsScreen.tsx) — Parquet exports                                                |
| Models → Backtests        | **wired** | [BacktestsTab](../../src/components/BacktestsTab.tsx) — quant-optimizer qo-run catalog + drill-down (see Backtests §) |
| Models → Strategies       | **wired** | [StrategiesConfigScreen](../../src/screens/StrategiesConfigScreen.tsx) — per-strategy params                          |
| System → Environments     | **wired** | [EnvironmentsScreen](../../src/screens/EnvironmentsScreen.tsx) — env var inspector                                    |
| System → Secrets          | **wired** | [SecretsScreen](../../src/screens/SecretsScreen.tsx) — `/api/secrets/status`                                          |
| System → Jobs             | **wired** | [JobsScreen](../../src/screens/JobsScreen.tsx) — write-jobs queue inspector                                           |
| System → Alerts           | **wired** | [AlertsScreen](../../src/screens/AlertsScreen.tsx) — rules editor + recent alerts                                     |
| Activity → Audit          | **wired** | [AuditLogScreen](../../src/screens/AuditLogScreen.tsx) — joined `/api/trades/inspect` rows                            |
| Shell                     | **wired** | [SettingsShell](../../src/screens/SettingsShell.tsx) — left-rail navigator that frames all sub-screens above          |

##### Settings → Models → Backtests

Browses quant-optimizer sweep results. Reads `kind: "qo-run"` rows from `/api/catalog` (emitted by [server/catalog/collectors/qo-runs.ts](../../server/catalog/collectors/qo-runs.ts)) and per-run JSON from `/api/qo-run/:id`. Schema and lineage semantics (`WfoSpec`, qo-run descriptors, `lineage_id`) are owned by the `quant-optimizer` repo; this section only describes operator-visible surfaces. QF does not initiate backtests — this tab is a viewer of archives QO writes to the shared MinIO data lake.

- **List + per-run drill-down** — sortable table (strategy, IS/OOS windows, #folds, best OOS metric, last_updated). Clicking a row fetches `/api/qo-run/:id` and renders the per-fold table (best params, n_trials, OOS metric panel: n_trades / net_pnl / sortino / hit_rate / max_dd). JSON is canonical; no Optuna SQLite reads.
- **Walk-forward chart + comparison view** — per-fold IS-vs-OOS metric across windows for one run; up to three runs side-by-side for comparison ([WfChart](../../src/components/WfChart.tsx)). Metric selector toggles `net_pnl` / `sortino` / `hit_rate` / `max_dd`. Mismatched metric types across runs degrade gracefully (separate y-axes or warning).
- **Grid result heatmap** — [RunHeatmap](../../src/components/RunHeatmap.tsx) renders one row per run × one column per fold_id, cells coloured by the selected OOS metric. Single-run view (in detail) shows a fold-stability strip; comparison view (multi-run) adds a row per checked run for cross-sweep variance at a glance. Colour is relative to visible cells (red→slate→green), with per-metric direction (`net_pnl`/`sortino` higher-better around 0; `hit_rate` centered on 0.5; `max_dd` lower-better).

Lineage from a deployed strategy back to the validating qo-run is the `params_provenance` badge on the `Strategy` record.

---

### 6. Command palette (⌘K)

[src/components/ui/CommandPalette.tsx](../../src/components/ui/CommandPalette.tsx). Top-anchored modal, 580px wide, 110px from top of viewport. Search input at top, results below grouped by `kind` (Workspace, Action, …). Active item is `--bg-elev`.

Keyboard:

- `↑` / `↓` — navigate
- `⏎` — run active item
- `Esc` — close

Item registry today (see [Shell.tsx](../../src/shell/Shell.tsx)):

- All five workspaces (kind: Workspace)
- Three theme switchers (kind: Action)
- New Order Ticket (kind: Action, opens an empty draft)
- Liquidate selected positions (kind: Action, focuses the current position list and opens the LIQUIDATE confirm; disabled when no positions are selected)

Items are recomputed on every render — adding a new command means adding to the array.

---

### 7. State management

The shell uses two independent stores:

1. **`StateContext`** ([src/state/StateProvider.tsx](../../src/state/StateProvider.tsx)) — server state from `/ws/state`. Pure `applyMessage` reducer. Hooks: `useSystemState()`, `usePortfolio(id)`, `useOrders()`, `useRecentFills()`, `useStrategies()`, `useRiskLimits()`, `useConnectionStatus()`. `StateContext` is exported so tests can wrap consumers without spinning up a WebSocket.

2. **`useUI`** Zustand store ([src/state/ui-store.ts](../../src/state/ui-store.ts)) — ephemeral UI state: `workspace`, `theme`, `paletteOpen`, `selectedPositionIds`, `orderTicket`. Persisted to localStorage via Zustand's `persist` middleware (key `qf-ui`); `partialize` keeps only `workspace` + `theme` across reloads (selection state intentionally resets per session).

Don't double-buffer the WS feed through Zustand — the WS reducer is canonical.

---

### 8. API endpoints used by the GUI

| Endpoint                                       | Method   | Used by                                                                                              |
| ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `/api/positions/:id/liquidate`                 | POST     | Per-position Liquidate button (§2.1)                                                                 |
| `/api/positions/liquidate`                     | POST     | Multi-select Liquidate (§2.2); body: `{ position_ids: string[] }`                                    |
| `/api/strategies/:id/halt`                     | POST     | Strategy detail Halt button (§2.3)                                                                   |
| `/api/strategies/:id/resume`                   | POST     | Strategy detail Resume button (§2.3)                                                                 |
| `/api/portfolio/:id/snapshots`                 | GET      | P&L sparkline                                                                                        |
| `/api/orders`                                  | POST     | OrderTicket submit                                                                                   |
| `/api/orders/:id/cancel`                       | POST     | Active Orders panel cancel button                                                                    |
| `/api/trades/inspect`                          | GET      | Inspector panel, Audit log screen                                                                    |
| `/api/gate/decisions`                          | GET      | Strategies detail rail recent-decisions list (joined from `audit_intents` where `source='qf-gated'`) |
| `/api/strategies`                              | GET/POST | Strategies registry table, Register modal                                                            |
| `/api/strategies/:id/transition`               | POST     | Detail rail action buttons                                                                           |
| `/api/strategies/:id/notes`                    | PUT      | Detail rail notes editor                                                                             |
| `/api/strategies/:id/drift`                    | GET      | Detail rail drift panel (z-scores vs. pinned QO baseline)                                            |
| `/api/risk/limits`                             | GET      | (snapshot already includes; reserved)                                                                |
| `/api/risk/limits/:portfolio`                  | PUT      | Risk Limits screen Save                                                                              |
| `/api/gui/layouts`                             | GET      | (snapshot already includes; reserved)                                                                |
| `/api/gui/layouts/:workspace`                  | PUT      | WorkspaceGrid drag-resize save (QF-346)                                                              |
| `/api/quote`, `/api/chain`, `/api/expirations` | GET      | ChainPanel (via ChainPicker), GreekBuilder                                                           |
| `/api/catalog`                                 | GET      | DataCatalog (mounted under Settings → Data → Catalog), BacktestsTab (filtered to `kind: "qo-run"`)   |
| `/api/qo-run/:id`                              | GET      | BacktestsTab per-run drill-down — parsed `wfo_results` JSON                                          |
| `/ws/state`                                    | WS       | StateProvider                                                                                        |

---

### 9. Auth posture

Bearer-token auth is enforced on every API call + WebSocket upgrade per [cross-cutting.md §1](cross-cutting.md). The GUI's job is to acquire the token at first load, attach it to every subsequent request, and gracefully handle scope-rejection.

**Token acquisition.** First page load with no token in sessionStorage → token-input form (reuses the existing `WriteJobTokenInput` primitive currently on `JobsScreen`, generalized to a shared `<TokenInput>` component). Operator pastes the token they captured from `npm run issue-token` (the issuance flow lives at [cross-cutting.md §1.5](cross-cutting.md)). Once set, the token persists in `sessionStorage` under key `qf-token` and is sent on every subsequent request. Browser tab close clears it — the operator re-pastes per browser session.

**HTTP calls.** `src/lib/api.ts` reads `sessionStorage.qf-token` and sets `Authorization: Bearer <plaintext>` on every fetch. A `401` response clears the token and re-prompts; a `403` surfaces an inline "missing scope: `<scope>`" message without clearing.

**WebSocket upgrade.** Two-step exchange per [cross-cutting.md §1.3](cross-cutting.md#13-websocket-auth--one-shot-ticket-exchange) — the bearer never lands in the WS URL. (1) `POST /api/ws/ticket` with the bearer in `Authorization`, receive `{ticket, expires_at}`. (2) Open `/ws/state?ticket=<plaintext-ticket>`; the server consumes the ticket on upgrade and attaches the original token's scopes. The reducer's connection state moves to `auth_failed` on close codes `4400` (invalid / consumed / expired ticket) or `4401` / `4403` (any underlying scope issue) and surfaces the same banner UI as the token-input form so the operator can re-paste or re-issue. The ticket fetch + retry is encapsulated in `src/state/StateProvider.tsx` — application code doesn't see it.

**Scope-aware UI.** The token's `scopes` are returned by `GET /api/whoami` on first load and cached in `useUI`. Action buttons that require a scope the operator's token lacks render disabled with a "requires `<scope>`" tooltip rather than hiding entirely — operators with read-only tokens still see the full UI shape and know what they can't do. Friction-confirm primitives (`LIQUIDATE`, `FIRE`) are unaffected: they still gate intent regardless of scope.

---

### 10. Files

#### Shell + state

```
src/App.tsx                      — entry; <StateProvider><Shell/></StateProvider>
src/main.tsx                     — Vite mount + tokens.css + ui.css + Plex fonts
src/shell/Shell.tsx              — header / tabs / status bar / liquidation modal / palette / theme
src/shell/WorkspaceGrid.tsx      — CSS-Grid renderer + drag-resize handles (QF-346)
src/shell/panel-resize.ts        — pure track-resize math + legacy localStorage migration (QF-346)
src/state/StateProvider.tsx      — /ws/state wrapper, exported applyMessage reducer + hooks
src/state/ui-store.ts            — Zustand UI store (workspace, theme, palette, ticket)
src/styles/tokens.css            — Engineered tokens, three [data-theme] variants
src/styles/ui.css                — recurring class set (panel, table, kbd, env-pill, halt-banner)
src/types/strategy.ts            — frontend mirror of server/strategy/lifecycle.ts
src/types/ws.ts                  — SystemState + WsMessage discriminated union
```

#### Workspaces + panels

```
src/workspaces/index.ts          — five WorkspaceDef entries (operate/investigate/build/strategies/settings)
src/workspaces/types.ts          — WorkspaceDef / WorkspaceTemplate / WorkspaceCell
src/panels/registry.tsx          — PanelId union + PANEL_REGISTRY map
src/panels/RiskHeadroomPanel.tsx
src/panels/PositionsPanel.tsx
src/panels/PnlMicrochartPanel.tsx
src/panels/ReconPanel.tsx
src/panels/InspectorPanel.tsx
src/panels/RecentFillsPanel.tsx
src/panels/ActiveOrdersPanel.tsx
src/panels/ChainPanel.tsx        — wraps src/components/ChainPicker.tsx (Greek Builder UI is embedded inside ChainPicker; see §4)
src/panels/PayoffPanel.tsx       — wraps src/components/PayoffDiag.tsx
src/panels/ComingSoonPanel.tsx   — fallback for not-yet-wired panel ids
```

#### Screens (full-page workspaces)

```
src/screens/StrategiesScreen.tsx — Strategies workspace
src/screens/SettingsShell.tsx    — Settings workspace left-nav + content router
src/screens/RiskLimitsScreen.tsx
src/screens/BrokersScreen.tsx
src/screens/AuditLogScreen.tsx
```

#### Flows (overlays)

```
src/flows/OrderTicket.tsx        — 380px right drawer, FIRE gate (conditional on BROKER_ENV)
```

#### Primitives

```
src/components/ui/Panel.tsx
src/components/ui/Modal.tsx
src/components/ui/Drawer.tsx
src/components/ui/CommandPalette.tsx
src/components/ui/TypedConfirmation.tsx
src/components/ui/EnvPill.tsx
src/components/ui/Icon.tsx
src/components/ui/Kbd.tsx
src/components/ui/index.ts
```

#### Server-side WebSocket bridge

- `server/ws-state.ts` — `/ws/state` snapshot + delta push. Push methods: `pushPortfolioUpdate`, `pushOrderUpdate`, `pushFill`, `pushSystemHalt`, `pushAlert`, `pushStrategyUpdate`, `pushRiskLimits`, `pushWorkspaceLayouts`.
- `server/gui/workspace-layout.ts` — `WorkspaceLayoutStore` (data/workspace-layouts.json); drives `GET/PUT /api/gui/layouts` and the `workspace_layout` push (QF-346).

---

### 11. Tests

React component tests are minimal — the focus is the state plumbing and the safety primitives:

- [src/state/StateProvider.test.tsx](../../src/state/StateProvider.test.tsx) — `applyMessage` covers snapshot replace, portfolio merge, halt flip, order_update prepend + cap.
- [src/components/ui/TypedConfirmation.test.tsx](../../src/components/ui/TypedConfirmation.test.tsx) — case-sensitive exact match for FIRE/LIQUIDATE.
- [src/shell/WorkspaceGrid.test.tsx](../../src/shell/WorkspaceGrid.test.tsx) — cell counts, grid-template-areas applied, no-template fallback, resize-handle count per boundary.
- [src/shell/panel-resize.test.ts](../../src/shell/panel-resize.test.ts) — track parse/resolve/resize math (clamping, stale-override fallback) + legacy localStorage migration.
- [server/gui/**tests**/unit/workspace-layout.test.ts](../../server/gui/__tests__/unit/workspace-layout.test.ts) — store load/persist/onChange + validation.

Server-side strategy lifecycle and risk limits stores have full unit coverage:

- [server/strategy/**tests**/unit/lifecycle.test.ts](../../server/strategy/__tests__/unit/lifecycle.test.ts) — 11 tests
- [server/risk/**tests**/unit/limits.test.ts](../../server/risk/__tests__/unit/limits.test.ts) — 6 tests

A Playwright smoke suite for the LIQUIDATE / FIRE gates / palette switching / WS reconnect is a v2 follow-up.

---

### 11.5 Observability

The detailed framework lives in [observability.md](observability.md). The GUI has two observability halves with different mechanisms — the browser-side React app and the server-side WebSocket bridge.

**Browser-side.** The React app does not feed the central JSON log stream (same constraint as the [Greek Builder worker](greek-builder.md#6-observability) — no server-side logger in the browser). Operator-facing signal comes through the UI itself: the Alerts banner consumer ([alerts.md §9](alerts.md#9-currently-shipped-rules)), the WS reconnection indicator (§1 Reconnection), and the per-strategy `gate_degraded` / halt badges ([risk-gate-architecture.md §4.3](risk-gate-architecture.md#43-observability-of-degraded-mode)). Wiring browser telemetry to the central stream needs a client-side telemetry endpoint, deferred identically to the Greek Builder's — see [greek-builder.md §6](greek-builder.md#6-observability).

**Server-side WS bridge.** `server/ws-state.ts` runs in the QF server process and emits through the shared logger with `service = "ws-state"`. Outbound `POST /api/*` mutations that the GUI triggers are logged by their owning endpoint ([§8 API endpoints](#8-api-endpoints-used-by-the-gui)) under that endpoint's `service`, carrying the `X-Correlation-Id` the GUI sends; the WS upgrade carries the ID as a query param per [observability.md §4.2](observability.md#42-across-process-propagation).

| Event                     | Level   | Payload (key fields)                  | Emitted when                                                                                          |
| ------------------------- | ------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ws.client_connected`     | `debug` | `clients`                             | A `/ws/state` client connects (`server/ws-state.ts`); `clients` is the live count.                  |
| `ws.client_disconnected`  | `debug` | `clients`                             | A `/ws/state` client disconnects.                                                                    |
| `ws.snapshot_sent`        | `debug` | `client_id`, `bytes`                  | Initial `/ws/state` snapshot pushed to a newly-connected client (§1 `/ws/state` initial snapshot).  |
| `ws.delta_pushed`         | `debug` | `kind`, `client_count`               | A delta fan-out (`pushPortfolioUpdate` / `pushOrderUpdate` / `pushFill` / `pushSystemHalt` / `pushAlert` / `pushStrategyUpdate` / `pushRiskLimits`). `kind` names which push method fired. |

These are `debug`-level — the WS bridge is high-frequency and operationally interesting state changes are visible in the pushed payloads themselves, not in the fan-out logs. Per [observability.md §6.4](observability.md#64-sampling), connection-count and delta-rate live in metrics, not these logs.

**Implementation note.** `server/ws-state.ts` today emits the connect/disconnect pair; the snapshot/delta events above are the design target the push methods emit as the catalog fills in.

### 12. Deferred to v2

See [internal planning notes](../../../.claude/plans/magpie-v2.md) for the full list. Highlights:

- Pop-out windows (BroadcastChannel + window registry).
- Dynamic panel registry (runtime addition of new panel ids).
- Multi-account / multi-environment switcher.
- Mobile companion app (read-only).
- Onboarding / first-run flow.
- Symbol scanner panel.
- Server-side Order Ticket draft store.
- Role-based perms for FIRE/LIQUIDATE.
- Greek Builder multi-symbol picker.
- Strategy lifecycle: timeout auto-expiry, dedicated `audit_strategy_events` table.
