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
import type { AlertRouter } from "../alerts/router.js";
import { evaluate } from "./evaluator.js";

// ── QF-309 — option lifecycle settlement ────────────────────────────
// A single option lifecycle event (expiry / assignment / exercise) that
// must mutate the position ledger per docs/tdd/portfolio-risk-engine.md
// §11.3–§11.4. Source-agnostic: the calendar sweeper builds these for
// worthless expiries; the broker-events consumer builds them from
// `broker.events.<broker>` pushes.
export interface LifecycleSettlement {
  // Canonical option symbol whose position closes (OPT:SPY:...:C:500).
  option_symbol: string;
  kind: "expired" | "assigned" | "exercised";
  // Price the option position closes at. 0 for worthless expiry; the
  // intrinsic/settlement value the broker reports otherwise.
  option_close_price: number;
  // Physical settlement opens/modifies an underlying position; cash
  // settlement only realizes P&L + adjusts cash.
  settlement_type: "physical" | "cash";
  // Resulting underlying leg (physical settlement only). `quantity` is in
  // the position's own units (contracts × multiplier already applied by
  // the broker-side translator — see BrokerLifecycleEvent.quantity).
  underlying?: {
    symbol: string;
    direction: "Long" | "Short";
    quantity: number;
    price: number; // strike for assignment; settlement_price otherwise
  };
  // Net cash impact the broker reports (null → derive from the legs).
  cash_delta?: number | null;
  asof: string;
  strategy_id?: string;
}

