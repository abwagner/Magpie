// ── Evaluator unit tests ─────────────────────────────────────────────
// Pure-function parity with the pre-refactor engine.canExecute behavior.
// Fixture set mirrors the scenarios tested in engine.test.ts so a
// regression in extraction is immediately visible.

import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluator.js";
import type { OrderIntent } from "../../src/types/order.js";
import type { PortfolioState, RiskLimits } from "../../src/types/portfolio.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeState(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    portfolio_id: "main",
    cash: 100000,
    positions: [],
    net_delta: 0,
    net_vega: 0,
    total_realized_pnl: 0,
    total_unrealized_pnl: 0,
    daily_realized_pnl: 0,
    equity: 100000,
    peak_equity: 100000,
    drawdown: 0,
    halted: false,
    data_stale: false,
    ...overrides,
  };
}

function makeLimits(overrides: Partial<RiskLimits> = {}): RiskLimits {
  return {
    max_net_delta: 50,
    max_net_vega: 100,
    max_daily_loss: 5000,
    max_symbol_concentration: 20,
    max_drawdown: 10000,
    max_order_size: 10,
    max_open_orders: 20,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intent_id: "intent-1",
    portfolio: "main",
    strategy_id: "test",
    action: "open",
    symbol: "EQ:SPY",
    direction: "Long",
    quantity: 1,
    reason: "test",
    signal_ids: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("evaluate", () => {
  it("allows valid order with limits in place", () => {
    const result = evaluate(makeIntent(), makeState(), makeLimits(), 0);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("allows order when riskLimits is null (no limits configured)", () => {
    const result = evaluate(makeIntent(), makeState(), null, 0);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("rejects when portfolio is halted (limits null)", () => {
    const result = evaluate(makeIntent(), makeState({ halted: true }), null, 0);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.limit).toBe("portfolio_halted");
  });

  it("rejects when portfolio is halted (limits present)", () => {
    const result = evaluate(makeIntent(), makeState({ halted: true }), makeLimits(), 0);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.limit).toBe("portfolio_halted");
  });

  describe("max_order_size", () => {
    it("rejects when order quantity exceeds limit", () => {
      const result = evaluate(
        makeIntent({ quantity: 15 }),
        makeState(),
        makeLimits({ max_order_size: 10 }),
        0,
      );
      expect(result.ok).toBe(false);
      expect(result.violations[0]!.limit).toBe("max_order_size");
      expect(result.violations[0]!.proposed).toBe(15);
      expect(result.violations[0]!.threshold).toBe(10);
    });

    it("allows when order quantity equals limit exactly", () => {
      const result = evaluate(
        makeIntent({ quantity: 10 }),
        makeState(),
        makeLimits({ max_order_size: 10 }),
        0,
      );
      expect(result.ok).toBe(true);
    });

    it("skips check when max_order_size is null", () => {
      const result = evaluate(
        makeIntent({ quantity: 9999 }),
        makeState(),
        makeLimits({ max_order_size: null }),
        0,
      );
      // May fail on other limits (delta) but not on order size
      const sizeViolation = result.violations.find((v) => v.limit === "max_order_size");
      expect(sizeViolation).toBeUndefined();
    });
  });

  describe("max_open_orders", () => {
    it("rejects when pending orders already at limit", () => {
      const result = evaluate(makeIntent(), makeState(), makeLimits({ max_open_orders: 5 }), 5);
      expect(result.ok).toBe(false);
      expect(result.violations[0]!.limit).toBe("max_open_orders");
      expect(result.violations[0]!.current).toBe(5);
    });

    it("allows when pending orders below limit", () => {
      const result = evaluate(makeIntent(), makeState(), makeLimits({ max_open_orders: 5 }), 4);
      expect(result.ok).toBe(true);
    });

    it("skips check when max_open_orders is null", () => {
      const result = evaluate(
        makeIntent(),
        makeState(),
        makeLimits({ max_open_orders: null }),
        9999,
      );
      const v = result.violations.find((v) => v.limit === "max_open_orders");
      expect(v).toBeUndefined();
    });
  });

  describe("max_net_delta", () => {
    it("rejects Long intent when it would breach positive delta cap", () => {
      // net_delta=48, cap=50, adding 5 Long → proposed=53 → breach
      const result = evaluate(
        makeIntent({ quantity: 5, direction: "Long" }),
        makeState({ net_delta: 48 }),
        makeLimits({ max_net_delta: 50 }),
        0,
      );
      expect(result.ok).toBe(false);
      expect(result.violations[0]!.limit).toBe("max_net_delta");
      expect(result.violations[0]!.proposed).toBe(53);
    });

    it("rejects Short intent when it would breach negative delta cap", () => {
      // net_delta=-48, cap=50, adding 5 Short → proposed=-53 → |−53|>50 → breach
      const result = evaluate(
        makeIntent({ quantity: 5, direction: "Short" }),
        makeState({ net_delta: -48 }),
        makeLimits({ max_net_delta: 50 }),
        0,
      );
      expect(result.ok).toBe(false);
      expect(result.violations[0]!.limit).toBe("max_net_delta");
    });

    it("allows when proposed delta stays within cap", () => {
      const result = evaluate(
        makeIntent({ quantity: 2, direction: "Long" }),
        makeState({ net_delta: 30 }),
        makeLimits({ max_net_delta: 50 }),
        0,
      );
      expect(result.ok).toBe(true);
    });

    it("skips check when max_net_delta is null", () => {
      const result = evaluate(
        makeIntent({ quantity: 9999, direction: "Long" }),
        makeState({ net_delta: 9998 }),
        makeLimits({ max_net_delta: null }),
        0,
      );
      const v = result.violations.find((v) => v.limit === "max_net_delta");
      expect(v).toBeUndefined();
    });
  });

  describe("max_symbol_concentration", () => {
    it("rejects when adding to existing symbol exceeds concentration limit", () => {
      const state = makeState({
        positions: [
          {
            position_id: "p1",
            symbol: "EQ:SPY",
            underlying: "SPY",
            direction: "Long",
            quantity: 18,
            entry_price: 500,
            entry_date: new Date().toISOString(),
            current_price: 500,
            unrealized_pnl: 0,
            delta: 1,
            gamma: 0,
            theta: 0,
            vega: 0,
          },
        ],
      });
      // existing symbolDelta=18*1=18, adding 5 Long → proposed=23 > cap 20
      const result = evaluate(
        makeIntent({ quantity: 5, direction: "Long" }),
        state,
        makeLimits({ max_symbol_concentration: 20 }),
        0,
      );
      expect(result.ok).toBe(false);
      expect(result.violations[0]!.limit).toBe("max_symbol_concentration");
    });

    it("allows when concentration stays within limit", () => {
      const state = makeState({
        positions: [
          {
            position_id: "p1",
            symbol: "EQ:SPY",
            underlying: "SPY",
            direction: "Long",
            quantity: 15,
            entry_price: 500,
            entry_date: new Date().toISOString(),
            current_price: 500,
            unrealized_pnl: 0,
            delta: 1,
            gamma: 0,
            theta: 0,
            vega: 0,
          },
        ],
      });
      // existing=15, adding 2 → 17 ≤ cap 20
      const result = evaluate(
        makeIntent({ quantity: 2, direction: "Long" }),
        state,
        makeLimits({ max_symbol_concentration: 20 }),
        0,
      );
      expect(result.ok).toBe(true);
    });

    it("only counts positions for the same underlying", () => {
      const state = makeState({
        positions: [
          {
            position_id: "p1",
            symbol: "EQ:AAPL",
            underlying: "AAPL",
            direction: "Long",
            quantity: 19,
            entry_price: 200,
            entry_date: new Date().toISOString(),
            current_price: 200,
            unrealized_pnl: 0,
            delta: 1,
            gamma: 0,
            theta: 0,
            vega: 0,
          },
        ],
      });
      // SPY intent — AAPL position should not contribute to SPY concentration
      const result = evaluate(
        makeIntent({ quantity: 5, direction: "Long", symbol: "EQ:SPY" }),
        state,
        makeLimits({ max_symbol_concentration: 20 }),
        0,
      );
      expect(result.ok).toBe(true);
    });

    it("skips check when max_symbol_concentration is null", () => {
      const result = evaluate(
        makeIntent({ quantity: 9999 }),
        makeState(),
        makeLimits({ max_symbol_concentration: null }),
        0,
      );
      const v = result.violations.find((v) => v.limit === "max_symbol_concentration");
      expect(v).toBeUndefined();
    });
  });

  it("accumulates multiple violations in one result", () => {
    // Both order_size and open_orders breached simultaneously
    const result = evaluate(
      makeIntent({ quantity: 15 }),
      makeState(),
      makeLimits({ max_order_size: 10, max_open_orders: 5 }),
      5,
    );
    expect(result.ok).toBe(false);
    const limits = result.violations.map((v) => v.limit);
    expect(limits).toContain("max_order_size");
    expect(limits).toContain("max_open_orders");
  });
});
