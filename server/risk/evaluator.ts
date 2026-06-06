// ── Cross-strategy aggregate gate evaluator ──────────────────────────
//
// Pure-function evaluator consumed by the gate-RPC handler (QF-315)
// and (per QF-304's backtest-gate.md design) the backtest-gate TS CLI.
// All inputs flow through arguments — no DB queries, no NATS, no
// process state — so the same function runs in live and in replay.
//
// Implements the §3.3 RejectionReason enum from
// docs/tdd/risk-gate-architecture.md:
//   - limit_exceeded_per_strategy  : strategy-scoped qty / notional / delta
//   - limit_exceeded_aggregate     : cross-strategy delta / vega / notional
//   - limit_exceeded_portfolio     : drawdown / daily-loss halt
//   - strategy_halted              : operator-halted via lifecycle registry
//   - concentration                : per-underlying delta concentration
//   - config_invalid               : caller asked us to eval with missing
//                                    portfolio/strategy snapshots
//
// Decision precedence: portfolio-halt > strategy-halt > config-invalid >
// per-strategy > aggregate > concentration. First miss wins; we don't
// enumerate every failure.
//
// QF-317.

import type { OrderIntent } from "../../src/types/order.js";
import type { GateEvaluation, GateRequest, GateEvaluator } from "./gate-handler.js";
import type { PendingIntentsStore, PendingIntent } from "./pending-intents.js";

// ── Snapshot shapes (decouple from engine internals) ─────────────────

// Per-strategy limits read from risk_limits.yaml or per-strategy config.
export interface StrategyLimits {
  max_quantity?: number;
  max_notional?: number;
  max_delta?: number;
}

export interface PortfolioLimits {
  max_aggregate_delta?: number;
  max_aggregate_vega?: number;
  max_aggregate_notional?: number;
  max_underlying_concentration?: number;
}

export interface PortfolioSnapshot {
  portfolio_id: string;
  halted: boolean;
  net_delta: number;
  net_vega: number;
  net_notional: number;
  // Per-underlying delta sum (positions only; pending is added by the
  // evaluator).
  delta_by_underlying: Record<string, number>;
}

export interface StrategySnapshot {
  strategy_id: string;
  // Mirrors LifecycleState in server/strategy/lifecycle.ts. The
  // evaluator only branches on 'halted'; other states are normal.
  state: "registered" | "enabled" | "running" | "paused" | "halted" | "retired";
}

export interface EvaluatorInput {
  request: GateRequest;
  portfolio: PortfolioSnapshot | null;
  strategy: StrategySnapshot | null;
  strategyLimits: StrategyLimits | null;
  portfolioLimits: PortfolioLimits | null;
  // Active pending intents on this portfolio (status='pending' only),
  // pre-filtered by the closure that wraps this pure function.
  pendingIntents: PendingIntent[];
}

// ── Pure evaluator ────────────────────────────────────────────────────

export function evaluateGate(input: EvaluatorInput): GateEvaluation {
  const { request, portfolio, strategy, strategyLimits, portfolioLimits, pendingIntents } = input;

  // 1. Portfolio halt — highest precedence. A halted portfolio rejects
  //    everything until the operator resets, regardless of strategy.
  if (portfolio?.halted) {
    return { decision: "reject", reason: "limit_exceeded_portfolio" };
  }

  // 2. Strategy halt — operator paused this strategy specifically.
  if (strategy?.state === "halted") {
    return { decision: "reject", reason: "strategy_halted" };
  }

  // 3. Config invariants. Missing snapshots indicate a coordination
  //    bug between the gate handler and the live state; we don't
  //    silently approve under degraded inputs.
  if (!portfolio || !strategy) {
    return { decision: "reject", reason: "config_invalid" };
  }

  // 4. Per-strategy limits. These bound a single strategy's individual
  //    submissions; cross-strategy aggregates are checked below.
  if (strategyLimits) {
    const perStrategyMiss = checkPerStrategy(request.intent, strategyLimits);
    if (perStrategyMiss) return perStrategyMiss;
  }

  // 5. Cross-strategy aggregates. Sum settled portfolio state +
  //    in-flight pending intents (across ALL strategies on the
  //    portfolio) + this proposed intent's contribution.
  if (portfolioLimits) {
    const aggMiss = checkAggregates(request.intent, portfolio, pendingIntents, portfolioLimits);
    if (aggMiss) return aggMiss;
  }

  // 6. Per-underlying concentration. Separate from aggregates so the
  //    reason is distinguishable.
  if (portfolioLimits?.max_underlying_concentration !== undefined) {
    const concMiss = checkConcentration(
      request.intent,
      portfolio,
      pendingIntents,
      portfolioLimits.max_underlying_concentration,
    );
    if (concMiss) return concMiss;
  }

  return { decision: "approve", reason: null };
}

// ── Per-strategy checks ───────────────────────────────────────────────

function checkPerStrategy(intent: OrderIntent, lim: StrategyLimits): GateEvaluation | null {
  if (lim.max_quantity !== undefined && intent.quantity > lim.max_quantity) {
    return { decision: "reject", reason: "limit_exceeded_per_strategy" };
  }
  // Estimated notional uses limit_price when present (limit orders) or
  // skips the check otherwise — pure evaluator can't fetch market data.
  if (lim.max_notional !== undefined && intent.limit_price !== undefined) {
    const notional = intent.quantity * intent.limit_price;
    if (notional > lim.max_notional) {
      return { decision: "reject", reason: "limit_exceeded_per_strategy" };
    }
  }
  // Delta uses a coarse +/-1 sign × qty proxy when no per-position
  // delta is provided by the request. Caller can extend GateRequest
  // with estimated_delta to override.
  if (lim.max_delta !== undefined) {
    const proposedDelta = (intent.direction === "Long" ? 1 : -1) * intent.quantity;
    if (Math.abs(proposedDelta) > lim.max_delta) {
      return { decision: "reject", reason: "limit_exceeded_per_strategy" };
    }
  }
  return null;
}