export interface LifecycleSettlementResult {
  option_closed: boolean;
  realized_pnl: number;
  cash_delta: number;
  underlying_position_id: string | null;
}

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
  // QF-336 — optional alert router for risk breach alerts.
  alertRouter?: AlertRouter;
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
  // QF-309 — apply an option lifecycle settlement to the ledger: close
  // the option position (crystallize realized P&L), adjust cash, and for
  // physical settlement open/modify the resulting underlying position.
  // Idempotent: a no-op if the option position is already gone.
  settleLifecycle(
    portfolioId: string,
    settlement: LifecycleSettlement,
  ): LifecycleSettlementResult;
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
      if (deps.alertRouter) {
        void deps.alertRouter
          .record({
            type: `drawdown.breach.${portfolioId}`,
            level: "critical",
            message: `Portfolio ${portfolioId} daily loss limit breached`,
            payload: {
              portfolio: portfolioId,
              limit_type: "daily_loss",
              current: state.daily_realized_pnl,
              limit: lim.max_daily_loss,
            },
          })
          .catch((err) => {
            logger.warn("portfolio halt alert failed", { error: String(err), portfolioId });
          });
      }
    }

    if (lim.max_drawdown !== null && state.drawdown > lim.max_drawdown) {
      state.halted = true;
      state.halt_reason = `Drawdown ${state.drawdown.toFixed(2)} exceeds limit ${lim.max_drawdown}`;
      logger.warn("Portfolio halted: drawdown limit", { portfolioId, drawdown: state.drawdown });
      if (deps.alertRouter) {
        void deps.alertRouter
          .record({
            type: `drawdown.breach.${portfolioId}`,
            level: "critical",
            message: `Portfolio ${portfolioId} drawdown limit breached: ${state.drawdown.toFixed(2)}`,
            payload: {
              portfolio: portfolioId,
              limit_type: "max_drawdown",
              current: state.drawdown,
              limit: lim.max_drawdown,
            },
          })
          .catch((err) => {
            logger.warn("portfolio halt alert failed", { error: String(err), portfolioId });
          });
      }
    }
  }

  // QF-309 — open or modify the underlying leg produced by a physical
  // settlement. If an opposite-direction underlying position exists it
  // nets down (assignment closing a covered position); same-direction
  // adds quantity at a blended entry price; otherwise a fresh position
  // opens, tagged with the option's strategy for attribution carry-forward.
  function openUnderlying(state: PortfolioState, settlement: LifecycleSettlement): string | null {
    const u = settlement.underlying;
    if (!u) return null;

    const opposite = state.positions.find(
      (p) => p.symbol === u.symbol && p.direction !== u.direction,
    );
    if (opposite) {
      const realized =
        (u.price - opposite.entry_price) * Math.min(u.quantity, opposite.quantity) *
        (opposite.direction === "Long" ? 1 : -1);
      state.total_realized_pnl += realized;
      state.daily_realized_pnl += realized;
      if (u.quantity >= opposite.quantity) {
        state.positions.splice(state.positions.indexOf(opposite), 1);
      } else {
        opposite.quantity -= u.quantity;
        return opposite.position_id;
      }
      // Fall through to open the remainder if the new leg is larger.
      const remainder = u.quantity - opposite.quantity;
      if (remainder <= 0) return null;
      u.quantity = remainder;
    }

    const sameDir = state.positions.find(
      (p) => p.symbol === u.symbol && p.direction === u.direction,
    );
    if (sameDir) {
      const totalQty = sameDir.quantity + u.quantity;
      sameDir.entry_price =
        (sameDir.entry_price * sameDir.quantity + u.price * u.quantity) / totalQty;
      sameDir.quantity = totalQty;
      return sameDir.position_id;
    }

    const positionId = `${settlement.option_symbol}:settle:${settlement.asof}`;
    state.positions.push({
      position_id: positionId,
      symbol: u.symbol,
      underlying: canonicalToUnderlying(u.symbol),
      direction: u.direction,
      quantity: u.quantity,
      entry_price: u.price,
      entry_date: settlement.asof,
      current_price: u.price,
      unrealized_pnl: 0,
      delta: 1, // Underlying shares; updated on next quote tick.
      gamma: 0,
      theta: 0,
      vega: 0,
      ...(settlement.strategy_id !== undefined ? { strategy_id: settlement.strategy_id } : {}),
    });
    return positionId;
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

    settleLifecycle(
      portfolioId: string,
      settlement: LifecycleSettlement,
    ): LifecycleSettlementResult {
      const state = ensurePortfolio(portfolioId);

      const idx = state.positions.findIndex((p) => p.symbol === settlement.option_symbol);
      if (idx === -1) {
        // Position unknown (already settled, or a broker-pushed assignment
        // for a position QF never opened — §11.7). Nothing to close; the
        // audit row is still written by the caller. For physical settlement
        // we still open the underlying leg so the ledger reflects reality.
        logger.warn("settleLifecycle: option position not found", {
          portfolioId,
          option_symbol: settlement.option_symbol,
          kind: settlement.kind,
        });
        const underlyingId =
          settlement.settlement_type === "physical" && settlement.underlying
            ? openUnderlying(state, settlement)
            : null;
        const cashDelta = settlement.cash_delta ?? 0;
        state.cash += cashDelta;
        recomputeAggregates(state);
        emitSnapshot(portfolioId, settlement.kind);
        emitPositionUpdate(portfolioId);
        return {
          option_closed: false,
          realized_pnl: 0,
          cash_delta: cashDelta,
          underlying_position_id: underlyingId,
        };
      }

      const pos = state.positions[idx]!;
      const dirSign = pos.direction === "Long" ? 1 : -1;

      // Crystallize realized P&L on the option leg at the close price.
      // Long: (close - entry) * qty; Short: (entry - close) * qty. A short
      // option expiring worthless (close = 0) realizes the full premium.
      const realized = (settlement.option_close_price - pos.entry_price) * pos.quantity * dirSign;
      state.total_realized_pnl += realized;
      state.daily_realized_pnl += realized;

      // Remove the option position; stop the exit-rule monitor re-evaluating
      // it (closing_intent_id no longer relevant once the row is gone).
      state.positions.splice(idx, 1);

      // Physical settlement opens/modifies the underlying leg, tagged with
      // the option's strategy_id so attribution carries forward (§11.3).
      let underlyingId: string | null = null;
      if (settlement.settlement_type === "physical" && settlement.underlying) {
        underlyingId = openUnderlying(state, {
          ...settlement,
          strategy_id: settlement.strategy_id ?? pos.strategy_id,
        });
      }

      // Cash: trust the broker's reported cash_delta when present; otherwise
      // derive — the option's realized P&L lands in cash, and a physical
      // assignment/exercise pays/receives strike × qty for the shares.
      let cashDelta = settlement.cash_delta ?? null;
      if (cashDelta === null) {
        cashDelta = realized;
        if (settlement.settlement_type === "physical" && settlement.underlying) {
          const u = settlement.underlying;
          // Buying the underlying spends cash; selling receives it.
          cashDelta += (u.direction === "Long" ? -1 : 1) * u.price * u.quantity;
        }
      }
      state.cash += cashDelta;

      recomputeAggregates(state);
      checkHaltConditions(portfolioId, state);
      emitSnapshot(portfolioId, settlement.kind);
      emitPositionUpdate(portfolioId);

      logger.info("settleLifecycle: option position settled", {
        portfolioId,
        option_symbol: settlement.option_symbol,
        kind: settlement.kind,
        realized_pnl: realized,
        cash_delta: cashDelta,
        underlying_position_id: underlyingId,
      });

      return {
        option_closed: true,
        realized_pnl: realized,
        cash_delta: cashDelta,
        underlying_position_id: underlyingId,
      };
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
      if (deps.alertRouter) {
        void deps.alertRouter
          .record({
            type: `drawdown.breach.${portfolioId}`,
            level: "critical",
            message: `Portfolio ${portfolioId} halted: ${reason}`,
            payload: {
              portfolio: portfolioId,
              reason,
            },
          })
          .catch((err) => {
            logger.warn("portfolio halt alert failed", { error: String(err), portfolioId });
          });
      }
      emitSnapshot(portfolioId, "halt");
    },
  };
}
