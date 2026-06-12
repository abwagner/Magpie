# Portfolio & Risk Engine — Component TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md)

---

## Overview

The Portfolio & Risk Engine maintains the live portfolio state (positions, cash, P&L) and evaluates risk limits continuously. It is the safety-critical core — every OrderIntent must pass its checks before reaching a broker. The engine is stateful: it holds the authoritative internal view of positions and recomputes risk on every state change (fill, market data update, signal).

It is **architecture-agnostic** — it holds positions / cash / Greeks / per-strategy halt state and exposes `canExecute()` as the risk gate for `OrderPlane.submit()`. Its producers are the Order Plane's three QF-side producers (operator manual entry, operator manual liquidation, strategy-declared exit rules tripped by the framework — see [order-execution.md §5](order-execution.md#5-position-exit-controls)) plus the risk gate ([risk-gate-architecture.md](risk-gate-architecture.md)).

**Code surface:**

- **Greek computation: `magpie-quant` Rust crate** — source of truth for `delta` / `gamma` / `theta` / `vega` / `iv` across BS, Black-76, SABR, vol-surface, BL extraction, and edge-greeks. Exposed via PyO3 to Python (consumed by per-broker NT bundles' quote enrichment + research workers) and via WASM to TS-browser code (Greek Builder web worker). The TS server itself does not call into it; positions arrive with Greeks already populated. See [§2 Greek computation runtime](#greek-computation-runtime).

---

### 1. Portfolio state

Each portfolio is an isolated namespace with its own positions, cash, and limits.

#### State shape

**Single canonical positions projector.** The portfolio state has exactly one position store — the per-instrument list below. Per-strategy "composite" positions (a strategy's bundle of instruments — e.g. a short straddle is two atomic positions; an iron condor is four) are not a separate store; they are SQL filters / aggregates over this canonical list. See [§2.5 Per-strategy composite positions](#per-strategy-composite-positions--exit-rule-monitor).

```js
{
  portfolio_id: "main",
  cash: 100000,                   // initial cash, updated on fills
  positions: [
    {
      position_id: "pos-abc123",
      strategy_id: "short-straddle-spy", // null for operator-originated positions
      symbol: "OPT:SPY:2026-05-16:C:500",  // canonical symbol
      underlying: "SPY",
      direction: "Short",
      quantity: 1,
      multiplier: 100,            // 100 for equity options, 1 for equities, contract-specific for futures
      entry_price: 12.50,
      entry_notional: 1250.00,    // |quantity| × entry_price × multiplier
      entry_ts: "2026-04-08T13:35:00Z",
      expiration: "2026-05-16",
      // Mark-to-market (updated on every market data tick):
      current_price: 11.80,
      unrealized_pnl: 70.00,      // (12.50 - 11.80) * 1 * 100, sign-aware on direction
      high_water_pnl: 85.00,      // running max of unrealized_pnl since open; drives trailing-stop logic
      // Greeks (updated on every market data tick):
      delta: -0.48,
      gamma: 0.02,
      theta: 0.15,
      vega: -0.32,
      iv: 0.22,
      // Lifecycle state from the strategy / exit-monitor's perspective:
      state: "open",              // 'open' | 'closing' | 'closed'
      closing_intent_id: null,    // set to the close intent's ULID when an exit closing-intent is in flight
    }
  ],
  // Aggregates (recomputed on every state change — fill, market data tick, manual):
  net_delta: -0.48,
  net_vega: -0.32,
  total_realized_pnl: 0,
  total_unrealized_pnl: 70.00,
  daily_realized_pnl: 0,         // resets at market open

  // Equity and drawdown (see computation below):
  equity: 100070.00,             // cash + sum(unrealized_pnl across all positions)
  peak_equity: 100070.00,        // intra-day high-water mark of equity
  drawdown: 0,                   // peak_equity - equity (always >= 0)

  // Risk state:
  halted: false,                  // true → block new submissions on this portfolio
  halt_reason: null,              // does NOT auto-close existing positions (per order-execution.md §5)
  data_stale: false,              // true if market data quality gate failed
}
```

**Equity and drawdown computation (explicit):**

`equity` = `cash` + sum of `unrealized_pnl` across all open positions. This is recomputed on every state change:

- **On fill:** cash changes (premium received/paid), positions change. Equity updates.
- **On market data tick:** positions are marked to market, `unrealized_pnl` changes. Equity updates.
- **On market open:** `daily_realized_pnl` resets to 0. `peak_equity` resets to current `equity` (new trading day, fresh high-water mark).

`peak_equity` = max(`peak_equity`, `equity`). Updated on every recompute. Tracks the intra-day high-water mark including unrealized P&L from market movement — not just fills.

`drawdown` = `peak_equity` - `equity`. Always >= 0. If `drawdown` exceeds the portfolio-level `max_drawdown` limit, the portfolio is **halted for new submissions** — `canExecute` rejects all subsequent intents on this portfolio until the operator resets. **Existing positions are not auto-closed**; per [order-execution.md §5](order-execution.md#5-position-exit-controls) the operator decides whether to liquidate via manual UI. This halt fires **including from market movement alone** — a position that moves against you intraday triggers the drawdown halt even with no new fills or strategy actions. This is the intended behavior: the drawdown halt is a circuit breaker for adverse market conditions that blocks new exposure; closing existing positions is a separate operator decision.

The per-strategy `max_drawdown_pct` declared on a strategy's exit policy ([order-execution.md §5.1](order-execution.md#51-strategy-declared-exit-rules)) is a different lever — it auto-closes positions belonging to ONE strategy when that strategy's drawdown breaches its declared threshold.

#### Persistence: audit_fills replay

Portfolio state is **derived, not stored independently**. The canonical source for fills is the `audit_fills` DuckDB table ([cross-cutting.md §5](cross-cutting.md#5-database-schema-consolidated)), written by OPL (`source='qf'`) and the audit observer (`source='nt-native'`) per [order-flow.md §4.2](order-flow.md#42-writer-mapping-model-a-writer-identity-sourcing). On startup:

1. Set initial cash from portfolio config.
2. `SELECT … FROM audit_fills WHERE portfolio = ? ORDER BY filled_at` and replay each fill: update positions, compute P&L, update aggregates.
3. Rehydrate per-position `state` / `closing_intent_id` by joining against in-flight `audit_intents` (status `submitted` / `partial_filled`).
4. After replay, the portfolio state matches what it would be if the process had been running continuously.

**Why not persist the position state directly:** `audit_fills` is the source of truth. Persisting derived state (positions, P&L) creates a consistency risk — if a position cache gets out of sync with `audit_fills`, the system doesn't know which to trust. Replay from `audit_fills` is deterministic and self-healing; per-fill replay against `audit_fills` is treated as the regenerable materialised view.

**Replay performance:** At v1 scale (hundreds of fills per day), replay takes milliseconds. If `audit_fills` grows large (years of trading), a checkpoint mechanism can be added: periodically snapshot the positions projection to a DuckDB table and replay only fills after the checkpoint. Not needed at v1.

### 2. Risk evaluation

Risk limits are defined in the top-level TDD. This section specifies the computation and the two entry points: `canExecute` (called synchronously by OrderPlane for every QF-side producer: manual entry, manual liquidation, and exit-rule emissions per [order-execution.md §5](order-execution.md#5-position-exit-controls)) and the **gate evaluator** (called over NATS-RPC by the NT-side risk-gate plugin for every strategy `submit_order`).

**Risk gate evaluator.** Strategy orders flowing through NT are intercepted by QF's `RiskEngine` plugin and consulted over `orders.gate.<broker>` NATS-RPC. The gate evaluator runs the same per-strategy + cross-strategy + portfolio-level limits as `canExecute`, plus the additional inputs the gate's `GateRequest` carries (the in-flight intent log per [risk-gate-architecture.md §5](risk-gate-architecture.md#5-cross-strategy-intent-state), operator-halted strategy state from `server/strategy/lifecycle.ts`). Output is `{decision: approve|reject, reason, intent_id, envelope_id}`. Returns within the 50ms RPC budget. Full spec: [risk-gate-architecture.md](risk-gate-architecture.md). The `canExecute` entry point serves OrderPlane's two producers.

**Envelope revocation.** When the P&R engine's state changes in a way that invalidates a previously-approved envelope, it issues a revoke over `orders.gate.revoke.<broker>` (per [risk-gate-architecture.md §3.5](risk-gate-architecture.md#35-envelope-revocation)). The triggering conditions:

| Condition                                                  | Detected by                                                                                                    | `RevokeReason`                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Portfolio enters `halted=true`                             | `canExecute` halt action or operator-issued halt                                                               | `portfolio_halted`                    |
| Strategy moved to `halted` lifecycle state                 | `server/strategy/lifecycle.ts` state transition                                                                | `strategy_halted`                     |
| Hard drift trip on a fast-tier check                       | `drift-detector.ts` (see [drift-detector.md §2.1](drift-detector.md#21-fast-tier--per-fill-hard-bound-checks)) | `drift_hard_trip`                     |
| Concentration breach by a different strategy filling first | Aggregate-limit recompute on a fill, identifying envelopes that no longer fit                                  | `concentration_breach_other_strategy` |
| Operator-initiated via GUI                                 | Operator clicks "Revoke envelope" on a per-strategy view                                                       | `operator_initiated`                  |

The engine iterates open envelopes for the affected strategy (or portfolio, fanning across its strategies) and calls revoke per envelope — per-envelope granularity at the wire keeps the protocol minimal (per [risk-gate-architecture.md §3.5](risk-gate-architecture.md#35-envelope-revocation)).

**One evaluation function, three wrappers.** The pure evaluation logic (no I/O, no NATS, no DB) lives in `server/portfolio/evaluator.ts`. Three wrappers consume it: (1) the live NATS-RPC gate handler, (2) `canExecute` for OPL, and (3) a subprocess CLI shipped to quant-optimizer for offline backtest evaluation — see [backtest-gate.md](backtest-gate.md). All three paths share one evaluator; differences are transport and state-source only.

#### `canExecute` interface

The Order Plane calls this synchronously before submitting any OrderIntent it originates (manual entry, manual liquidation, or framework-fired exit rule — see [order-execution.md §5](order-execution.md#5-position-exit-controls)):

```js
/**
 * Check whether an OrderIntent can be executed without violating risk limits.
 * Called by the Order Plane before submission.
 *
 * Returns: { ok: boolean, violations: Violation[] }
 * A violation: { limit: "max_net_delta", current: 0.48, proposed: 0.96, threshold: 0.50, action: "reject" }
 */
function canExecute(portfolioId, orderIntent)
```

The check is **forward-looking**: it computes what the portfolio state would be _after_ the order fills and checks limits against that hypothetical state. For a sell-to-open order, this means increasing delta/vega exposure; for a buy-to-close, decreasing it.

For `action: "reject"` violations, the OrderIntent is not submitted. For `action: "halt"` violations (daily loss, drawdown), the portfolio enters `halted = true`, which **blocks new submissions** on the portfolio until operator reset — but does **not** auto-close existing positions (per [order-execution.md §5](order-execution.md#5-position-exit-controls); the operator decides whether to liquidate via the per-strategy position view).

#### Recompute triggers

Risk is recomputed on:

1. **New fill (including partial fills)** — positions and cash change. Recompute everything. See partial fill handling below.
2. **Quote update for an underlying** — `subscribeQuotes` callback fires with a new spot price. Recompute mark-to-market and Greeks using **new spot + last-known IV** (not a fresh chain fetch). Update equity, drawdown, check limits. This is the fast path — runs on every quote tick (every few seconds).
3. **Chain refresh (periodic)** — Every `chain_refresh_interval_seconds` (default: 60, configurable), the engine calls `getChain` for each underlying with open positions. Updates per-position IV from the chain, then recomputes Greeks with both new IV and current spot. This is the slow path — runs less frequently because chain fetches are expensive (API credits, larger payloads).
4. **Portfolio state change** — operator resets halt, adjusts cash, manual position adjustment.
5. **Market open** — daily P&L reset (see below).

Recompute is synchronous and in-process. At v1 scale (a few positions, updates every few seconds), this is sub-millisecond.

**Why two market data triggers:** Spot price moves continuously and affects delta/mark-to-market the most. IV moves slower and affects vega/theta. Recomputing Greeks with stale IV but fresh spot is a good approximation for the fast path — delta is primarily a function of spot and time, not IV. The periodic chain refresh corrects IV drift. If the chain refresh interval is too long, `marketdata_freshness_age_seconds{data_type="chain"}` makes the staleness visible.

#### Daily P&L reset

`daily_realized_pnl` and `peak_equity` reset at market open to start a fresh trading day. The reset is triggered by the market calendar:

On server startup, the Portfolio Engine schedules a timer for the next market open (via `calendar.nextOpen(exchange, now)`). When the timer fires:

1. `daily_realized_pnl` = 0.
2. `peak_equity` = current `equity` (fresh high-water mark for the new day).
3. `drawdown` = 0 (since peak_equity = equity).
4. Reschedule the timer for the next market open.

If the server restarts mid-day, the startup fill-log replay recomputes `daily_realized_pnl` from fills since the most recent market open (using the calendar to determine when that was).

**`peak_equity` limitation on mid-day restart:** The fill log only contains fills, not intra-day market data ticks. If equity peaked at $105k from market movement (no fills), then the process crashed, the fill-log replay cannot recover that peak — it only sees equity at the time of each fill. After restart, `peak_equity` is set to `max(equity_at_each_fill_during_replay)`, which may be lower than the actual intra-day peak. This makes the drawdown calculation more permissive than it should be for the first few minutes after restart.

This is accepted at v1. Perfectly reconstructing `peak_equity` would require either persisting it (contradicting the "fill log is the only source of truth" principle) or replaying market data ticks (impractical — they aren't stored at tick granularity). The pragmatic mitigation: after fill-log replay, set `peak_equity = max(current_equity, peak_equity_from_replay)` so it's at least not below the current equity. The reconciliation check that runs immediately after replay catches the more dangerous case (position mismatch with the broker). The drawdown halt may be slightly too permissive for a brief window after restart — this is acceptable because the operator is actively monitoring a restart scenario.

#### Partial fill handling

A partial fill is a fill for less than the full order quantity (e.g., 5 of a 10-lot). The broker may report multiple partial fills before the order is fully filled. The interaction with the risk engine must be explicit:

**Fill callback fires per partial fill.** When the broker reports a partial fill of 5 lots, the Order Plane's `onFill` callback fires immediately with `quantity: 5`. The fill feedback loop runs synchronously: fill log write → `engine.applyFill()` → positions updated with 5 lots → risk recomputed → GUI updated. The portfolio now reflects the 5 filled lots.

**`canExecute` sees current positions (including partial fills) plus reserved capacity for pending orders.** If a 10-lot order has partially filled 5, and a subsequent OrderIntent arrives:

- The 5 filled lots are in `positions` (applied by `applyFill`).
- The remaining 5 unfilled lots are tracked as **reserved exposure** — the risk engine estimates their Greek impact using current market prices and includes it in the forward-looking check.

This prevents over-allocation: without reservation, two concurrent 10-lot intents could each pass individually against a 50-delta limit, then both fill and push actual delta to 70. With reservation, the second intent sees the first's reserved capacity and is rejected.

**Reserved exposure estimation:** For pending orders, the risk engine computes estimated Greeks using the current market data (spot, IV, DTE) as if the order had filled at the current mid price. This is an approximation — the actual fill price and Greeks at fill time may differ. The approximation is conservative enough for risk gating; exact accounting happens when the fill arrives.

**Reservation lifecycle:**

- Created when an OrderIntent transitions to `submitted` (sent to broker).
- Updated on partial fill: reservation reduced by the filled quantity, positions increased by the same.
- Removed on full fill (all reserved → positions), rejection, or cancellation.

**Timing guarantee:** Because the fill callback → `applyFill` → recompute path is synchronous (single-threaded Node, no `await` between callback and state update), there is no window where `canExecute` could see stale state between a partial fill event and the portfolio update. A subsequent `canExecute` call always sees the latest fills.

**Edge case — rapid partial fills:** If the broker reports two partial fills in quick succession (e.g., 3 lots then 2 lots of a 5-lot order), each fires the callback sequentially. The first updates positions to 3 lots, the second updates to 5 lots. No fills are lost or double-counted because the fill log is append-only and position updates are idempotent on `fill_id`.

#### Greek computation runtime

Greeks are computed **in the per-broker NT bundle (Python)** at quote-enrichment time, not in the TS server's risk engine. When a market data tick arrives at the bundle, quote enrichment:

1. Uses broker-supplied Greeks when the broker returns them (Schwab returns delta / gamma / theta / vega / IV for equity options; IBKR returns them when modelGreeks is requested).
2. Falls back to computing Greeks via the `magpie_quant` Rust crate (exposed to Python via PyO3) for any leg the broker didn't price — futures options, equity options on Schwab-without-Greeks, or anywhere broker data is stale.

The enriched quote (including Greeks) is published on `marketdata.quote.<broker>.*`. The TS portfolio engine subscribes, updates each affected `Position`'s Greek fields directly, and re-aggregates via `recomputeAggregates(state)` — iterating positions and summing `delta × quantity × sign` etc. **No in-process math on the TS side.** The `GreeksCalculator` interface in [`server/portfolio/engine.ts`](../../server/portfolio/engine.ts) exists as an optional dep for offline / test paths; production wires it to `undefined` because positions already carry computed Greeks.

**Polyglot pattern.** Math kernels (`bs.{delta,gamma,theta,vega,iv}`, `black76.*`, `sabr.*`, `vol_surface.*`, `edge_greeks.*`, `bl.pdf`) live in [`core/qf-quant/`](../../core/qf-quant/) (Rust). Callers consume them via PyO3 (Python — NT bundles, research workers, the orchestrator) or WASM (TS browser-side — Greek Builder web worker). The TS server's portfolio engine specifically does not call into them; its inputs are pre-computed by upstream surfaces.

**FFI entry points** (Python surface; the Rust API mirrors these names module-for-module):

| Function                                                 | Signature                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| `magpie_quant.bs.delta`                            | `delta(spot, strike, t_years, rfr, iv, is_call) -> f64`         |
| `magpie_quant.bs.gamma`                            | `gamma(spot, strike, t_years, rfr, iv) -> f64`                  |
| `magpie_quant.bs.theta`                            | `theta(spot, strike, t_years, rfr, iv, is_call) -> f64`         |
| `magpie_quant.bs.vega`                             | `vega(spot, strike, t_years, rfr, iv) -> f64`                   |
| `magpie_quant.bs.iv`                               | `iv(spot, strike, t_years, rfr, price, is_call) -> Option<f64>` |
| `magpie_quant.black76.{delta,gamma,theta,vega,iv}` | same shape, futures forward instead of spot                     |
| `magpie_quant.sabr.fit` / `.iv_smile`              | SABR calibration + smile evaluation                             |
| `magpie_quant.vol_surface.evaluate`                | term-structure-aware IV interpolation                           |
| `magpie_quant.edge_greeks.{aggregate,per_leg}`     | basket-level edge attribution                                   |
| `magpie_quant.bl.pdf`                              | Breeden-Litzenberger PDF extraction                             |

Reference invocation, used inside the NT bundle's quote enrichment when broker-supplied Greeks are unavailable:

```python
from magpie_quant import bs

# position.iv is updated on chain refresh (periodic, every ~60s)
# spot is updated on every quote tick (every ~5s)
delta = bs.delta(spot, position.strike, dte / 365, rfr, position.iv, position.is_call)
gamma = bs.gamma(spot, position.strike, dte / 365, rfr, position.iv)
theta = bs.theta(spot, position.strike, dte / 365, rfr, position.iv, position.is_call)
vega  = bs.vega(spot,  position.strike, dte / 365, rfr, position.iv)
```

Per-position Greeks use last-known IV (from the most recent chain refresh) and current spot (from the latest quote). This means Greek updates between chain refreshes reflect spot movement but not IV movement — an acceptable approximation at v1 recompute frequency.

Portfolio-level Greeks are the signed sum across positions (accounting for direction and quantity).

### Per-strategy composite positions + exit-rule monitor

A strategy's **composite position** is the bundle of atomic positions tagged with the same `strategy_id` (a short straddle is two atomic option positions; an iron condor is four; a single-leg directional trade is one). Composite positions are **not a separate store** — they are SQL filters / aggregates over the canonical positions projector in [§1](#1-portfolio-state). This keeps a single source of truth (`audit_fills` → positions) and removes the consistency risk of maintaining parallel ledgers.

#### Composite position queries

The per-strategy view that drives the operator GUI ([gui.md](gui.md)) and the exit-rule monitor is built from the canonical projector:

```sql
-- All open atomic positions for a strategy (the composite)
SELECT position_id, symbol, direction, quantity, entry_price, multiplier,
       current_price, unrealized_pnl, high_water_pnl, delta, vega
  FROM positions
 WHERE strategy_id = ? AND state = 'open';

-- Strategy-level aggregate (composite-level metrics)
SELECT strategy_id,
       COUNT(*)                                                AS leg_count,
       SUM(ABS(quantity) * entry_price * multiplier)           AS gross_notional,
       SUM(unrealized_pnl)                                     AS strategy_unrealized_pnl,
       MAX(high_water_pnl_strategy_running)                    AS strategy_high_water_pnl,
       SUM(delta * quantity * CASE direction WHEN 'Long' THEN 1 ELSE -1 END) AS net_delta,
       SUM(vega  * quantity * CASE direction WHEN 'Long' THEN 1 ELSE -1 END) AS net_vega
  FROM positions
 WHERE strategy_id = ? AND state = 'open'
 GROUP BY strategy_id;
```

The strategy's running high-water P&L for trailing logic is held on the strategy record (not aggregated from per-position high-water marks) because the composite can shed and grow legs over its lifetime — drawdown is measured against the composite's history, not against any single leg's peak.

The atomic `state` field on each position is what it always was — `open` / `closing` / `closed` — tracking the _atomic_ position's lifecycle:

- `open` — eligible for exit-rule evaluation.
- `closing` — a closing intent is in flight; no further exit-rule evaluation fires (no double-emit). Transitions to `closed` when the closing fill lands.
- `closed` — fully exited. Retained for audit / GUI history.

Restart recovery: the engine rebuilds the canonical positions projector from `audit_fills` on boot per [§1 audit_fills replay](#persistence-audit_fills-replay). The `closing_intent_id` backref is recovered by joining against in-flight `audit_intents` whose `position_id` matches and whose lifecycle state is `submitted` / `partial_filled` / `submission_failed` ([order-execution.md §2](order-execution.md#2-order-lifecycle-state-machine)). The composite-level high-water mark is rebuilt from `audit_fills` realised + the current strategy aggregate `unrealized_pnl`.

#### Exit-rule monitor

Runs in the QF TS process; survives strategy crashes by design. Inputs:

- The canonical positions projector (filtered by `strategy_id`) for the per-leg view.
- The strategy composite aggregate (computed via the SQL above) for composite-level rules.
- Strategy's declared `StrategyExitPolicy` ([order-execution.md §5.1](order-execution.md#51-strategy-declared-exit-rules)), with overrides from `config/strategy_overrides.yaml` applied at strategy activation.

Evaluation cadence: every position recompute (same triggers as risk recompute in [§2](#recompute-triggers) — fill, quote update, chain refresh). No separate timer.

**Per-leg rules** (`stop_loss_pct`, `target_pct`, `max_hold_seconds`) evaluate each atomic position in isolation; trip → emit one closing intent for that leg. **Composite rules** (`max_drawdown_pct`) evaluate the strategy aggregate; trip → emit closing intents for **all** atomic positions tagged with that `strategy_id` at the time of evaluation.

On trip:

1. Mark each affected position `state = 'closing'` with `closing_intent_id` set to the new intent's ULID.
2. Cancel any in-flight working orders on the same `position_id` via `nt-bridge.cancelOrder()` (so the close doesn't race a stale entry order).
3. Emit `OrderIntent` through OPL with `reason = "exit_rule_<rule_name>"` and `strategy_id` / `position_id` populated.
4. Emit `position.exit_rule_tripped` event ([observability.md §2](observability.md#2-observable-action-categories)) with the rule name, current values, and threshold.
5. `position_exit_rule_tripped_total{strategy_id, rule}` counter increments ([order-execution.md §6](order-execution.md#6-metrics)).

**Idempotency / restart safety.** If the monitor crashes after emitting the intent but before transitioning `state = 'closing'`, restart recovery sees an open `audit_intent` with `reason="exit_rule_*"` pointing at the position; the position's `state` is set to `closing` from the audit join, no duplicate intent emitted.

### 3. Position reconciliation

The reconciliation loop diffs internal positions against the broker's actual positions.

#### Mechanism

Every `reconciliation_interval_seconds` (default: 60), the engine:

1. Calls `brokerAdapter.getPositions()` for each broker linked to the portfolio.
2. Diffs the result against the internal position list:
   - **Match:** Same symbol, same direction, same quantity. No action.
   - **Quantity mismatch:** Same symbol/direction but different quantity. Log drift.
   - **Missing internally:** Broker has a position we don't have. Log drift.
   - **Missing at broker:** We have a position the broker doesn't. Log drift.
3. On any mismatch:
   - Log at warn level with both views (internal and broker).
   - Increment `portfolio_reconciliation_drift_total{portfolio, broker}`.
   - If `reconciliation_halt_on_drift: true` (default: true), halt the portfolio.

**v1: alert and halt only.** The reconciliation loop does not auto-correct positions. Auto-correction is dangerous — if the internal state is wrong, "fixing" it might double a position or close something that shouldn't be closed. The operator investigates and resolves manually.

**Broker symbol mapping:** The broker returns positions in broker-specific symbology (IBKR conIds, Schwab symbols). The `BrokerAdapter` is responsible for converting to canonical symbols for comparison. Mismatches in symbol conversion are logged as reconciliation failures.

**NT-native positions:** NT strategies hosted in the per-broker prod TradingNode submit through NT's own broker adapter; their fills enter `audit_fills` via the observer with `source='nt-native'`. Reconciliation diffs broker positions against the **union** of QF-side ledger entries (source='qf') and NT-native fill rollups (source='nt-native'), so a strategy operating inside the shared TradingNode is not flagged as drift. See [strategy-deployment-topology.md §6](strategy-deployment-topology.md#6-strategy-state-contract) for the corresponding strategy-side state contract (strategies rebuild positions from this same broker view on bundle restart).

### Strategy drift monitoring

> **Status: implemented.** The drift detector ships in `server/risk/drift-detector.ts`, `server/risk/fast-tier.ts`, `server/risk/slow-tier.ts`, and `server/risk/baseline-resolver.ts`. Full spec lives in [drift-detector.md](drift-detector.md); this section names the architectural seam.

Position reconciliation answers "do my books match the broker's?". Strategy drift answers "is each strategy behaving the way its backtest or spec said it would?". A strategy whose live realized P&L curve has detached from its backtest distribution, or whose live hit rate has collapsed, is a risk event even when every fill reconciles cleanly.

The drift detector sits next to the reconciliation loop — same process, same DuckDB, runs per-strategy. Two tiers:

- **Fast tier — per-fill hard-bound checks.** Triggered by every `audit_fills` insert. Daily realized-loss floor, notional envelope, position-count envelope, fill-cadence floor. Bounds declared per strategy in the strategy spec. No statistics; cross the bound, fire an alert.
- **Slow tier — 60s timer distributional checks.** Realized P&L distribution, hit rate, slippage, signal-fill latency, return-volatility. Sample-size-gated, confidence-interval-checked against the spec range, with a per-(strategy, metric)-per-day alert budget so operators don't get drowned in noise.

Action on trip is **alert via the existing alert router** ([alerts.md](alerts.md)). No automatic halt at v1; operators decide whether to halt via the existing lifecycle controls. Per-strategy auto-halt-on-drift is a deferred enhancement once live calibration data exists — see [drift-detector.md §5](drift-detector.md#5-action-on-trip).

Baseline source is operator-controlled: strategies declare a spec range directly (primary), or pin a QO backtest archive in MinIO (secondary), or fall back to a rolling-window historical baseline from their own `audit_fills` (tertiary). Strategies without any baseline and with insufficient history have slow-tier drift detection disabled; the GUI surfaces this with a banner. Fast-tier hard-floor checks still apply if declared. See [drift-detector.md §4](drift-detector.md#4-baseline-source).

### 4. State reconstruction on crash

On process restart:

1. Replay the fill log (section 1 above).
2. Immediately run a reconciliation check against the broker.
3. If reconciliation passes: resume normal operation.
4. If reconciliation fails: halt the affected portfolio (block new submissions; existing positions untouched per [order-execution.md §5.4](order-execution.md#54-reconciliation-drift-handling)) and alert the operator. Do not resume trading until the operator confirms the state.

This sequence ensures that even if the fill log missed a fill (e.g., the process crashed between broker fill and fill log write), the reconciliation catches it before the system trades again.

### 5. Multi-portfolio isolation

Each portfolio has its own:

- Position list and cash balance
- Risk limits
- Halt state
- Fill log
- Reconciliation loop (may use different brokers)

Portfolios do not share state. A halt on one portfolio does not affect others. The strategy layer and Order Plane are also scoped per-portfolio.

### 6. Metrics

| Metric                                  | Type      | Labels                 | Description                                 |
| --------------------------------------- | --------- | ---------------------- | ------------------------------------------- |
| `portfolio_positions_count`             | gauge     | `portfolio`            | Open positions                              |
| `portfolio_net_delta`                   | gauge     | `portfolio`            | Current net delta                           |
| `portfolio_net_vega`                    | gauge     | `portfolio`            | Current net vega                            |
| `portfolio_realized_pnl`                | gauge     | `portfolio`            | Cumulative realized P&L                     |
| `portfolio_unrealized_pnl`              | gauge     | `portfolio`            | Current unrealized P&L                      |
| `portfolio_daily_pnl`                   | gauge     | `portfolio`            | Daily realized P&L                          |
| `portfolio_drawdown`                    | gauge     | `portfolio`            | Current peak-to-trough                      |
| `portfolio_halted`                      | gauge     | `portfolio`            | 1 if halted                                 |
| `portfolio_risk_check_total`            | counter   | `portfolio`, `result`  | canExecute calls (ok, rejected, halted)     |
| `portfolio_risk_check_duration_seconds` | histogram | `portfolio`            | canExecute latency                          |
| `portfolio_reconciliation_total`        | counter   | `portfolio`, `result`  | Reconciliation runs (match, drift)          |
| `portfolio_reconciliation_drift_total`  | counter   | `portfolio`, `broker`  | Drift events                                |
| `portfolio_recompute_total`             | counter   | `portfolio`, `trigger` | Risk recomputes (fill, market_data, manual) |

### 7. Portfolio snapshots table

The top-level TDD (Observability §C) calls for historical P&L and risk headroom tracking. The `portfolio_snapshots` table provides this.

```sql
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  portfolio       VARCHAR NOT NULL,
  snapshot_ts     TIMESTAMP NOT NULL,     -- when this snapshot was taken
  trigger         VARCHAR NOT NULL,       -- "fill" | "end_of_day" | "market_open"
  cash            DOUBLE NOT NULL,
  equity          DOUBLE NOT NULL,        -- cash + sum(unrealized)
  realized_pnl    DOUBLE NOT NULL,
  unrealized_pnl  DOUBLE NOT NULL,
  daily_realized  DOUBLE NOT NULL,
  net_delta       DOUBLE NOT NULL,
  net_vega        DOUBLE NOT NULL,
  drawdown        DOUBLE NOT NULL,
  peak_equity     DOUBLE NOT NULL,
  positions_count INTEGER NOT NULL,
  halted          BOOLEAN NOT NULL,
  data_stale      BOOLEAN NOT NULL,

  PRIMARY KEY (portfolio, snapshot_ts)
);
```

**Write triggers:**

- **On every fill** — captures the portfolio state immediately after each position change. This is the highest-resolution record of P&L impact per trade.
- **End of day** — captures the closing state (final mark-to-market after the last market data tick). Scheduled via the same market calendar timer as the daily P&L reset (fires just before the reset).
- **Market open** — captures the opening state after the daily reset. Provides the day's starting point for P&L analysis.

Snapshot writes are fire-and-forget `INSERT` statements in the main Node process. They are secondary to the fill log — if a snapshot write fails (DuckDB error), it is logged and skipped. The fill log and audit tables remain the system of record.

**Retention:** Same as the data lake — indefinite at v1. Snapshots are small (one row per event, ~200 bytes). Years of trading produce millions of rows, which DuckDB handles comfortably.

**Query patterns:**

- GUI Risk Dashboard: `SELECT * FROM portfolio_snapshots WHERE portfolio = ? ORDER BY snapshot_ts DESC LIMIT 1` (current state).
- Historical headroom chart: `SELECT snapshot_ts, net_delta, net_vega, drawdown FROM portfolio_snapshots WHERE portfolio = ? AND snapshot_ts BETWEEN ? AND ?`.
- "How close did I get to the drawdown halt last Tuesday?": `SELECT max(drawdown) FROM portfolio_snapshots WHERE portfolio = ? AND snapshot_ts::date = '2026-04-07'`.

### 8. Risk limits storage (config/risk_limits.yaml)

Risk limits are stored in a dedicated YAML file (`config/risk_limits.yaml`), separately from the portfolio's mode/broker/strategies config in `portfolios.json`. The split keeps the limit values version-controlled, operator-editable through the GUI (Settings → Risk → Limits), and reloadable without restarting the server config layer.

#### File shape

```yaml
version: 1
portfolios:
  main:
    max_net_delta: 50
    max_net_vega: 100
    max_daily_loss: 5000
    max_symbol_concentration: 20
    max_drawdown: 10000
    max_order_size: 10
    max_open_orders: 20
```

`null` is permitted for any field — interpreted as "no limit" for that metric. Negative values and non-numeric values are rejected at write time (status 400).

#### Bootstrap

On first boot the YAML doesn't exist. The `RiskLimitsStore` then bootstraps from whatever `portfolios.json` had under `portfolios.<id>.limits` and writes the YAML. From the second boot onward the YAML is the source of truth; `portfolios.json`'s `limits` block is left in place for backward compat but no longer consulted.

This keeps the upgrade path zero-touch — operators didn't have to migrate anything.

#### HTTP surface

```
GET  /api/risk/limits              → RiskLimitsConfig (all portfolios)
PUT  /api/risk/limits/:portfolio   → RiskLimits (one portfolio's full limit set)
```

The full config also rides in the `/ws/state` snapshot under `risk_limits`. Saving via PUT triggers a `risk_limits` WS message:

```json
{
  "type": "risk_limits",
  "data": {
    /* full RiskLimitsConfig */
  }
}
```

The Risk Headroom panel re-renders without a page refresh.

#### Persistence

Atomic write: `fs.writeFile` to `risk_limits.yaml.tmp`, then `fs.rename` to the target. A reader will never see a half-written file.

Validation is per-field: every numeric key must be a finite non-negative number or `null`. The store rejects unsupported `version` values (1 only).

#### Tests

6 unit tests in [server/risk/**tests**/unit/limits.test.ts](../../server/risk/__tests__/unit/limits.test.ts) cover bootstrap from fallback, YAML preference over fallback, round-trip persistence, validation, version check, and `onChange` ordering.

#### Files

- `server/risk/limits.ts` — `RiskLimitsStore` class (load / get / setPortfolio / atomic persist / onChange).
- `config/risk_limits.yaml` — git-tracked; bootstrapped from `portfolios.json`'s `limits` block on first boot if absent. The design's "limits are version-controlled" pitch hangs on this file being tracked, so changes via Settings → Risk → Limits become reviewable diffs.
- `src/types/ws.ts` — `RiskLimitsConfig` type + `RiskLimitsMsg` union member.
- `src/screens/RiskLimitsScreen.tsx` — portfolio picker + per-field form.

### 9. Files

Implementation files:

- [`server/portfolio/engine.ts`](../../server/portfolio/engine.ts) — Portfolio state management, risk evaluation, `canExecute`, recompute. Exports `createPortfolioEngine(deps)`.
- [`server/portfolio/reconciliation.ts`](../../server/portfolio/reconciliation.ts) — Reconciliation loop. Exports `startReconciliation(engine, brokerAdapter, config)`.
- [`server/portfolio/replay.ts`](../../server/portfolio/replay.ts) — `audit_fills` replay on startup. Exports `replayFromAuditFills(db) → PortfolioState`.
- [`server/risk/limits.ts`](../../server/risk/limits.ts) — Risk limits YAML store (see §8).

Source of truth for Greek computation is the `magpie-quant` Rust crate; FFI entry points are enumerated in [§2 Greek computation](#greek-computation). Backtest position tracking happens inside NautilusTrader's portfolio model.

---

### 10. Observability

The detailed framework lives in [`tdd/observability.md`](observability.md). This section names only the events this component emits.

All events follow the common JSON schema: `ts`, `level`, `service` (= `"portfolio-risk-engine"`), `correlation_id` (propagated from the inbound NATS message — fill / order intent / market-data update), `event`, plus the event-specific payload below.

| Event                           | Payload (key fields)                                                                                                                  | Emitted when                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `position.opened`               | `portfolio`, `position_id`, `symbol`, `qty`, `entry_price`, `entry_fill_id`                                                           | A fill creates a new position.                                                                                                                                                                     |
| `position.closed`               | `portfolio`, `position_id`, `realized_pnl`, `exit_fill_id`                                                                            | A fill closes a position; carries the realized P&L for the round trip.                                                                                                                             |
| `position.updated`              | `portfolio`, `position_id`, `qty_delta`, `fill_id`                                                                                    | A fill changes an existing position's quantity (partial / scale-in / scale-out).                                                                                                                   |
| `position.greeks_recomputed`    | `portfolio`, `position_id`, `delta`, `gamma`, `theta`, `vega`, `spot`, `iv`, `source` (= `"qf_quant_pyo3"`)                           | Per-position Greeks recomputed on a market-data trigger. Sampling: emit every recompute at `debug`, every Nth at `info`, with `N` set so steady-state is one `info` line per minute per portfolio. |
| `portfolio.greeks_recomputed`   | `portfolio`, `net_delta`, `net_vega`, `net_gamma`, `net_theta`                                                                        | Portfolio-level rollup published after every position-level recompute batch.                                                                                                                       |
| `risk.evaluated`                | `portfolio`, `intent_id`, `outcome` (`allow` / `reject` / `degrade`), `violations` (list of `{limit, current, proposed, threshold}`)  | Every `canExecute` call emits one of these. Reject events also include a `reason` string.                                                                                                          |
| `risk.reservation_acquired`     | `portfolio`, `intent_id`, `reserved_delta`, `reserved_vega`                                                                           | Order accepted; per-direction headroom decremented.                                                                                                                                                |
| `risk.reservation_released`     | `portfolio`, `intent_id`, `reason` (`filled` / `cancelled` / `rejected_by_broker`)                                                    | Reserved headroom returned.                                                                                                                                                                        |
| `reconciliation.started`        | `portfolio`, `broker`                                                                                                                 | Per-broker reconciliation tick begins.                                                                                                                                                             |
| `reconciliation.drift_detected` | `portfolio`, `broker`, `kind` (`qty_mismatch` / `missing_internally` / `missing_at_broker`), `symbol`, `internal_view`, `broker_view` | A drift between internal positions and the broker is observed. Always paired with a `portfolio_reconciliation_drift_total` counter increment ([§6 metrics](#6-metrics)).                           |
| `reconciliation.halted`         | `portfolio`, `reason`                                                                                                                 | The portfolio enters halted state because reconciliation failed and `reconciliation_halt_on_drift: true`.                                                                                          |
| `portfolio.state_replayed`      | `portfolio`, `fills_replayed`, `final_position_count`                                                                                 | After a crash, fill-log replay completed and reconciliation passed (or did not — `final_status` field).                                                                                            |
| `portfolio.snapshot_written`    | `portfolio`, `snapshot_id`, `net_delta`, `net_vega`, `drawdown`                                                                       | EOD or operator-triggered snapshot persisted to the snapshots table.                                                                                                                               |
| `risk_limits.changed`           | `portfolio`, `field`, `old_value`, `new_value`, `actor` (operator id or `system`)                                                     | A risk limit was modified via the Settings → Risk → Limits surface. Always git-tracked via `config/risk_limits.yaml`.                                                                              |

**Position-lifecycle traceability.** "One position lifecycle, one correlation ID." The risk engine satisfies that by propagating the inbound `correlation_id` (carried on the fill / quote / signal that triggered the work) onto every emitted event in the chain above. A `position.opened` carries the same ID as the fill that opened it, which carries the same ID as the OrderIntent, which carries the same ID as the originating signal.

**Sampling discipline.** Per-position Greek recomputes can fire at ~spot-tick frequency (every ~5s) × N positions; emitted-per-event would flood logs. The sampling rule above (debug for every event, info for every Nth) keeps steady-state log volume bounded while still allowing full debug-level reconstruction post-hoc. Metrics ([§6](#6-metrics)) carry the unsampled counts.

---

### 11. Option lifecycle handling

Promoted from a parked open question (per OPEN-QUESTIONS.md Phase C walkthrough) to an active P0 module. Architecturally unaccounted-for today: `Position.expiration` and `OrderStatus.expired` exist in the type system, but no handler processes calendar-driven expiry, broker-pushed assignment notifications, or operator-initiated exercise. Filing this for QF-309 so QF-321 et al. can implement against a single spec.

Trigger: any options strategy going live — including cl_scalp's futures-options legs — needs this to function. Without it, expired positions stay open in the projector indefinitely; broker assignment events get silently dropped at the bridge; the operator has no GUI affordance to exercise long options before expiry.

#### 11.1 What needs to exist

Three lifecycle event sources, one shared audit / position-mutation path:

| Event source                    | Trigger                                                                                                                                                              | Origin                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Calendar sweeper**            | Position's `expiration <= today` at market close (or next market open for after-hours expiries — equity options expire 16:00 ET; index options expire AM-settled).   | Periodic timer in the P&R engine.                                     |
| **Broker assignment push**      | Broker reports an assignment / early-exercise event on an option position (short options assigned, long options auto-exercised at expiry by the broker's processor). | NATS subject from the broker NT bridge.                               |
| **Operator-initiated exercise** | Operator clicks "Exercise" on a long-option position in the GUI's Position Inspector.                                                                                | GUI → `POST /api/positions/:id/exercise` (v2; not at v1 — see §11.5). |

All three converge on the same downstream effect: an event flowing through the audit chain that mutates the position ledger and produces the right P&L + cash settlement consequences.

#### 11.2 Calendar sweeper

`server/portfolio/option-lifecycle-sweeper.ts` — new module in the P&R engine. Runs at:

- **Market close** (16:00 ET on the relevant exchange's trading calendar — `server/calendar/` is the source of truth) — sweeps positions whose `expiration` is today and the option is at-or-out-of-money at close.
- **Market open** (09:30 ET next trading day) — sweeps positions whose `expiration <= yesterday` that the close-sweep didn't already handle (covers AM-settled index options + corner cases where close-sweep skipped because spot was uncertain).

For each position with `expiration <= today`:

```
classify(position, market_close_spot):
  if position is option and expiration < today:
    # Should have been handled at close. Log as recovery.
    emit lifecycle.expiry_late_sweep
  if position is long call and spot >= strike + tolerance:
    => auto-exercised by broker (expect assignment push)
  if position is short call and spot >= strike - tolerance:
    => assigned (expect assignment push)
  if position is long put and spot <= strike - tolerance:
    => auto-exercised (expect assignment push)
  if position is short put and spot <= strike + tolerance:
    => assigned (expect assignment push)
  otherwise:
    => expired worthless; emit expiry-close intent
```

For positions classified as "expired worthless," the sweeper emits a synthetic closing event directly to the position ledger (no OrderIntent through OPL — there's no order to submit, the option simply ceases to exist). Audit row: `audit_intents.reason = 'expiry_worthless'`, `audit_intents.source = 'qf'`, with a corresponding `audit_orders` row at `status = 'expired'` (the existing `OrderStatus.expired` slot the type system has). P&L impact: the position's remaining unrealized P&L crystallizes as realized; for short options that expired worthless, the seller keeps the premium.

For positions classified as "auto-exercised" or "assigned," the sweeper does NOT emit. The broker's assignment push (§11.3) drives the actual ledger mutation; the sweeper's classification is informational only (used to flag positions where assignment is expected so a stale-bridge state shows up as a "predicted assignment without broker push within 24h" alert).

Tolerance is small (~$0.01) to handle close-of-day spot ticks that resolve in-the-money. Strategies whose risk depends on tighter boundaries (deep-ITM vs ATM) should manage their own positions ahead of expiry.

#### 11.3 Broker-events path

Both Schwab and IBKR push assignment notifications via their respective NT bundles. Schwab's `OrderEvent` for assigned options emits with a distinct event-type code; IBKR's `execDetails` for option assignment uses a similar mechanism. The Python NT bridges translate broker-specific events into a uniform wire payload on a new NATS subject:

`broker.events.<broker>` — pub-only, JSON payload:

```ts
interface BrokerLifecycleEvent {
  broker: "schwab" | "ibkr";
  event:
    | "option_assigned" // short option assigned by counterparty
    | "option_exercised" // long option auto-exercised at expiry
    | "option_expired"; // confirmation that an option expired worthless
  position_symbol: string; // OPT:SPY:2026-05-16:C:500
  // Settlement details:
  underlying_symbol: string; // SPY
  side: "buy" | "sell"; // direction of the resulting underlying position
  quantity: number; // contracts × multiplier (typically × 100)
  settlement_price: number; // strike for assignment; market for cash-settled
  settlement_type: "physical" | "cash";
  asof: string; // broker's reported event time
  // Cross-references:
  broker_position_id: string | null;
}
```

The audit observer ([order-flow.md §4](order-flow.md#4-audit-chain)) extends its subscription to handle `broker.events.<broker>` alongside `orders.exec_reports.<broker>`. For each event:

- Write an `audit_orders` row with `status = 'expired'` or a new `status = 'assigned'` / `'exercised'` (additive — adds new terminal states to the OrderStatus enum), tagged `source = 'nt-native'`.
- Write the matching position-mutation in the canonical projector:
  - Option position closes (qty → 0, exit price = settlement_price).
  - For `physical` settlement: a new underlying position opens (or modifies an existing one), tagged with the same `strategy_id` as the option position.
  - For `cash` settlement: cash P&L only; no underlying position created.
- Emit `position.expired` / `position.assigned` / `position.exercised` events per [§10](#10-observability) (additive event types).

Subject indexed in [nats-subjects.md §2](nats-subjects.md) as a new `broker.events.*` family.

#### 11.4 Downstream effects

| Effect                             | Mechanism                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit chain rows                   | Per §11.3, each lifecycle event lands as an `audit_orders` row (status `expired` / `assigned` / `exercised`). Joining back via `intent_id` gives the full history.                                                                       |
| Position ledger mutation           | Option position closes; underlying position opens/modifies on physical settlement. Both go through the same projector path that fills use.                                                                                               |
| P&L impact                         | Crystallized as realized P&L at the settlement price. Short option expiring worthless: realized = premium kept. Long option auto-exercised: realized P&L on the option closes; new underlying position's unrealized P&L starts from now. |
| Cash settlement                    | Tracked via the existing portfolio cash ledger (separate from positions). Broker's reported cash impact is the source of truth; QF reconciles via the existing position-reconciliation cadence ([§3](#3-position-reconciliation)).       |
| Exit-rule monitor state            | Closes the option position's `closing_intent_id` field (so the monitor stops re-evaluating exit rules for the now-closed position). New underlying position is a fresh entry, subject to its own rules if the strategy declared any.     |
| Drift detector / risk reservations | `position.expired` releases the reservation per the existing `risk.reservation_released` path; `position.assigned` keeps a reservation against the new underlying position with reason `assignment_carryforward`.                        |

#### 11.5 Operator-initiated exercise

GUI primitive: Position Inspector → "Exercise" action on long-option positions before expiry. Submits an exercise instruction via the broker's API:

- Schwab: dedicated exercise endpoint (TBD; not currently wired)
- IBKR: `ib_insync.exerciseOptions()` equivalent

**Out of scope at v1.** Operator-initiated early exercise is uncommon (the time value lost almost always exceeds any rational reason to exercise early). Defer to v2; flag the GUI affordance as deferred. The audit + position-mutation path from §11.3 still works if the operator exercises via the broker's web UI directly — the assignment push lands on `broker.events.<broker>` and QF processes it normally.

#### 11.6 What is out of scope

- **Roll automation.** Operators roll discretionarily for v1 (close one expiry → open another via the existing OPL paths). No automated roll primitive.
- **Cash-vs-physical settlement distinction beyond what the broker reports.** QF respects whatever `settlement_type` the broker's event carries; doesn't try to predict or override based on contract-spec heuristics.
- **Pin risk hedging.** Strategies near-the-money at close are the operator's risk to manage ahead of close. The sweeper classifies and emits alerts; it doesn't auto-hedge.
- **Multi-day expiration windows.** Weekly options, monthly options, LEAPS all use the same flow — `expiration` is per-position; the sweeper doesn't care which expiry tier.

#### 11.7 Failure modes

| Failure                                                           | Behavior                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sweeper classifies "auto-exercised" but no broker push within 24h | Emit `option_assignment_missing_alert`. Operator investigates. The position stays "expired-but-unsettled" until a manual reconciliation or a late-arriving broker push.                                                                                     |
| Broker pushes an assignment for a position QF doesn't know about  | Audit observer writes the `audit_orders` row with `source='nt-native'`; position projector creates a new position record (strategy_id resolves to `__operator__` sentinel).                                                                                 |
| Settlement price disagrees with QF's last-known spot              | Trust the broker. Update the position with the broker's settlement_price and emit a `position.settlement_price_diff` event for the audit trail.                                                                                                             |
| Calendar timezone mismatch                                        | Sweep uses the exchange's local calendar from `server/calendar/`. NTP drift > 5s (per [cross-cutting.md](cross-cutting.md)) is rejected at the engine boundary.                                                                                             |
| Strategy retired with open option positions                       | Sweeper still processes them; the audit chain records the lifecycle event with the retired `strategy_id`. Resulting underlying position (physical settlement) lands tagged with the same retired strategy and surfaces in the operator-liquidation backlog. |

#### 11.8 Implementation phasing

Three PRs:

1. **Design + DDL** (this doc + audit_orders status additive enum + `broker.events.<broker>` subject registration) — doc-only PR.
2. **Sweeper module** (`server/portfolio/option-lifecycle-sweeper.ts` + tests against fixture calendar + classifier truth-table).
3. **Broker-events observer extension** (audit observer adds the second subscription + Schwab / IBKR Python-side event translators).

GUI affordance (operator-initiated exercise) is deferred to v2 per §11.5.
