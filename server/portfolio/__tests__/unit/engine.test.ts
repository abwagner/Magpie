import { describe, it, expect, vi } from "vitest";
import { createPortfolioEngine } from "../../engine.js";
import type { PortfolioConfig } from "../../../../src/types/portfolio.js";
import type { OrderIntent, Fill } from "../../../../src/types/order.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("test", "error");

function makeConfig(overrides: Partial<PortfolioConfig> = {}): PortfolioConfig {
  return {
    mode: "paper_local",
    broker: "paper",
    initial_cash: 100000,
    limits: {
      max_net_delta: 50,
      max_net_vega: 100,
      max_daily_loss: 5000,
      max_symbol_concentration: 20,
      max_drawdown: 10000,
      max_order_size: 10,
      max_open_orders: 20,
    },
    strategies: {},
    reconciliation: { interval_seconds: 60, halt_on_drift: true },
    approval_timeout_seconds: 300,
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

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    fill_id: "fill-1",
    order_id: "order-1",
    intent_id: "intent-1",
    portfolio: "main",
    symbol: "EQ:SPY",
    direction: "Long",
    quantity: 1,
    price: 500,
    fees: 1,
    filled_at: new Date().toISOString(),
    broker: "paper",
    ...overrides,
  };
}

describe("PortfolioEngine", () => {
  it("initializes portfolio with correct state", () => {
    const engine = createPortfolioEngine({ logger });
    engine.initPortfolio("main", makeConfig());
    const state = engine.getState("main");
    expect(state.cash).toBe(100000);
    expect(state.positions).toEqual([]);
    expect(state.equity).toBe(100000);
    expect(state.halted).toBe(false);
  });

  it("throws for uninitialized portfolio", () => {
    const engine = createPortfolioEngine({ logger });
    expect(() => engine.getState("missing")).toThrow("not initialized");
  });

  describe("canExecute", () => {
    it("allows valid order", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      const result = engine.canExecute("main", makeIntent());
      expect(result.ok).toBe(true);
    });

    it("rejects when portfolio is halted", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      engine.halt("main", "test halt");
      const result = engine.canExecute("main", makeIntent());
      expect(result.ok).toBe(false);
      expect(result.violations[0]!.limit).toBe("portfolio_halted");
    });

    it("rejects when order size exceeds limit", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      const result = engine.canExecute("main", makeIntent({ quantity: 15 }));
      expect(result.ok).toBe(false);
      expect(result.violations[0]!.limit).toBe("max_order_size");
    });
  });

  describe("applyFill", () => {
    it("opens position and deducts cash", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      engine.applyFill("main", makeFill());
      const state = engine.getState("main");
      expect(state.positions.length).toBe(1);
      expect(state.cash).toBe(100000 - 500 - 1); // price * qty + fees
    });

    it("emits snapshot on fill", () => {
      const onSnapshot = vi.fn();
      const engine = createPortfolioEngine({ logger, onSnapshot });
      engine.initPortfolio("main", makeConfig());
      engine.applyFill("main", makeFill());
      expect(onSnapshot).toHaveBeenCalledOnce();
      expect(onSnapshot.mock.calls[0]![0].trigger).toBe("fill");
    });
  });

  describe("halt conditions", () => {
    it("halts on drawdown breach", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio(
        "main",
        makeConfig({
          limits: {
            max_net_delta: null,
            max_net_vega: null,
            max_daily_loss: null,
            max_symbol_concentration: null,
            max_drawdown: 100,
            max_order_size: null,
            max_open_orders: null,
          },
        }),
      );

      // Buy high, price drops
      engine.applyFill("main", makeFill({ price: 1000 }));
      engine.updateQuote("main", "EQ:SPY", 800);

      const state = engine.getState("main");
      expect(state.halted).toBe(true);
      expect(state.halt_reason).toContain("Drawdown");
    });
  });

  describe("resetHalt", () => {
    it("clears halt state", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      engine.halt("main", "test");
      expect(engine.getState("main").halted).toBe(true);
      engine.resetHalt("main");
      expect(engine.getState("main").halted).toBe(false);
    });
  });

  // ── QF-309 — option lifecycle settlement ──────────────────────────
  describe("settleLifecycle", () => {
    function engineWithShortCall() {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      engine.applyFill(
        "main",
        makeFill({
          fill_id: "OPT:SPY:2026-05-16:C:500",
          symbol: "OPT:SPY:2026-05-16:C:500",
          direction: "Short",
          quantity: 1,
          price: 3,
          fees: 0,
        }),
      );
      return engine;
    }

    it("worthless expiry closes the option and realizes the short premium", () => {
      const engine = engineWithShortCall();
      const cashBefore = engine.getState("main").cash;
      const result = engine.settleLifecycle("main", {
        option_symbol: "OPT:SPY:2026-05-16:C:500",
        kind: "expired",
        option_close_price: 0,
        settlement_type: "cash",
        cash_delta: 0,
        asof: "2026-05-16T20:00:00Z",
      });
      expect(result.option_closed).toBe(true);
      // Short sold at 3, closes at 0 → realized +3.
      expect(result.realized_pnl).toBeCloseTo(3);
      expect(engine.getState("main").total_realized_pnl).toBeCloseTo(3);
      expect(engine.getState("main").cash).toBeCloseTo(cashBefore);
      expect(engine.getState("main").positions).toHaveLength(0);
    });

    it("physical assignment closes the option and opens the underlying leg", () => {
      const engine = engineWithShortCall();
      const result = engine.settleLifecycle("main", {
        option_symbol: "OPT:SPY:2026-05-16:C:500",
        kind: "assigned",
        option_close_price: 0,
        settlement_type: "physical",
        cash_delta: null,
        asof: "2026-05-16T20:00:00Z",
        underlying: {
          symbol: "EQ:SPY",
          direction: "Short", // assigned short call → deliver shares (short)
          quantity: 100,
          price: 500,
        },
      });
      expect(result.option_closed).toBe(true);
      expect(result.underlying_position_id).not.toBeNull();
      const positions = engine.getState("main").positions;
      expect(positions.find((p) => p.symbol.startsWith("OPT:"))).toBeUndefined();
      expect(positions.find((p) => p.symbol === "EQ:SPY")).toMatchObject({
        direction: "Short",
        quantity: 100,
        entry_price: 500,
      });
      // Derived cash: realized option P&L (+3) + selling 100 shares @500.
      expect(result.cash_delta).toBeCloseTo(3 + 500 * 100);
    });

    it("nets the underlying leg against an opposite existing position", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      // Existing long 100 SPY (covered call scenario).
      engine.applyFill(
        "main",
        makeFill({
          fill_id: "EQ:SPY",
          symbol: "EQ:SPY",
          direction: "Long",
          quantity: 100,
          price: 480,
          fees: 0,
        }),
      );
      engine.applyFill(
        "main",
        makeFill({
          fill_id: "OPT:SPY:2026-05-16:C:500",
          symbol: "OPT:SPY:2026-05-16:C:500",
          direction: "Short",
          quantity: 1,
          price: 3,
          fees: 0,
        }),
      );
      engine.settleLifecycle("main", {
        option_symbol: "OPT:SPY:2026-05-16:C:500",
        kind: "assigned",
        option_close_price: 0,
        settlement_type: "physical",
        cash_delta: null,
        asof: "2026-05-16T20:00:00Z",
        underlying: { symbol: "EQ:SPY", direction: "Short", quantity: 100, price: 500 },
      });
      // Short 100 nets the long 100 → flat on the underlying.
      const positions = engine.getState("main").positions;
      expect(positions.find((p) => p.symbol === "EQ:SPY")).toBeUndefined();
    });

    it("is a no-op-with-audit when the option position is unknown", () => {
      const engine = createPortfolioEngine({ logger });
      engine.initPortfolio("main", makeConfig());
      const result = engine.settleLifecycle("main", {
        option_symbol: "OPT:UNKNOWN:2026-05-16:C:500",
        kind: "assigned",
        option_close_price: 0,
        settlement_type: "physical",
        cash_delta: null,
        asof: "2026-05-16T20:00:00Z",
        underlying: { symbol: "EQ:SPY", direction: "Long", quantity: 100, price: 500 },
      });
      expect(result.option_closed).toBe(false);
      // §11.7: still opens the underlying leg the broker reports.
      expect(engine.getState("main").positions.find((p) => p.symbol === "EQ:SPY")).toBeDefined();
    });
  });
});
