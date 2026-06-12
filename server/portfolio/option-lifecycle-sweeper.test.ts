import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Position, PortfolioConfig } from "../../src/types/portfolio.js";
import type { Logger } from "../logger.js";
import type { AuditIntentRow } from "../order/audit-intent.js";
import type { AuditOrderRow } from "../order/audit-orders.js";
import { createPortfolioEngine } from "./engine.js";
import { createOptionLifecycleSweeper, classifyExpiry } from "./option-lifecycle-sweeper.js";

// ── Mock logger ────────────────────────────────────────────────────

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

const mockCalendar = {
  isMarketOpen: vi.fn(),
  nextOpen: vi.fn(),
  nextClose: vi.fn(),
  isTradingDay: vi.fn(),
  tradingDaysBetween: vi.fn(),
  hoursSinceLastClose: vi.fn(),
};

// ── Test fixtures ──────────────────────────────────────────────────

function createTestPosition(overrides: Partial<Position>): Position {
  return {
    position_id: "pos-test",
    symbol: "OPT:SPY:2026-05-16:C:500",
    underlying: "SPY",
    direction: "Long",
    quantity: 1,
    entry_price: 10.0,
    entry_date: "2026-05-01",
    current_price: 12.0,
    unrealized_pnl: 200,
    delta: 0.6,
    gamma: 0.02,
    theta: 0.1,
    vega: 0.5,
    ...overrides,
  };
}

const PORTFOLIO_CONFIG: PortfolioConfig = {
  initial_cash: 100_000,
  limits: {
    max_net_delta: null,
    max_net_vega: null,
    max_daily_loss: null,
    max_symbol_concentration: null,
    max_drawdown: null,
    max_order_size: null,
    max_open_orders: null,
  },
} as PortfolioConfig;

describe("classifyExpiry", () => {
  describe("long call classification", () => {
    it("classifies as auto_exercised when spot >= strike + tolerance", () => {
      const pos = createTestPosition({ direction: "Long", expiration: "2026-05-16" });
      expect(classifyExpiry(pos, 501.0, "2026-05-16").type).toBe("auto_exercised");
    });
    it("classifies as expired_worthless when spot < strike", () => {
      const pos = createTestPosition({ direction: "Long", expiration: "2026-05-16" });
      expect(classifyExpiry(pos, 499.0, "2026-05-16").type).toBe("expired_worthless");
    });
  });

  describe("short call classification", () => {
    it("classifies as assigned when spot >= strike - tolerance", () => {
      const pos = createTestPosition({ direction: "Short", expiration: "2026-05-16" });
      expect(classifyExpiry(pos, 500.0, "2026-05-16").type).toBe("assigned");
    });
    it("classifies as expired_worthless when spot < strike - tolerance", () => {
      const pos = createTestPosition({ direction: "Short", expiration: "2026-05-16" });
      expect(classifyExpiry(pos, 499.0, "2026-05-16").type).toBe("expired_worthless");
    });
  });

  describe("long put classification", () => {
    it("classifies as auto_exercised when spot <= strike - tolerance", () => {
      const pos = createTestPosition({
        symbol: "OPT:SPY:2026-05-16:P:500",
        direction: "Long",
        expiration: "2026-05-16",
      });
      expect(classifyExpiry(pos, 499.0, "2026-05-16").type).toBe("auto_exercised");
    });
    it("classifies as expired_worthless when spot > strike", () => {
      const pos = createTestPosition({
        symbol: "OPT:SPY:2026-05-16:P:500",
        direction: "Long",
        expiration: "2026-05-16",
      });
      expect(classifyExpiry(pos, 501.0, "2026-05-16").type).toBe("expired_worthless");
    });
  });

  describe("short put classification", () => {
    it("classifies as assigned when spot <= strike + tolerance", () => {
      const pos = createTestPosition({
        symbol: "OPT:SPY:2026-05-16:P:500",
        direction: "Short",
        expiration: "2026-05-16",
      });
      expect(classifyExpiry(pos, 500.0, "2026-05-16").type).toBe("assigned");
    });
    it("classifies as expired_worthless when spot > strike + tolerance", () => {
      const pos = createTestPosition({
        symbol: "OPT:SPY:2026-05-16:P:500",
        direction: "Short",
        expiration: "2026-05-16",
      });
      expect(classifyExpiry(pos, 501.0, "2026-05-16").type).toBe("expired_worthless");
    });
  });

  describe("date logic", () => {
    it("classifies as late_sweep when expiration < today", () => {
      const pos = createTestPosition({ expiration: "2026-05-15" });
      expect(classifyExpiry(pos, 500.0, "2026-05-16").type).toBe("late_sweep");
    });
    it("classifies as expired_worthless when expiration > today", () => {
      const pos = createTestPosition({ expiration: "2026-05-17" });
      expect(classifyExpiry(pos, 500.0, "2026-05-16").type).toBe("expired_worthless");
    });
    it("handles missing expiration", () => {
      const pos = createTestPosition({ expiration: undefined });
      expect(classifyExpiry(pos, 500.0, "2026-05-16").type).toBe("expired_worthless");
    });
  });

  describe("edge cases", () => {
    it("handles tolerance at boundary (long call at strike + tolerance)", () => {
      const pos = createTestPosition({ direction: "Long", expiration: "2026-05-16" });
      expect(classifyExpiry(pos, 500.01, "2026-05-16").type).toBe("auto_exercised");
    });
    it("handles invalid strike in symbol", () => {
      const pos = createTestPosition({
        symbol: "OPT:SPY:2026-05-16:C:INVALID",
        expiration: "2026-05-16",
      });
      expect(classifyExpiry(pos, 500.0, "2026-05-16").type).toBe("expired_worthless");
    });
    it("handles malformed symbol", () => {
      const pos = createTestPosition({ symbol: "MALFORMED", expiration: "2026-05-16" });
      expect(classifyExpiry(pos, 500.0, "2026-05-16").type).toBe("expired_worthless");
    });
  });
});

