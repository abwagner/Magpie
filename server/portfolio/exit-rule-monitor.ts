// ── Exit-Rule Monitor ──────────────────────────────────────────────
// Framework-side enforcement of strategy-declared hard exits. Strategies
// declare stop_loss / target / max_hold (per-position) and max_drawdown
// (per-strategy) at registration time; this monitor evaluates them
// against the canonical positions projector and emits closing
// OrderIntents through OPL when one trips.
//
// The monitor exists so a hung strategy can't suppress its own stop:
// rule evaluation lives in the QF TS process, independent of strategy
// code running in NT.
//
// Defined in: docs/tdd/exit-rule-monitor.md (QF-320) + QF-321.

import type { Position, PositionUpdate } from "../../src/types/portfolio.js";
import type { OrderIntent } from "../../src/types/order.js";
import type { Logger } from "../logger.js";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

// ── Rule schema ─────────────────────────────────────────────────────

export interface StrategyExitPolicy {
  per_position: {
    // Composite unrealized PnL ≤ -stop_loss_pct × entry_notional.
    stop_loss_pct?: number;
    // Composite unrealized PnL ≥ target_pct × entry_notional.
    target_pct?: number;
    // Composite open (MIN opened_at) ≥ max_hold_seconds.
    max_hold_seconds?: number;
  };
  per_strategy: {
    // Strategy drawdown from high-water mark ≥ max_drawdown_pct of
    // deployed notional. Trip closes ALL the strategy's positions.
    max_drawdown_pct?: number;
  };
}

export type ExitRuleName = "stop_loss" | "target" | "max_hold" | "max_drawdown";

// One rule's outcome for a strategy's position group, surfaced for the
// GUI per-strategy panel (QF-322) and for trip auditing.
export interface ExitRuleEvaluation {
  strategy_id: string;
  // Atomic legs the trip would close. For per-position rules this is the
  // composite's legs; for max_drawdown it is every position the strategy
  // owns.
  position_ids: string[];
  composite_id: string | null;
  rule: ExitRuleName;
  threshold: number;
  actual: number;
  // (threshold - actual) / |threshold|, the GUI "headroom" metric. A
  // smaller value is closer to tripping; ≤ 0 means tripped.
  headroom_pct: number;
  tripped: boolean;
  asof: string;
}

// The `__operator__` sentinel tags operator-originated positions so
// audit aggregations don't drop their close rows. Such positions have no
// strategy-declared rules — the monitor skips them.
export const OPERATOR_STRATEGY_ID = "__operator__";

// ── Metrics ─────────────────────────────────────────────────────────

export interface ExitRuleMetrics {
  registry: Registry;
  tripsTotal: Counter<"strategy_id" | "rule">;
  headroomPct: Gauge<"strategy_id" | "position_id" | "rule">;
  evaluationDurationMs: Histogram<"strategy_id">;
}

export function createExitRuleMetrics(): ExitRuleMetrics {
  const registry = new Registry();
  const tripsTotal = new Counter({
    name: "exit_rule_trips_total",
    help: "Total times each exit rule fired.",
    labelNames: ["strategy_id", "rule"] as const,
    registers: [registry],
  });
  const headroomPct = new Gauge({
    name: "exit_rule_headroom_pct",
    help: "Current (threshold - actual) / |threshold| ratio per armed rule.",
    labelNames: ["strategy_id", "position_id", "rule"] as const,
    registers: [registry],
  });
  const evaluationDurationMs = new Histogram({
    name: "exit_rule_evaluation_duration_ms",
    help: "Time spent in one eval cycle per strategy.",
    labelNames: ["strategy_id"] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 50],
    registers: [registry],
  });
  return { registry, tripsTotal, headroomPct, evaluationDurationMs };
}

// ── Monitor ─────────────────────────────────────────────────────────

// ── QF-351 — WS push callbacks ──────────────────────────────────────
// Injected at construction time and called after each eval pass so the
// /ws/state stream receives position_exit_rule trip events,
// exit_rule_tripped alerts, and strategy_update messages with headroom.
// All three are optional; omitting them leaves the monitor fully
// functional (useful in tests that don't exercise the WS layer).

export interface ExitRuleTripEvent {
  position_id: string;
  rule: ExitRuleName;
  closing_intent_id: string;
  strategy_id: string;
}

