// ── Portfolio & Risk Engine ────────────────────────────────────────
// Maintains live portfolio state, evaluates risk continuously.
// Defined in: docs/tdd/portfolio-risk-engine.md

import type {
  PortfolioState,
  RiskLimits,
  PortfolioConfig,
  PortfolioSnapshot,
  PositionUpdate,
} from "../../src/types/portfolio.js";
import type { Fill, OrderIntent, RiskCheckResult } from "../../src/types/order.js";
import { canonicalToUnderlying } from "../symbols/convert.js";
import type { Logger } from "../logger.js";
import { evaluate } from "./evaluator.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PortfolioEngineDeps {
  logger: Logger;
  greeks?: GreeksCalculator;
  onSnapshot?: (snapshot: PortfolioSnapshot) => void;
  // QF-321 — fired after every recompute (per-fill + per-quote-tick) so
  // the exit-rule monitor can evaluate active rules against the live
  // projector state. Passed the live positions array (mutable refs — the
  // monitor sets closing_intent_id in place).
  onPositionUpdate?: (update: PositionUpdate) => void;
}

export interface GreeksCalculator {
  delta(spot: number, strike: number, rfr: number, dte: number, iv: number, type: string): number;
  gamma(spot: number, strike: number, rfr: number, dte: number, iv: number): number;
  theta(spot: number, strike: number, rfr: number, dte: number, iv: number, type: string): number;
  vega(spot: number, strike: number, rfr: number, dte: number, iv: number): number;
}

export interface PortfolioEngine {
  getState(portfolioId: string): PortfolioState;
  canExecute(portfolioId: string, intent: OrderIntent): RiskCheckResult;
  applyFill(portfolioId: string, fill: Fill): void;
  initPortfolio(portfolioId: string, config: PortfolioConfig): void;
  updateQuote(portfolioId: string, symbol: string, spot: number): void;
  resetDaily(portfolioId: string): void;
  resetHalt(portfolioId: string): void;
  halt(portfolioId: string, reason: string): void;
}

// ── Implementation ─────────────────────────────────────────────────