describe("OptionLifecycleSweeper", () => {
  let engine: ReturnType<typeof createPortfolioEngine>;
  let writtenIntents: AuditIntentRow[];
  let writtenOrders: AuditOrderRow[];
  let spotMap: Map<string, number>;
  let sweeper: ReturnType<typeof createOptionLifecycleSweeper>;
  const TODAY = new Date().toISOString().split("T")[0] ?? "";

  beforeEach(() => {
    vi.clearAllMocks();
    engine = createPortfolioEngine({ logger: mockLogger });
    engine.initPortfolio("main", PORTFOLIO_CONFIG);
    writtenIntents = [];
    writtenOrders = [];
    spotMap = new Map();
    sweeper = createOptionLifecycleSweeper({
      calendar: mockCalendar as never,
      logger: mockLogger,
      engine,
      auditIntentWriter: async (row) => {
        writtenIntents.push(row);
      },
      auditOrderWriter: async (row) => {
        writtenOrders.push(row);
      },
      broker: "schwab",
      spotFor: (_pid, pos) => spotMap.get(pos.position_id) ?? null,
    });
  });

  // Seed an option position directly into the ledger via a fill.
  function seedOption(over: Partial<Position> & { spot: number }): Position {
    const { spot, ...posOver } = over;
    const pos = createTestPosition(posOver);
    engine.applyFill("main", {
      fill_id: pos.position_id,
      order_id: "o-1",
      intent_id: "i-1",
      portfolio: "main",
      symbol: pos.symbol,
      direction: pos.direction,
      quantity: pos.quantity,
      price: pos.entry_price,
      fees: 0,
      filled_at: pos.entry_date,
      broker: "schwab",
    } as never);
    // applyFill doesn't carry expiration onto the position; the canonical
    // projector populates it from the contract spec. Patch the live ref so
    // the sweeper sees the expiry we're testing.
    const live = engine.getState("main").positions.find((p) => p.position_id === pos.position_id);
    if (live && pos.expiration !== undefined) live.expiration = pos.expiration;
    spotMap.set(pos.position_id, spot);
    return pos;
  }

  describe("sweepAtMarketClose", () => {
    it("settles a worthless short call: writes audit chain + closes the position", async () => {
      seedOption({
        position_id: "pos-short-call",
        symbol: "OPT:SPY:2026-05-16:C:500",
        direction: "Short",
        expiration: TODAY,
        entry_price: 3.0,
        quantity: 1,
        spot: 490.0, // OTM at close → worthless
      });
      const cashBefore = engine.getState("main").cash;

      await sweeper.sweepAtMarketClose("main", engine.getState("main").positions);

      // Position removed from the ledger.
      expect(
        engine.getState("main").positions.find((p) => p.position_id === "pos-short-call"),
      ).toBeUndefined();
      // Realized P&L: short kept the $3 premium × 1.
      expect(engine.getState("main").total_realized_pnl).toBeCloseTo(3.0);
      // Worthless expiry has no cash delta beyond what entry already moved.
      expect(engine.getState("main").cash).toBeCloseTo(cashBefore);

      // Audit chain: one intent (FK parent) + one order, threaded by corr.
      expect(writtenIntents).toHaveLength(1);
      expect(writtenOrders).toHaveLength(1);
      expect(writtenOrders[0]).toMatchObject({
        status: "expired",
        source: "qf",
        broker: "schwab",
      });
      expect(writtenIntents[0]!.source).toBe("qf");
      expect(writtenOrders[0]!.correlation_id).toBe(writtenIntents[0]!.correlation_id);
      expect(writtenOrders[0]!.intent_id).toBe(writtenIntents[0]!.intent_id);
    });

    it("does not settle positions expiring in the future", async () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0]!;
      seedOption({ position_id: "pos-fut", expiration: tomorrow, spot: 400 });
      await sweeper.sweepAtMarketClose("main", engine.getState("main").positions);
      expect(writtenOrders).toHaveLength(0);
      expect(
        engine.getState("main").positions.find((p) => p.position_id === "pos-fut"),
      ).toBeDefined();
    });

    it("does not settle assigned/exercised positions (awaits broker push)", async () => {
      seedOption({
        position_id: "pos-itm",
        symbol: "OPT:SPY:2026-05-16:C:500",
        direction: "Long",
        expiration: TODAY,
        spot: 510, // ITM → auto_exercised, expect broker push
      });
      await sweeper.sweepAtMarketClose("main", engine.getState("main").positions);
      expect(writtenOrders).toHaveLength(0);
      expect(
        engine.getState("main").positions.find((p) => p.position_id === "pos-itm"),
      ).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "option-lifecycle-sweeper: expecting assignment push",
        expect.any(Object),
      );
    });

    it("defers (no settlement) when no spot is available", async () => {
      const pos = seedOption({
        position_id: "pos-noquote",
        direction: "Short",
        expiration: TODAY,
        spot: 0,
      });
      spotMap.delete(pos.position_id);
      await sweeper.sweepAtMarketClose("main", engine.getState("main").positions);
      expect(writtenOrders).toHaveLength(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "option-lifecycle-sweeper: no spot for expiring option; deferring to open",
        expect.any(Object),
      );
    });

    it("ignores non-option positions", async () => {
      engine.applyFill("main", {
        fill_id: "eq-1",
        order_id: "o",
        intent_id: "i",
        portfolio: "main",
        symbol: "EQ:SPY",
        direction: "Long",
        quantity: 100,
        price: 500,
        fees: 0,
        filled_at: TODAY,
        broker: "schwab",
      } as never);
      await sweeper.sweepAtMarketClose("main", engine.getState("main").positions);
      expect(writtenOrders).toHaveLength(0);
    });
  });

  describe("sweepAtMarketOpen", () => {
    it("alerts on an expired option unsettled at open (missing broker push)", async () => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
      seedOption({
        position_id: "pos-stale",
        symbol: "OPT:SPY:2026-05-16:C:500",
        direction: "Long",
        expiration: yesterday,
        spot: 0, // unknown spot → classification null → alert path
      });
      spotMap.delete("pos-stale");
      await sweeper.sweepAtMarketOpen("main", engine.getState("main").positions);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "option-lifecycle-sweeper: expired option unsettled at open",
        expect.objectContaining({ alert: "option_assignment_missing_alert" }),
      );
    });

    it("does not process positions not yet expired", async () => {
      seedOption({ position_id: "pos-today", expiration: TODAY, spot: 100 });
      await sweeper.sweepAtMarketOpen("main", engine.getState("main").positions);
      expect(writtenOrders).toHaveLength(0);
    });
  });
});
