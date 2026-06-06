# Exit-Rule Monitor — Component TDD

Parent: [TRADING-SYSTEM-TDD.md](../TRADING-SYSTEM-TDD.md). Companions: [order-execution.md](order-execution.md), [portfolio-risk-engine.md](portfolio-risk-engine.md), [order-flow.md](order-flow.md), [gui.md](gui.md).

---

## 1. Purpose

Strategies declare hard exits at registration time (`stop_loss_pct`, `target_pct`, `max_hold_seconds`, `max_drawdown_pct` per [order-execution.md §5.1](order-execution.md#51-strategy-declared-exit-rules)). This doc specifies the **framework-side monitor** that evaluates those rules against the canonical positions projector and emits closing `OrderIntent`s through OPL when one trips.

The monitor exists so a hung strategy can't suppress its own stop. Rule evaluation lives in the QF TS process; strategy code crashing in NT doesn't disable the framework-side exits.

Today (2026-05): per `portfolio-risk-engine.md §2 Per-strategy composite positions + exit-rule monitor` and the §5.1 referenced above, the monitor is **design intent, not implemented**. This doc consolidates the contract so QF-321 can implement against a single spec instead of stitching from §5.1 + the portfolio-risk-engine seam + the Phase D ticket text.

## 2. Where the monitor lives

`server/portfolio/exit-rule-monitor.ts` — a new module in the same process as the canonical positions projector. The portfolio engine emits position-update events (per-fill + per-quote-tick recompute); the monitor subscribes and evaluates active rules against the updated state.

Co-locating with the projector keeps the rule evaluation reading from the same in-memory snapshot that drives the GUI's per-strategy view — no risk of evaluating against stale state because two consumers disagree on which projection step they're seeing.

## 3. Rule schema

Rules are declared per-strategy at registration time and overridable per `config/strategy_overrides.yaml` (existing pattern per [order-execution.md §5.1](order-execution.md#51-strategy-declared-exit-rules)):

```ts
interface StrategyExitPolicy {
  per_position: {
    // Unrealized PnL on the position ≤ -stop_loss_pct × entry_notional.
    // Trip closes that one position.
    stop_loss_pct?: number;
    // Unrealized PnL on the position ≥ target_pct × entry_notional.
    // Trip closes that one position.
    target_pct?: number;
    // Position open ≥ max_hold_seconds. Trip closes that one position.
    max_hold_seconds?: number;
  };
  per_strategy: {
    // Strategy's realised + unrealised drawdown from its high-water
    // mark ≥ max_drawdown_pct. Trip closes ALL positions the strategy
    // owns (one closing intent per atomic position; not aggregated).
    max_drawdown_pct?: number;
  };
}
```

Omitted fields = rule does not apply. A strategy with no policy declared has no framework-enforced exits — only its own discretionary close logic and operator manual liquidation can close its positions.

### 3.1 Spec home

**Per-strategy declaration**, not per-portfolio. The rationale: drawdown semantics belong to a strategy's own risk model. Two strategies on the same portfolio can declare different `stop_loss_pct` without contradicting each other — they own their own positions. A portfolio-level drawdown halt (per [portfolio-risk-engine.md](portfolio-risk-engine.md)) is a separate primitive that halts the whole portfolio for daily-loss / max-drawdown breaches; it is **not** the exit-rule monitor.

Declaration file format: `config/strategies/<strategy_id>.json` (alongside the existing per-strategy config), with the `exit_rules` block keyed inside the strategy's spec object. The override file at `config/strategy_overrides.yaml` (per §5.1) continues to win at activation time.

## 4. Composite-position handling

When a strategy's position is multi-leg (e.g., a short straddle = one short call + one short put, two atomic `Position` rows), exit rules trip on the **composite P&L**, not on individual legs.

### 4.1 What a composite is

The canonical positions projector keeps **one row per atomic position** keyed by `position_id`, tagged with `strategy_id` and a `composite_id` (nullable; null = atomic-only). A composite is the SQL grouping over `position_id WHERE composite_id = <X>` — there is no separate composite table.

The strategy declares its composites at intent-emission time. When a strategy submits a multi-leg structure (per the [exec-algorithms.md](exec-algorithms.md) parent/child model), the parent intent carries `composite_id = ulid()` and each child order inherits it. On the audit side, `audit_orders.composite_id` is the join key for the composite P&L view.

### 4.2 Composite P&L for rule evaluation

`stop_loss_pct` and `target_pct` evaluate against `SUM(unrealized_pnl) / SUM(entry_notional)` over the composite's legs. `max_hold_seconds` evaluates against `MIN(opened_at)` over the composite — the composite is "still open" while any leg is.

`max_drawdown_pct` operates one level up: it sums over **all the strategy's positions** (atomic + composite legs), not over a single composite. The metric is the strategy's high-water mark minus current realized+unrealized equity.

### 4.3 Trip emission for composites

When a per-position rule trips on a composite, the monitor emits **one closing `OrderIntent` per atomic leg** in parallel — not a single composite-level intent. Each carries:

- `position_id` = the individual leg's `position_id`
- `composite_id` = the parent composite
- `strategy_id` = the position's owning strategy
- `reason` = `exit_rule_<rule_name>` (e.g. `exit_rule_stop_loss`)
- `source` = `qf` (OPL writes the audit row)

OPL processes each closing intent independently. Failures on one leg don't roll back the others — the operator sees per-leg status in the GUI and can manually close any straggler via §5.2.

For `max_drawdown_pct` on a strategy with composites: emit one closing intent per atomic position across **all** composites (not one per composite). The monitor uses the same per-leg parallel emission pattern.

## 5. Closing-intent emit contract

Every closing intent from the exit-rule monitor carries the §4.3 shape plus the OPL fields from [order-execution.md §1](order-execution.md#1-order-intent--surface-vs-order). The relevant additions to that shape are documented inline in §5.1 of the same TDD; this section is non-normative reiteration.

```ts
interface ExitRuleClosingIntent extends OrderIntent {
  action: "close";
  position_id: string;
  composite_id: string | null;
  strategy_id: string; // never null for exit-rule closes
  reason: `exit_rule_${"stop_loss" | "target" | "max_hold" | "max_drawdown"}`;
  // The triggering rule's current value vs threshold, for the audit
  // trail. Persisted on audit_intents.reason_detail (JSON) so the
  // forensic question "what did stop_loss see when it fired?" is
  // answerable without re-running the eval.
  reason_detail: {
    rule: "stop_loss" | "target" | "max_hold" | "max_drawdown";
    threshold: number;
    actual: number;
    asof: string;
  };
}
```

`reason_detail` is a new audit_intents column. Additive ALTER for existing installs; nullable in the DDL so non-exit-rule rows leave it null. Lands with the QF-321 implementation PR.

## 6. Idempotency

The monitor MUST NOT emit a second closing intent for a position whose first close is already in-flight. The guard is on the canonical positions projector's `closing_intent_id` field — once a close intent is submitted, `closing_intent_id` is populated on the position row before the next eval pass runs.

```
on position update:
  for rule in active_rules:
    if rule.evaluate(position) is tripped:
      if position.closing_intent_id is not null:
        skip                # already closing
      else:
        emit closing intent
        position.closing_intent_id = intent.intent_id
```

The eval cycle is sequential per position (a single async function over the active-rule list), so two rules tripping on the same position in the same tick produce one closing intent — the first to trip wins; the second sees `closing_intent_id` already set.

For composite-level trips: the guard is keyed on `position_id`, so each leg gets its own check. If two legs of the same composite both have `closing_intent_id = null` and the per-composite stop_loss trips on the composite P&L, two parallel closing intents emit (one per leg). The monitor's per-position guard prevents duplicate emissions if the next tick re-evaluates against the same composite.

## 7. Metrics

| Metric                             | Type      | Labels                               | Meaning                                                                       |
| ---------------------------------- | --------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `exit_rule_trips_total`            | counter   | `strategy_id`, `rule`                | Total times each rule fired. Compared against `position_total` for incidence. |
| `exit_rule_headroom_pct`           | gauge     | `strategy_id`, `position_id`, `rule` | Current `(threshold - actual) / threshold` ratio. -1 if the rule isn't armed. |
| `exit_rule_evaluation_duration_ms` | histogram | `strategy_id`                        | Time spent in one eval cycle per strategy. Should be sub-millisecond.         |

`exit_rule_headroom_pct` feeds the GUI per-strategy panel ([§8](#8-gui-surfacing)) so operators see how close each rule is to tripping without recomputing on the client.

## 8. GUI surfacing

The GUI design lives in [gui.md §1 "Position + exit-rule state surface"](gui.md) (the `/ws/state` contract) and is built by QF-322. The data the monitor must expose, and where it rides:

- **Per-strategy headroom** ("closest to trip", e.g. `stop_loss: -3.2% / -5.0% (1.8% headroom)`) — pushed on `strategy_update.data.exit_rules[]`, derived directly from this monitor's §7 `exit_rule_headroom_pct` / the `ExitRuleEvaluation` shape. Streaming that field is QF-351 (wiring the monitor's evaluations into the WS push), against the QF-350 contract.
- **In-flight closing banner** — driven by the `position_exit_rule` trip event.
- **Trip history** — not streamed; the Investigate panel queries `audit_intents WHERE reason LIKE 'exit_rule_%'` (every close persists `reason = exit_rule_<rule>` per §5). No separate trip store.
- **Alert** — [alerts.md](alerts.md) routes an `exit_rule_tripped` alert when a rule fires.

Sequencing: QF-321 (this monitor) → QF-350 (the `/ws/state` contract, design) → QF-351 (impl) → QF-322 (the GUI panels that consume it).

## 9. What is NOT in this monitor

- **Strategy discretionary exits.** Strategies can close positions whenever they want by emitting a closing intent via NT. Those flow through the gate-evaluator path with `audit_intents.source='qf-gated'` and `reason='strategy_discretionary'`. The monitor doesn't see them or interfere.
- **Per-rule mute / temporary disable from the GUI.** Not at v1; declare a clean model. To temporarily disable a rule, edit the override file and reactivate.
- **Per-position rule edits in the GUI.** Rules are declared at registration time and overridden via the YAML override file. The GUI is read-only on rule definitions at v1.
- **Drawdown reset on manual flat.** If the operator manually liquidates and the strategy's equity recovers, the high-water mark stays. Operator can manually reset via the existing strategy lifecycle primitives (retire + re-register).
- **Cross-strategy aggregate exits.** Those live in [risk-gate-architecture.md §5](risk-gate-architecture.md#5-cross-strategy-intent-state) (gate-side enforcement at submission time). The exit-rule monitor is per-strategy only.

## 10. Failure modes

| Failure                                                      | Behavior                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Position update event without quote                          | Evaluator skips the position with a structured log (`exit_rule_eval_skipped` reason `no_quote`); next tick re-evaluates.                             |
| OPL.submit() rejects the closing intent                      | Position's `closing_intent_id` stays unset; next tick re-emits. Log `exit_rule_emit_failed` so persistent failure is visible.                        |
| Eval cycle throws                                            | Catch at the monitor boundary; log + emit `exit_rule_evaluator_threw` alert; subsequent ticks continue (the failure is per-cycle, not per-strategy). |
| Strategy retired during eval                                 | Skip evaluation for retired strategies; the canonical projector still has their positions, but they're operator-liquidation-only per §5.7 lifecycle. |
| Position's strategy_id resolves to `__operator__` (sentinel) | Skip — operator-originated positions have no strategy-declared rules. The sentinel exists only so audit aggregations don't drop close rows.          |

## 11. Implementation phasing

The Phase D ticket trio splits this into three steps:

1. **QF-320** — this doc (design + schema additions). No code.
2. **QF-321** — `server/portfolio/exit-rule-monitor.ts` + the position-update subscription + closing-intent emission. Tests for each rule + the composite-P&L aggregation + the idempotency guard.
3. **QF-322** — GUI: per-strategy panel headroom display, Investigate panel trip history, alert routing, banner for in-flight closing intents.

## 12. Open questions (parked at design time)

- **Quote source for unrealised P&L on options.** Current spec says "every market-data tick" drives a re-eval. For options that may mean stale-quote bias near close. Defer: use whatever the canonical positions projector uses; document the lag if it matters in practice.
- **Per-strategy `max_hold_seconds` vs per-position.** Current spec puts `max_hold_seconds` at per-position only. A strategy-level "close everything after N hours" is reasonable but not in the v1 schema. Adding it later is additive.
- **Composite definition under operator manual edits.** If the operator manually liquidates one leg of a composite, does the remaining leg keep the composite's stop-loss trigger? Current spec: yes — the composite trips on the remaining leg(s) at re-eval. Operator's responsibility to close all legs if they intend to flatten the composite.