// ── Aggregate checks ──────────────────────────────────────────────────

function checkAggregates(
  intent: OrderIntent,
  portfolio: PortfolioSnapshot,
  pending: PendingIntent[],
  lim: PortfolioLimits,
): GateEvaluation | null {
  // Sum settled + in-flight + proposed delta.
  if (lim.max_aggregate_delta !== undefined) {
    const proposedDelta = signedQuantity(intent);
    const pendingDelta = sumPendingDelta(pending);
    const total = Math.abs(portfolio.net_delta + pendingDelta + proposedDelta);
    if (total > lim.max_aggregate_delta) {
      return { decision: "reject", reason: "limit_exceeded_aggregate" };
    }
  }
  if (lim.max_aggregate_notional !== undefined) {
    const proposedNotional = intent.limit_price ? intent.quantity * intent.limit_price : 0;
    const pendingNotional = pending.reduce((s, p) => s + p.estimated_notional, 0);
    const total = portfolio.net_notional + pendingNotional + proposedNotional;
    if (total > lim.max_aggregate_notional) {
      return { decision: "reject", reason: "limit_exceeded_aggregate" };
    }
  }
  // Aggregate vega has no proposed-side contribution from a single
  // intent without market data; we sum settled + pending only. The
  // gate plugin's mechanical floor is the per-order vega backstop.
  if (lim.max_aggregate_vega !== undefined) {
    const pendingVega = 0; // pending-intents tracks notional + delta only at v1
    if (Math.abs(portfolio.net_vega + pendingVega) > lim.max_aggregate_vega) {
      return { decision: "reject", reason: "limit_exceeded_aggregate" };
    }
  }
  return null;
}

// ── Concentration check ───────────────────────────────────────────────

function checkConcentration(
  intent: OrderIntent,
  portfolio: PortfolioSnapshot,
  pending: PendingIntent[],
  threshold: number,
): GateEvaluation | null {
  const underlying = canonicalToUnderlying(intent.symbol);
  const settled = portfolio.delta_by_underlying[underlying] ?? 0;
  const pendingForUnderlying = pending
    .filter((p) => canonicalToUnderlying(p.symbol) === underlying)
    .reduce((s, p) => s + signedQuantityFromPending(p), 0);
  const proposed = signedQuantity(intent);
  const total = Math.abs(settled + pendingForUnderlying + proposed);
  if (total > threshold) {
    return { decision: "reject", reason: "concentration" };
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────

function signedQuantity(intent: OrderIntent): number {
  return (intent.direction === "Long" ? 1 : -1) * intent.quantity;
}

function signedQuantityFromPending(p: PendingIntent): number {
  return (p.side === "buy" ? 1 : -1) * p.remaining_qty;
}

function sumPendingDelta(pending: PendingIntent[]): number {
  let acc = 0;
  for (const p of pending) {
    acc += p.estimated_delta || signedQuantityFromPending(p);
  }
  return acc;
}

// Strip an OPT canonical symbol back to its underlying. e.g.
// "OPT:SPY:2026-06-19:C:500" → "SPY"; equity symbols pass through.
export function canonicalToUnderlying(symbol: string): string {
  if (symbol.startsWith("OPT:") || symbol.startsWith("FUT:")) {
    const parts = symbol.split(":");
    return parts[1] ?? symbol;
  }
  return symbol;
}

// ── Live wrapper (consumed by gate-handler) ──────────────────────────
//
// Closes over the engine + lifecycle + pending-intents store and reads
// fresh snapshots on each evaluate() call. The pure function stays in
// evaluateGate; this wrapper is the only place that knows about the
// live state surface.

export interface AggregateEvaluatorDeps {
  // Snapshot fetchers — the live wiring resolves these from
  // PortfolioEngine + StrategyStore. Closures return null when the
  // resource isn't found (e.g. unknown portfolio_id from the request).
  getPortfolioSnapshot: (portfolioId: string) => PortfolioSnapshot | null;
  getStrategySnapshot: (strategyId: string) => StrategySnapshot | null;
  getStrategyLimits: (strategyId: string) => StrategyLimits | null;
  getPortfolioLimits: (portfolioId: string) => PortfolioLimits | null;
  pendingIntents: PendingIntentsStore;
}

export function createAggregateEvaluator(deps: AggregateEvaluatorDeps): GateEvaluator {
  return {
    evaluate(req: GateRequest, _intentId: string): GateEvaluation {
      const portfolio = deps.getPortfolioSnapshot(req.portfolio_id);
      const strategy = deps.getStrategySnapshot(req.strategy_id);
      const strategyLimits = deps.getStrategyLimits(req.strategy_id);
      const portfolioLimits = deps.getPortfolioLimits(req.portfolio_id);
      const pendingIntents = deps.pendingIntents.getActiveForPortfolio(req.portfolio_id);
      return evaluateGate({
        request: req,
        portfolio,
        strategy,
        strategyLimits,
        portfolioLimits,
        pendingIntents,
      });
    },
  };
}
