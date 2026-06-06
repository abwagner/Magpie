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
});
