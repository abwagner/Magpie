// ── Trade Journal ─────────────────────────────────────────────────
// Links entry and exit fills into trade records with P&L.
// A trade = opening fill → holding period → closing fill.
// Persists to DuckDB trade_journal table.

import type { Database } from "duckdb";
import type { Fill } from "../../src/types/order.js";
import type { FillPriceResult } from "./fill-model.js";
import type { Logger } from "../logger.js";

// ── Types ────────────────────────────────────────────────────────

export interface TradeRecord {
  trade_id: string;
  portfolio: string;
  strategy_id: string;
  signal_ids: string;
  symbol: string;
  direction: string;
  quantity: number;
  contract_multiplier: number;
  // Entry
  entry_fill_id: string;
  entry_price: number;
  entry_date: string;
  entry_fees: number;
  // Exit (null while open)
  exit_fill_id: string | null;
  exit_price: number | null;
  exit_date: string | null;
  exit_fees: number | null;
  exit_reason: string | null;
  // P&L
  realized_pnl: number | null;
  holding_days: number | null;
  // Status
  status: "open" | "closed";
}

export interface TradeJournal {
  recordEntry(fill: Fill, context: EntryContext): Promise<void>;
  recordExit(fill: Fill, reason?: string): Promise<void>;
  getOpenTrades(portfolio?: string): Promise<TradeRecord[]>;
  getClosedTrades(portfolio?: string, limit?: number): Promise<TradeRecord[]>;
  getAllTrades(portfolio?: string): Promise<TradeRecord[]>;
}

export interface EntryContext {
  trade_id: string;
  strategy_id: string;
  signal_ids: string[];
  contract_multiplier?: number;
}

// ── Helpers ──────────────────────────────────────────────────────

function runExec(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, ...params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function runQuery<T>(db: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

function daysBetween(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

// ── Implementation ───────────────────────────────────────────────

export function createTradeJournal(db: Database, logger: Logger): TradeJournal {
  return {
    async recordEntry(fill: Fill, ctx: EntryContext): Promise<void> {
      await runExec(
        db,
        `INSERT INTO trade_journal
         (trade_id, portfolio, strategy_id, signal_ids, symbol, direction, quantity,
          contract_multiplier, entry_fill_id, entry_price, entry_date, entry_fees, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          ctx.trade_id,
          fill.portfolio,
          ctx.strategy_id,
          JSON.stringify(ctx.signal_ids),
          fill.symbol,
          fill.direction,
          fill.quantity,
          ctx.contract_multiplier ?? 100,
          fill.fill_id,
          fill.price,
          fill.filled_at,
          fill.fees,
          "open",
        ],
      );
      logger.info("Trade opened", {
        trade_id: ctx.trade_id,
        symbol: fill.symbol,
        price: fill.price,
      });
    },

    async recordExit(fill: Fill, reason: string = "signal"): Promise<void> {
      // Find the matching open trade for this symbol + direction (opposite)
      const openTrades = await runQuery<TradeRecord>(
        db,
        `SELECT * FROM trade_journal
         WHERE portfolio = ? AND symbol = ? AND status = 'open'
         ORDER BY entry_date ASC LIMIT 1`,
        [fill.portfolio, fill.symbol],
      );

      if (openTrades.length === 0) {
        logger.warn("Exit fill with no matching open trade", {
          symbol: fill.symbol,
          fill_id: fill.fill_id,
        });
        return;
      }

      const trade = openTrades[0]!;
      const multiplier = trade.contract_multiplier;
      const dirSign = trade.direction === "Long" || trade.direction === "buy" ? 1 : -1;
      const pnl =
        (fill.price - trade.entry_price) * trade.quantity * multiplier * dirSign -
        (trade.entry_fees + fill.fees);
      const holding = daysBetween(trade.entry_date, fill.filled_at);

      await runExec(
        db,
        `UPDATE trade_journal SET
           exit_fill_id = ?, exit_price = ?, exit_date = ?, exit_fees = ?,
           exit_reason = ?, realized_pnl = ?, holding_days = ?, status = 'closed'
         WHERE trade_id = ?`,
        [fill.fill_id, fill.price, fill.filled_at, fill.fees, reason, pnl, holding, trade.trade_id],
      );

      logger.info("Trade closed", {
        trade_id: trade.trade_id,
        symbol: fill.symbol,
        entry: trade.entry_price,
        exit: fill.price,
        pnl: Math.round(pnl * 100) / 100,
        holding_days: holding,
        reason,
      });
    },

    async getOpenTrades(portfolio?: string): Promise<TradeRecord[]> {
      let sql = "SELECT * FROM trade_journal WHERE status = 'open'";
      const args: unknown[] = [];
      if (portfolio) {
        sql += " AND portfolio = ?";
        args.push(portfolio);
      }
      sql += " ORDER BY entry_date DESC";
      return runQuery<TradeRecord>(db, sql, args);
    },

    async getClosedTrades(portfolio?: string, limit: number = 100): Promise<TradeRecord[]> {
      let sql = "SELECT * FROM trade_journal WHERE status = 'closed'";
      const args: unknown[] = [];
      if (portfolio) {
        sql += " AND portfolio = ?";
        args.push(portfolio);
      }
      sql += " ORDER BY exit_date DESC LIMIT ?";
      args.push(limit);
      return runQuery<TradeRecord>(db, sql, args);
    },

    async getAllTrades(portfolio?: string): Promise<TradeRecord[]> {
      let sql = "SELECT * FROM trade_journal WHERE 1=1";
      const args: unknown[] = [];
      if (portfolio) {
        sql += " AND portfolio = ?";
        args.push(portfolio);
      }
      sql += " ORDER BY entry_date DESC";
      return runQuery<TradeRecord>(db, sql, args);
    },
  };
}