export interface ExitRuleMonitorDeps {
  logger: Logger;
  metrics: ExitRuleMetrics;
  // Policy for a strategy, or undefined when none is declared (no
  // framework-enforced exits).
  getPolicy: (strategyId: string) => StrategyExitPolicy | undefined;
  // True if the strategy is retired — skip evaluation (positions are
  // operator-liquidation-only at that point).
  isStrategyRetired?: (strategyId: string) => boolean;
  // Submit a closing intent. Resolves on accept, throws on reject; the
  // monitor leaves closing_intent_id unset on throw so a later tick
  // re-emits.
  submitClosingIntent: (intent: OrderIntent) => Promise<void>;
  newIntentId: () => string;
  now?: () => number;
  // QF-351 — push the position_exit_rule WS event for each leg closed.
  onTripEvent?: (event: ExitRuleTripEvent) => void;
  // QF-351 — push an exit_rule_tripped alert when any rule fires.
  onTripAlert?: (strategyId: string, rule: ExitRuleName) => void;
  // QF-351 — push strategy_update with exit_rules[] headroom after each
  // full eval pass for a strategy. Called once per strategy per eval tick
  // with all armed rules' evaluations for that strategy.
  onEvalComplete?: (strategyId: string, evals: ExitRuleEvaluation[]) => void;
}

export interface ExitRuleMonitor {
  // Sync subscription hook wired to the portfolio engine. Fire-and-
  // forget; the async eval is run with a catch boundary so a throwing
  // cycle can't take the engine's update path down.
  onPositionUpdate(update: PositionUpdate): void;
  // Awaitable eval — used by tests and internally by onPositionUpdate.
  // Returns every rule's evaluation for the pass (tripped + headroom).
  evaluate(update: PositionUpdate): Promise<ExitRuleEvaluation[]>;
  highWaterMark(strategyId: string): number | undefined;
}

// A composite group (or atomic singleton) of a strategy's legs.
interface PositionGroup {
  composite_id: string | null;
  legs: Position[];
}

