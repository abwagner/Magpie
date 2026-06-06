import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import { createTradeJournal, type TradeJournal } from "../../trade-journal.js";
import type { Fill } from "../../../../src/types/order.js";

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    fill_id: `fill-${Date.now()}`,
    order_id: "order-1",
    intent_id: "intent-1",
    portfolio: "main",
    symbol: "OPT:SPY:2026-06-19:C:500",
    direction: "Long",
    quantity: 1,
    price: 12.5,
    fees: 0.65,
    filled_at: "2026-04-15T14:00:00Z",
    broker: "paper",
    ...overrides,
  };
}

describe("trade journal", () => {
  let db: TestDb;
  let journal: TradeJournal;

  beforeEach(async () => {
    db = await createTestDb();
    journal = createTradeJournal(db.db, createTestLogger());
  });

  afterEach(() => db.close());

  it("records an entry trade as open", async () => {
    await journal.recordEntry(makeFill(), {
      trade_id: "t-1",
      strategy_id: "short-straddle",
      signal_ids: ["sig-1", "sig-2"],
    });

    const trades = await journal.getOpenTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]!.trade_id).toBe("t-1");
    expect(trades[0]!.status).toBe("open");
    expect(trades[0]!.entry_price).toBe(12.5);
    expect(trades[0]!.strategy_id).toBe("short-straddle");
    expect(trades[0]!.exit_fill_id).toBeNull();
  });

  it("records exit and computes P&L for a long trade", async () => {
    const entryFill = makeFill({ fill_id: "fill-entry", price: 10, fees: 0.65 });
    await journal.recordEntry(entryFill, {
      trade_id: "t-1",
      strategy_id: "test",
      signal_ids: [],
      contract_multiplier: 100,
    });

    const exitFill = makeFill({
      fill_id: "fill-exit",
      price: 12,
      fees: 0.65,
      filled_at: "2026-04-20T14:00:00Z",
    });
    await journal.recordExit(exitFill);

    const closed = await journal.getClosedTrades();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.status).toBe("closed");
    expect(closed[0]!.exit_price).toBe(12);
    // P&L: (12 - 10) × 1 × 100 × 1 - (0.65 + 0.65) = 200 - 1.30 = 198.70
    expect(closed[0]!.realized_pnl).toBeCloseTo(198.7, 1);
    expect(closed[0]!.holding_days).toBe(5);

    const open = await journal.getOpenTrades();
    expect(open).toHaveLength(0);
  });

  it("records exit with P&L for a short trade", async () => {
    const entryFill = makeFill({
      fill_id: "fill-entry",
      direction: "Short",
      price: 15,
      fees: 0.65,
    });
    await journal.recordEntry(entryFill, {
      trade_id: "t-short",
      strategy_id: "test",
      signal_ids: [],
      contract_multiplier: 100,
    });

    const exitFill = makeFill({
      fill_id: "fill-exit",
      direction: "Short",
      price: 10,
      fees: 0.65,
      filled_at: "2026-04-18T14:00:00Z",
    });
    await journal.recordExit(exitFill);

    const closed = await journal.getClosedTrades();
    // Short P&L: (10 - 15) × 1 × 100 × (-1) - (0.65 + 0.65) = 500 - 1.30 = 498.70
    expect(closed[0]!.realized_pnl).toBeCloseTo(498.7, 1);
  });

  it("filters by portfolio", async () => {
    await journal.recordEntry(makeFill({ portfolio: "main" }), {
      trade_id: "t-1",
      strategy_id: "test",
      signal_ids: [],
    });
    await journal.recordEntry(
      makeFill({ portfolio: "other", fill_id: "f2", symbol: "OPT:QQQ:2026-06-19:C:400" }),
      { trade_id: "t-2", strategy_id: "test", signal_ids: [] },
    );

    expect(await journal.getOpenTrades("main")).toHaveLength(1);
    expect(await journal.getOpenTrades("other")).toHaveLength(1);
    expect(await journal.getAllTrades()).toHaveLength(2);
  });

  it("warns on exit with no matching open trade", async () => {
    const logger = createTestLogger();
    const j = createTradeJournal(db.db, logger);
    await j.recordExit(makeFill({ symbol: "NONEXISTENT" }));
    expect(logger.logs.some((l) => l.msg.includes("no matching"))).toBe(true);
  });

  it("getAllTrades returns both open and closed", async () => {
    await journal.recordEntry(makeFill({ fill_id: "f1" }), {
      trade_id: "t-1",
      strategy_id: "test",
      signal_ids: [],
    });
    await journal.recordEntry(makeFill({ fill_id: "f2", symbol: "OPT:QQQ:2026-06-19:C:400" }), {
      trade_id: "t-2",
      strategy_id: "test",
      signal_ids: [],
    });
    // Close one
    await journal.recordExit(makeFill({ fill_id: "f3", symbol: "OPT:SPY:2026-06-19:C:500" }));

    const all = await journal.getAllTrades();
    expect(all).toHaveLength(2);
    expect(all.filter((t) => t.status === "open")).toHaveLength(1);
    expect(all.filter((t) => t.status === "closed")).toHaveLength(1);
  });
});
