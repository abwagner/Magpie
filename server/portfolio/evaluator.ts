// ── Portfolio Risk Evaluator ─────────────────────────────────────────
// Pure function: no I/O, no NATS, no DB.
// (intent, portfolioState, riskLimits, pendingOrders) → RiskCheckResult
//
// Extracted from server/portfolio/engine.ts as Phase D / P1 of the
// backtest-gate initiative (docs/tdd/backtest-gate.md §10). Both the
// live NATS-RPC gate handler and the CLI binary import this module so
// there is exactly one evaluation function that ships in two wrappers.

import type { OrderIntent, RiskCheckResult, Violation } from "../../src/types/order.js";
import type { PortfolioState, RiskLimits } from "../../src/types/portfolio.js";
import { canonicalToUnderlying } from "../symbols/convert.js";

// ── Public surface ─────────────────────────────────────────────────

/**
 * Evaluate whether an order intent is permitted given the current
 * portfolio state, risk limits, and pending-order count.
 *
 * @param intent        The order being evaluated.
 * @param state         Current portfolio snapshot (positions, cash, etc.).
 * @param riskLimits    Active limits; null means no limits (allow all).
 * @param pendingOrders Count of orders already in-flight for this portfolio.
 */
export function evaluate(
  intent: OrderIntent,
  state: PortfolioState,
  riskLimits: RiskLimits | null,
  pendingOrders: number,
): RiskCheckResult {
  const violations: Violation[] = [];

  if (state.halted) {
    violations.push({
      limit: "portfolio_halted",
      current: 1,
      proposed: 1,
      threshold: 0,
      action: "reject",
    });
    return { ok: false, violations };
  }

  if (!riskLimits) return { ok: true, violations: [] };

  // Max order size
  if (riskLimits.max_order_size !== null && intent.quantity > riskLimits.max_order_size) {
    violations.push({
      limit: "max_order_size",
      current: 0,
      proposed: intent.quantity,
      threshold: riskLimits.max_order_size,
      action: "reject",
    });
  }

  // Max open orders
  if (riskLimits.max_open_orders !== null && pendingOrders >= riskLimits.max_open_orders) {
    violations.push({
      limit: "max_open_orders",
      current: pendingOrders,
      proposed: pendingOrders + 1,
      threshold: riskLimits.max_open_orders,
      action: "reject",
    });
  }

  // Forward-looking delta check
  // Approximate: assume delta of 1 for equity; real greeks needed for options.
  if (riskLimits.max_net_delta !== null) {
    const proposedDelta =
      state.net_delta + (intent.direction === "Long" ? 1 : -1) * intent.quantity;
    if (Math.abs(proposedDelta) > riskLimits.max_net_delta) {
      violations.push({
        limit: "max_net_delta",
        current: state.net_delta,
        proposed: proposedDelta,
        threshold: riskLimits.max_net_delta,
        action: "reject",
      });
    }
  }

  // Per-symbol concentration
  if (riskLimits.max_symbol_concentration !== null) {
    const underlying = canonicalToUnderlying(intent.symbol);
    let symbolDelta = 0;
    for (const pos of state.positions) {
      if (pos.underlying === underlying) {
        const sign = pos.direction === "Long" ? 1 : -1;
        symbolDelta += pos.delta * pos.quantity * sign;
      }
    }
    const proposedSymbolDelta =
      symbolDelta + (intent.direction === "Long" ? 1 : -1) * intent.quantity;
    if (Math.abs(proposedSymbolDelta) > riskLimits.max_symbol_concentration) {
      violations.push({
        limit: "max_symbol_concentration",
        current: symbolDelta,
        proposed: proposedSymbolDelta,
        threshold: riskLimits.max_symbol_concentration,
        action: "reject",
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