export function createExitRuleMonitor(deps: ExitRuleMonitorDeps): ExitRuleMonitor {
  const now = deps.now ?? (() => Date.now());
  // Per-strategy high-water mark of (unrealized) equity. Internal state;
  // survives across eval passes. Reset only via strategy retire/re-
  // register (operator lifecycle), not by the monitor.
  const highWaterMarks = new Map<string, number>();

  function onPositionUpdate(update: PositionUpdate): void {
    void evaluate(update).catch((err: unknown) => {
      deps.logger.error("exit_rule_evaluator_threw", {
        portfolio: update.portfolio,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async function evaluate(update: PositionUpdate): Promise<ExitRuleEvaluation[]> {
    const byStrategy = groupByStrategy(update.positions);
    const evaluations: ExitRuleEvaluation[] = [];
    for (const [strategyId, positions] of byStrategy) {
      const policy = deps.getPolicy(strategyId);
      if (!policy) continue;
      if (deps.isStrategyRetired?.(strategyId)) continue;
      const started = now();
      const strategyEvals = await evaluateStrategy(strategyId, policy, positions, update);
      evaluations.push(...strategyEvals);
      deps.metrics.evaluationDurationMs.observe({ strategy_id: strategyId }, now() - started);
    }
    return evaluations;
  }

  // Eligible positions only: skip un-attributed + operator-originated.
  function groupByStrategy(positions: Position[]): Map<string, Position[]> {
    const out = new Map<string, Position[]>();
    for (const pos of positions) {
      const sid = pos.strategy_id;
      if (!sid || sid === OPERATOR_STRATEGY_ID) continue;
      const list = out.get(sid);
      if (list) list.push(pos);
      else out.set(sid, [pos]);
    }
    return out;
  }

  async function evaluateStrategy(
    strategyId: string,
    policy: StrategyExitPolicy,
    positions: Position[],
    update: PositionUpdate,
  ): Promise<ExitRuleEvaluation[]> {
    const evals: ExitRuleEvaluation[] = [];
    for (const group of toGroups(positions)) {
      evals.push(...(await evaluatePerPosition(strategyId, policy, group, update)));
    }
    const dd = evaluateDrawdown(strategyId, policy, positions, update.asof);
    if (dd) {
      evals.push(dd);
      if (dd.tripped) await emitCloses(strategyId, positions, "max_drawdown", update);
    }
    // QF-351 — notify the WS layer with per-strategy headroom so
    // strategy_update.data.exit_rules[] can be pushed to connected clients.
    if (evals.length > 0) deps.onEvalComplete?.(strategyId, evals);
    return evals;
  }

  async function evaluatePerPosition(
    strategyId: string,
    policy: StrategyExitPolicy,
    group: PositionGroup,
    update: PositionUpdate,
  ): Promise<ExitRuleEvaluation[]> {
    const p = policy.per_position;
    const agg = aggregate(group.legs);
    if (agg === null) {
      deps.logger.debug("exit_rule_eval_skipped", {
        reason: "no_quote",
        strategy_id: strategyId,
        composite_id: group.composite_id,
      });
      return [];
    }
    const holdSeconds = agg.openedAtMs === null ? 0 : (now() - agg.openedAtMs) / 1000;
    const candidates: ExitRuleEvaluation[] = [];
    if (p.stop_loss_pct !== undefined)
      candidates.push(
        mkEval(strategyId, group, "stop_loss", -p.stop_loss_pct, agg.pnlPct, update.asof),
      );
    if (p.target_pct !== undefined)
      candidates.push(
        mkEval(strategyId, group, "target", p.target_pct, agg.pnlPct, update.asof, true),
      );
    if (p.max_hold_seconds !== undefined)
      candidates.push(
        mkEval(strategyId, group, "max_hold", p.max_hold_seconds, holdSeconds, update.asof, true),
      );
    for (const ev of candidates) {
      publishHeadroom(ev);
      if (ev.tripped) await emitCloses(strategyId, group.legs, ev.rule, update);
    }
    return candidates;
  }

  function evaluateDrawdown(
    strategyId: string,
    policy: StrategyExitPolicy,
    positions: Position[],
    asof: string,
  ): ExitRuleEvaluation | null {
    const threshold = policy.per_strategy.max_drawdown_pct;
    if (threshold === undefined) return null;
    const equity = positions.reduce((s, p) => s + p.unrealized_pnl, 0);
    const hwm = Math.max(highWaterMarks.get(strategyId) ?? equity, equity);
    highWaterMarks.set(strategyId, hwm);
    const notional = positions.reduce((s, p) => s + Math.abs(p.entry_price * p.quantity), 0);
    // Drawdown as a fraction of deployed notional. TDD §3 leaves the
    // denominator unspecified; deployed notional is the stable choice
    // (HWM is a PnL delta that can be ~0 and would blow up a ratio).
    const drawdownPct = notional > 0 ? (hwm - equity) / notional : 0;
    const ev = mkEval(
      strategyId,
      { composite_id: null, legs: positions },
      "max_drawdown",
      threshold,
      drawdownPct,
      asof,
      true,
    );
    publishHeadroom(ev);
    return ev;
  }

  // Emit one closing intent per atomic leg with a null closing_intent_id,
  // in parallel. Each sets its own guard on success; a rejected submit
  // leaves the guard unset so a later tick re-emits.
  async function emitCloses(
    strategyId: string,
    legs: Position[],
    rule: ExitRuleName,
    update: PositionUpdate,
  ): Promise<void> {
    deps.metrics.tripsTotal.inc({ strategy_id: strategyId, rule });
    const pending = legs.filter((leg) => !leg.closing_intent_id);
    await Promise.all(pending.map((leg) => emitOne(strategyId, leg, rule, update)));
  }

  async function emitOne(
    strategyId: string,
    leg: Position,
    rule: ExitRuleName,
    update: PositionUpdate,
  ): Promise<void> {
    const intentId = deps.newIntentId();
    const intent: OrderIntent = {
      intent_id: intentId,
      portfolio: update.portfolio,
      strategy_id: strategyId,
      action: "close",
      symbol: leg.symbol,
      direction: "close",
      quantity: leg.quantity,
      reason: `exit_rule_${rule}`,
      signal_ids: [],
      position_id: leg.position_id,
      created_at: update.asof,
    };
    try {
      await deps.submitClosingIntent(intent);
      leg.closing_intent_id = intentId;
      deps.logger.info("exit_rule_close_emitted", {
        strategy_id: strategyId,
        rule,
        position_id: leg.position_id,
        composite_id: leg.composite_id ?? null,
        intent_id: intentId,
      });
      // QF-351 — push position_exit_rule WS event so the GUI can render
      // the in-flight closing banner. Push alert once per rule trip;
      // batching by rule (not per leg) would under-alert for multi-leg
      // composites — callers dedupe if needed.
      deps.onTripEvent?.({
        position_id: leg.position_id,
        rule,
        closing_intent_id: intentId,
        strategy_id: strategyId,
      });
      deps.onTripAlert?.(strategyId, rule);
    } catch (err: unknown) {
      deps.logger.error("exit_rule_emit_failed", {
        strategy_id: strategyId,
        rule,
        position_id: leg.position_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function publishHeadroom(ev: ExitRuleEvaluation): void {
    const positionId = ev.composite_id ?? ev.position_ids[0] ?? "unknown";
    deps.metrics.headroomPct.set(
      { strategy_id: ev.strategy_id, position_id: positionId, rule: ev.rule },
      ev.headroom_pct,
    );
  }

  function highWaterMark(strategyId: string): number | undefined {
    return highWaterMarks.get(strategyId);
  }

  return { onPositionUpdate, evaluate, highWaterMark };
}

// ── Pure helpers ────────────────────────────────────────────────────

// Group a strategy's legs by composite_id; atomic positions (null
// composite_id) are their own singleton group keyed by position_id.
function toGroups(positions: Position[]): PositionGroup[] {
  const composites = new Map<string, Position[]>();
  const groups: PositionGroup[] = [];
  for (const pos of positions) {
    if (pos.composite_id) {
      const legs = composites.get(pos.composite_id);
      if (legs) legs.push(pos);
      else {
        const fresh = [pos];
        composites.set(pos.composite_id, fresh);
        groups.push({ composite_id: pos.composite_id, legs: fresh });
      }
    } else {
      groups.push({ composite_id: null, legs: [pos] });
    }
  }
  return groups;
}

interface Aggregate {
  pnlPct: number;
  // MIN(opened_at) across legs in epoch ms, or null when no leg has a
  // parseable entry_date (max_hold then treats hold as 0 — no trip).
  openedAtMs: number | null;
}

// Composite P&L: SUM(unrealized) / SUM(entry_notional), MIN(opened_at).
// Returns null when a leg has an unusable quote (NaN PnL) or the group
// has zero notional — the caller skips and the next tick re-evaluates.
function aggregate(legs: Position[]): Aggregate | null {
  let pnl = 0;
  let notional = 0;
  let openedAtMs = Infinity;
  for (const leg of legs) {
    if (!Number.isFinite(leg.unrealized_pnl)) return null;
    pnl += leg.unrealized_pnl;
    notional += Math.abs(leg.entry_price * leg.quantity);
    const opened = Date.parse(leg.entry_date);
    if (Number.isFinite(opened) && opened < openedAtMs) openedAtMs = opened;
  }
  if (notional === 0) return null;
  return { pnlPct: pnl / notional, openedAtMs: openedAtMs === Infinity ? null : openedAtMs };
}

// Build an evaluation. `tripWhenAtOrAbove` flips the comparison: target,
// max_hold and max_drawdown trip when actual ≥ threshold; stop_loss
// trips when actual ≤ threshold (a negative threshold).
function mkEval(
  strategyId: string,
  group: PositionGroup,
  rule: ExitRuleName,
  threshold: number,
  actual: number,
  asof: string,
  tripWhenAtOrAbove = false,
): ExitRuleEvaluation {
  const tripped = tripWhenAtOrAbove ? actual >= threshold : actual <= threshold;
  const denom = Math.abs(threshold);
  const headroom = denom === 0 ? 0 : (threshold - actual) / denom;
  return {
    strategy_id: strategyId,
    position_ids: group.legs.map((l) => l.position_id),
    composite_id: group.composite_id,
    rule,
    threshold,
    actual,
    headroom_pct: tripWhenAtOrAbove ? headroom : -headroom,
    tripped,
    asof,
  };
}
