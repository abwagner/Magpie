import type { Database } from "duckdb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getRecentFills,
  getTradePnL,
  getTotalRealizedPnL,
  getStrategyMonitor,
  type StrategyMonitorFill,
  type StrategyMonitorPnL,
} from "../../strategy-monitor.js";

describe("strategy-monitor", () => {
  let mockDb: Database & { all: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDb = {
      all: vi.fn(),
    } as unknown as Database & { all: ReturnType<typeof vi.fn> };
  });

  describe("getRecentFills", () => {
    it("returns recent fills joined from audit_fills, audit_orders, and audit_intents", async () => {
      const mockFills: StrategyMonitorFill[] = [
        {
          fill_id: "fill1",
          order_id: "order1",
          symbol: "SPY",
          direction: "long",
          price: 450.5,
          quantity: 10,
          fees: 5.0,
          filled_at: "2026-06-08T10:00:00Z",
          slippage: 0.1,
        },
        {
          fill_id: "fill2",
          order_id: "order2",
          symbol: "QQQ",
          direction: "short",
          price: 380.2,
          quantity: 5,
          fees: 2.5,
          filled_at: "2026-06-08T09:00:00Z",
          slippage: -0.2,
        },
      ];

      mockDb.all.mockImplementation((sql: string, strategyId: string, limit: number, callback: (e: Error | null, rows: unknown[] | null) => void) => {
        expect(sql).toContain("audit_fills");
        expect(sql).toContain("audit_orders");
        expect(sql).toContain("audit_intents");
        expect(strategyId).toBe("test-strategy");
        expect(limit).toBe(50);
        callback(null, mockFills);
      });

      const result = await getRecentFills(mockDb, "test-strategy");

      expect(result).toEqual(mockFills);
      expect(mockDb.all).toHaveBeenCalledOnce();
    });

    it("returns empty array when no fills exist", async () => {
      mockDb.all.mockImplementation((sql: string, strategyId: string, limit: number, callback: (e: Error | null, rows: unknown[] | null) => void) => {
        callback(null, null);
      });

      const result = await getRecentFills(mockDb, "unknown-strategy");

      expect(result).toEqual([]);
    });
  });

  describe("getTradePnL", () => {
    it("returns trade journal records for a strategy", async () => {
      const mockTrades: StrategyMonitorPnL[] = [
        {
          realized_pnl: 250.0,
          entry_fill_id: "fill1",
          entry_price: 450.0,
          entry_date: "2026-06-01T09:00:00Z",
          exit_fill_id: "fill2",
          exit_price: 451.0,
          exit_date: "2026-06-02T15:30:00Z",
          symbol: "SPY",
          direction: "long",
          quantity: 100,
          status: "closed",
        },
        {
          realized_pnl: 0,
          entry_fill_id: "fill3",
          entry_price: 380.0,
          entry_date: "2026-06-05T10:00:00Z",
          exit_fill_id: null,
          exit_price: null,
          exit_date: null,
          symbol: "QQQ",
          direction: "short",
          quantity: 50,
          status: "open",
        },
      ];

      mockDb.all.mockImplementation((sql: string, strategyId: string, limit: number, callback: (e: Error | null, rows: unknown[] | null) => void) => {
        expect(sql).toContain("trade_journal");
        expect(strategyId).toBe("test-strategy");
        expect(limit).toBe(100);
        callback(null, mockTrades);
      });

      const result = await getTradePnL(mockDb, "test-strategy");

      expect(result).toEqual(mockTrades);
    });

    it("handles null realized_pnl for open trades", async () => {
      const mockRows = [
        {
          realized_pnl: null, // open trade has no realized PnL
          entry_fill_id: "fill1",
          entry_price: 100.0,
          entry_date: "2026-06-01T09:00:00Z",
          exit_fill_id: null,
          exit_price: null,
          exit_date: null,
          symbol: "SPY",
          direction: "long",
          quantity: 10,
          status: "open",
        },
      ];

      mockDb.all.mockImplementation((sql: string, strategyId: string, limit: number, callback: (e: Error | null, rows: unknown[] | null) => void) => {
        callback(null, mockRows);
      });

      const result = await getTradePnL(mockDb, "test-strategy");

      expect(result).toHaveLength(1);
      expect(result[0]?.realized_pnl).toBe(0);
      expect(result[0]?.status).toBe("open");
    });
  });

  describe("getTotalRealizedPnL", () => {
    it("returns sum of realized PnL for closed trades", async () => {
      mockDb.all.mockImplementation((sql: string, strategyId: string, callback: (e: Error | null, rows: unknown[] | null) => void) => {
        expect(sql).toContain("SUM(realized_pnl)");
        expect(sql).toContain("status = 'closed'");
        expect(strategyId).toBe("test-strategy");
        callback(null, [{ total: 1250.5 }]);
      });

      const result = await getTotalRealizedPnL(mockDb, "test-strategy");

      expect(result).toBe(1250.5);
    });

    it("returns 0 when no closed trades exist", async () => {
      mockDb.all.mockImplementation((sql: string, strategyId: string, callback: (e: Error | null, rows: unknown[] | null) => void) => {
        callback(null, [{ total: 0 }]);
      });

      const result = await getTotalRealizedPnL(mockDb, "unknown-strategy");

      expect(result).toBe(0);
    });

    it("returns 0 when query returns null rows", async () => {
      mockDb.all.mockImplementation((sql: string, strategyId: string, callback: (e: Error | null, rows: unknown[] | null) => void) => {
        callback(null, null);
      });

      const result = await getTotalRealizedPnL(mockDb, "test-strategy");

      expect(result).toBe(0);
    });
  });

  describe("getStrategyMonitor", () => {
    it("aggregates fills, trades, and total PnL into one result", async () => {
      const mockFills: StrategyMonitorFill[] = [
        {
          fill_id: "fill1",
          order_id: "order1",
          symbol: "SPY",
          direction: "long",
          price: 450.5,
          quantity: 10,
          fees: 5.0,
          filled_at: "2026-06-08T10:00:00Z",
          slippage: 0.1,
        },
      ];

      const mockTrades: StrategyMonitorPnL[] = [
        {
          realized_pnl: 500.0,
          entry_fill_id: "fill1",
          entry_price: 450.0,
          entry_date: "2026-06-01T09:00:00Z",
          exit_fill_id: "fill2",
          exit_price: 451.0,
          exit_date: "2026-06-02T15:30:00Z",
          symbol: "SPY",
          direction: "long",
          quantity: 100,
          status: "closed",
        },
      ];

      let callCount = 0;
      mockDb.all.mockImplementation((sql: string, ...args: unknown[]) => {
        const callback = args[args.length - 1] as (e: Error | null, rows: unknown[] | null) => void;
        callCount++;

        if (callCount === 1) {
          // getRecentFills call
          callback(null, mockFills);
        } else if (callCount === 2) {
          // getTradePnL call
          callback(null, mockTrades);
        } else if (callCount === 3) {
          // getTotalRealizedPnL call
          callback(null, [{ total: 500.0 }]);
        }
      });

      const result = await getStrategyMonitor(mockDb, "test-strategy");

      expect(result.strategy_id).toBe("test-strategy");
      expect(result.recent_fills).toEqual(mockFills);
      expect(result.pnl_records).toEqual(mockTrades);
      expect(result.total_realized_pnl).toBe(500.0);
      expect(mockDb.all).toHaveBeenCalledTimes(3);
    });
  });
});
