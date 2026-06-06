// ── Manual Position Liquidation ────────────────────────────────────
// Operator-initiated close of one or more framework positions, per
// docs/tdd/order-execution.md §5.2. Resolves a position_id to its live
// state, expands composites to their atomic legs, and submits one
// closing OrderIntent per leg through OPL (action "close", reason
// "operator_manual").
//
// This is the operator counterpart to the framework-side exit-rule
// monitor (QF-321): both emit closing intents through the same OPL
// submit() path; this one is triggered by a human, not a rule.
//
// Defined in: QF-323.

import type { OrderIntent, Order } from "../../src/types/order.js";
import type { Logger } from "../logger.js";

// Sentinel strategy_id for operator-originated closes so audit
// aggregations don't drop the close rows (matches the exit-rule
// monitor's OPERATOR_STRATEGY_ID).
export const OPERATOR_STRATEGY_ID = "__operator__";

// The minimal position shape liquidation needs. Sourced from the
// portfolio engine's live projector; strategy_id/composite_id are
// optional because the canonical projector's attribution path may not
// have tagged the row yet (operator close still works — it defaults to
// the operator sentinel).
export interface LiquidatablePosition {
  position_id: string;
  portfolio: string;
  symbol: string;
  direction: "Long" | "Short";
  quantity: number;
  strategy_id?: string;
  composite_id?: string | null;
}

export interface LiquidationDeps {
  // Resolve a position_id to its current state across all portfolios,
  // or null if unknown / already flat.
  resolvePosition: (positionId: string) => LiquidatablePosition | null;
  // Expand a composite to all its atomic legs (including the seed). The
  // default (when omitted) treats the position as atomic — until the
  // projector tags composite_id, an operator liquidates legs by
  // explicit multi-select instead.
  expandComposite?: (seed: LiquidatablePosition) => LiquidatablePosition[];
  submit: (intent: OrderIntent) => Promise<Order>;
  newId: () => string;
  now: () => string;
  logger: Logger;
}

export interface LiquidationOutcome {
  position_id: string;
  status: "submitted" | "not_found" | "error";
  intent_id?: string;
  order_id?: string;
  order_status?: string;
  error?: string;
}

// Liquidate the given positions. Composite legs are expanded and
// deduplicated, so requesting two legs of the same composite (or the
// same id twice) submits each atomic leg exactly once. Per-leg failures
// are isolated — one rejected submit doesn't abort the others.
export async function liquidatePositions(
  deps: LiquidationDeps,
  positionIds: string[],
): Promise<LiquidationOutcome[]> {
  const outcomes: LiquidationOutcome[] = [];
  const submitted = new Set<string>();

  for (const requestedId of positionIds) {
    const seed = deps.resolvePosition(requestedId);
    if (!seed) {
      deps.logger.warn("liquidate_position_not_found", { position_id: requestedId });
      outcomes.push({ position_id: requestedId, status: "not_found" });
      continue;
    }
    const legs = deps.expandComposite ? deps.expandComposite(seed) : [seed];
    for (const leg of legs) {
      if (submitted.has(leg.position_id)) continue;
      submitted.add(leg.position_id);
      outcomes.push(await liquidateLeg(deps, leg));
    }
  }
  return outcomes;
}

async function liquidateLeg(
  deps: LiquidationDeps,
  leg: LiquidatablePosition,
): Promise<LiquidationOutcome> {
  const intent = buildClosingIntent(deps, leg);
  try {
    const order = await deps.submit(intent);
    deps.logger.info("liquidate_position_submitted", {
      position_id: leg.position_id,
      composite_id: leg.composite_id ?? null,
      intent_id: intent.intent_id,
      order_id: order.order_id,
      order_status: order.status,
    });
    return {
      position_id: leg.position_id,
      status: "submitted",
      intent_id: intent.intent_id,
      order_id: order.order_id,
      order_status: order.status,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.error("liquidate_position_failed", {
      position_id: leg.position_id,
      error: message,
    });
    return { position_id: leg.position_id, status: "error", error: message };
  }
}

function buildClosingIntent(deps: LiquidationDeps, leg: LiquidatablePosition): OrderIntent {
  return {
    intent_id: deps.newId(),
    portfolio: leg.portfolio,
    strategy_id: leg.strategy_id ?? OPERATOR_STRATEGY_ID,
    action: "close",
    symbol: leg.symbol,
    direction: "close",
    quantity: leg.quantity,
    reason: "operator_manual",
    signal_ids: [],
    position_id: leg.position_id,
    created_at: deps.now(),
  };
}