export function createPortfolioEngine(deps: PortfolioEngineDeps): PortfolioEngine {
  const logger = deps.logger;
  const portfolios = new Map<string, PortfolioState>();
  const limits = new Map<string, RiskLimits>();
  const pendingOrders = new Map<string, number>(); // portfolioId → count

  function ensurePortfolio(portfolioId: string): PortfolioState {
    const state = portfolios.get(portfolioId);
    if (!state) throw new Error(`Portfolio not initialized: ${portfolioId}`);
    return state;
  }

  function recomputeAggregates(state: PortfolioState): void {
    let netDelta = 0;
    let netVega = 0;
    let totalUnrealized = 0;

    for (const pos of state.positions) {
      const sign = pos.direction === "Long" ? 1 : -1;
      netDelta += pos.delta * pos.quantity * sign;
      netVega += pos.vega * pos.quantity * sign;
      totalUnrealized += pos.unrealized_pnl;
    }

    state.net_delta = netDelta;
    state.net_vega = netVega;
    state.total_unrealized_pnl = totalUnrealized;
    state.equity = state.cash + totalUnrealized;

    if (state.equity > state.peak_equity) {
      state.peak_equity = state.equity;
    }
    state.drawdown = state.peak_equity - state.equity;
  }

  function checkHaltConditions(portfolioId: string, state: PortfolioState): void {
    const lim = limits.get(portfolioId);
    if (!lim) return;

    if (lim.max_daily_loss !== null && state.daily_realized_pnl < -lim.max_daily_loss) {
      state.halted = true;
      state.halt_reason = `Daily loss ${state.daily_realized_pnl.toFixed(2)} exceeds limit ${lim.max_daily_loss}`;
      logger.warn("Portfolio halted: daily loss limit", {
        portfolioId,
        daily_pnl: state.daily_realized_pnl,
      });
    }

    if (lim.max_drawdown !== null && state.drawdown > lim.max_drawdown) {
      state.halted = true;
      state.halt_reason = `Drawdown ${state.drawdown.toFixed(2)} exceeds limit ${lim.max_drawdown}`;
      logger.warn("Portfolio halted: drawdown limit", { portfolioId, drawdown: state.drawdown });
    }
  }

  function emitPositionUpdate(portfolioId: string): void {
    if (!deps.onPositionUpdate) return;
    const state = ensurePortfolio(portfolioId);
    deps.onPositionUpdate({
      portfolio: portfolioId,
      positions: state.positions,
      asof: new Date().toISOString(),
    });
  }

  function emitSnapshot(portfolioId: string, trigger: string): void {
    if (!deps.onSnapshot) return;
    const state = ensurePortfolio(portfolioId);
    deps.onSnapshot({
      portfolio: portfolioId,
      snapshot_ts: new Date().toISOString(),
      trigger,
      cash: state.cash,
      equity: state.equity,
      realized_pnl: state.total_realized_pnl,
      unrealized_pnl: state.total_unrealized_pnl,
      daily_realized: state.daily_realized_pnl,
      net_delta: state.net_delta,
      net_vega: state.net_vega,
      drawdown: state.drawdown,
      peak_equity: state.peak_equity,
      positions_count: state.positions.length,
      halted: state.halted,
      data_stale: state.data_stale,
    });
  }

  return {
    initPortfolio(portfolioId: string, config: PortfolioConfig): void {
      const state: PortfolioState = {
        portfolio_id: portfolioId,
        cash: config.initial_cash,
        positions: [],
        net_delta: 0,
        net_vega: 0,
        total_realized_pnl: 0,
        total_unrealized_pnl: 0,
        daily_realized_pnl: 0,
        equity: config.initial_cash,
        peak_equity: config.initial_cash,
        drawdown: 0,
        halted: false,
        data_stale: false,
      };
      portfolios.set(portfolioId, state);
      limits.set(portfolioId, config.limits);
      pendingOrders.set(portfolioId, 0);
      logger.debug("Portfolio initialized", { portfolioId, cash: config.initial_cash });
    },

    getState(portfolioId: string): PortfolioState {
      return ensurePortfolio(portfolioId);
    },

    canExecute(portfolioId: string, intent: OrderIntent): RiskCheckResult {
      const state = ensurePortfolio(portfolioId);
      const lim = limits.get(portfolioId) ?? null;
      const pending = pendingOrders.get(portfolioId) ?? 0;
      return evaluate(intent, state, lim, pending);
    },

    applyFill(portfolioId: string, fill: Fill): void {
      const state = ensurePortfolio(portfolioId);

      // Determine if this fill closes an existing position:
      // A fill closes if there's an existing position for the same symbol
      // in the opposite direction (Long fill closes Short position, and vice versa).
      const oppositeIdx = state.positions.findIndex(
        (p) => p.symbol === fill.symbol && p.direction !== fill.direction,
      );

      if (oppositeIdx !== -1) {
        // Close existing position
        const pos = state.positions[oppositeIdx]!;
        const pnl =
          (fill.price - pos.entry_price) * fill.quantity * (pos.direction === "Long" ? 1 : -1);
        state.total_realized_pnl += pnl - fill.fees;
        state.daily_realized_pnl += pnl - fill.fees;
        state.cash += fill.price * fill.quantity * (pos.direction === "Short" ? -1 : 1) - fill.fees;

        if (fill.quantity >= pos.quantity) {
          state.positions.splice(oppositeIdx, 1);
        } else {
          pos.quantity -= fill.quantity;
        }
      } else {
        // Open new position
        const underlying = canonicalToUnderlying(fill.symbol);
        state.positions.push({
          position_id: fill.fill_id,
          symbol: fill.symbol,
          underlying,
          direction: fill.direction as "Long" | "Short",
          quantity: fill.quantity,
          entry_price: fill.price,
          entry_date: fill.filled_at,
          current_price: fill.price,
          unrealized_pnl: 0,
          delta: 1, // Default; updated on next quote
          gamma: 0,
          theta: 0,
          vega: 0,
        });
        state.cash -= fill.price * fill.quantity + fill.fees;
      }

      recomputeAggregates(state);
      checkHaltConditions(portfolioId, state);
      emitSnapshot(portfolioId, "fill");
      emitPositionUpdate(portfolioId);
    },

    updateQuote(portfolioId: string, symbol: string, spot: number): void {
      const state = ensurePortfolio(portfolioId);
      const underlying = canonicalToUnderlying(symbol);

      for (const pos of state.positions) {
        if (pos.underlying === underlying) {
          pos.current_price = spot;
          const sign = pos.direction === "Long" ? 1 : -1;
          pos.unrealized_pnl = (spot - pos.entry_price) * pos.quantity * sign;
        }
      }

      recomputeAggregates(state);
      checkHaltConditions(portfolioId, state);
      emitPositionUpdate(portfolioId);
    },

    resetDaily(portfolioId: string): void {
      const state = ensurePortfolio(portfolioId);
      state.daily_realized_pnl = 0;
      logger.info("Daily P&L reset", { portfolioId });
      emitSnapshot(portfolioId, "daily_reset");
    },

    resetHalt(portfolioId: string): void {
      const state = ensurePortfolio(portfolioId);
      state.halted = false;
      state.halt_reason = undefined;
      logger.info("Portfolio halt cleared", { portfolioId });
    },

    halt(portfolioId: string, reason: string): void {
      const state = ensurePortfolio(portfolioId);
      state.halted = true;
      state.halt_reason = reason;
      logger.warn("Portfolio halted", { portfolioId, reason });
      emitSnapshot(portfolioId, "halt");
    },
  };
}
