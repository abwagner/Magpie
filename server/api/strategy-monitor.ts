// ── Per-strategy monitoring (QF-356) ────────────────────────────────────
// Reads recent fills and P&L for a given strategy from the audit tables.
// Strategy status comes from StrategyStore; fills + basic P&L come from
// the trade_journal (if it exists) and audit_fills (direct broker fills).

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";

// ── Query Result Types ─────────────────────────────────────────────

export interface StrategyMonitorFill {
  fill_id: string;
  order_id: string;
  symbol: string;
  direction: string;
  price: number;
  quantity: number;
  fees: number | null;
  filled_at: string;
  slippage: number | null;
}

export interface StrategyMonitorPnL {
  realized_pnl: number;
  entry_fill_id: string;
  entry_price: number;
  entry_date: string;
  exit_fill_id: string | null;
  exit_price: number | null;
  exit_date: string | null;
  symbol: string;
  direction: string;
  quantity: number;
  status: "open" | "closed";
}

export interface StrategyMonitorData {
  strategy_id: string;
  recent_fills: StrategyMonitorFill[];
  pnl_records: StrategyMonitorPnL[];
  total_realized_pnl: number;
}

// ── Query Functions ────────────────────────────────────────────────

/**
 * Fetch recent fills for a strategy by joining audit_orders → audit_fills.
 * Returns the latest 50 fills (limit is configurable).
 */
export async function getRecentFills(
  db: Database,
  strategyId: string,
  limit: number = 50,
): Promise<StrategyMonitorFill[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT
         af.fill_id,
         af.order_id,
         ao.symbol,
         ai.direction,
         af.price,
         af.quantity,
         af.fees,
         af.filled_at,
         af.slippage
       FROM audit_fills af
       JOIN audit_orders ao ON af.order_id = ao.order_id
       JOIN audit_intents ai ON ao.intent_id = ai.intent_id
       WHERE ai.strategy_id = ?
       ORDER BY af.filled_at DESC
       LIMIT ?`,
      strategyId,
      limit,
      (err: unknown, rows: unknown) => {
        if (err) return reject(err);
        const typed = (rows as StrategyMonitorFill[] | null) ?? [];
        resolve(typed);
      },
    );
  });
}

/**
 * Fetch trade journal P&L records for a strategy.
 * Returns trades in reverse chronological order (newest first).
 */
export async function getTradePnL(
  db: Database,
  strategyId: string,
  limit: number = 100,
): Promise<StrategyMonitorPnL[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT
         realized_pnl,
         entry_fill_id,
         entry_price,
         entry_date,
         exit_fill_id,
         exit_price,
         exit_date,
         symbol,
         direction,
         quantity,
         status
       FROM trade_journal
       WHERE strategy_id = ?
       ORDER BY entry_date DESC
       LIMIT ?`,
      strategyId,
      limit,
      (err: unknown, rows: unknown) => {
        if (err) return reject(err);
        // trade_journal uses entry_date (TIMESTAMP) but TypeScript may need
        // the cast. realized_pnl can be null for open trades.
        const raw = (rows as Array<{
          realized_pnl: number | null;
          entry_fill_id: string;
          entry_price: number;
          entry_date: string;
          exit_fill_id: string | null;
          exit_price: number | null;
          exit_date: string | null;
          symbol: string;
          direction: string;
          quantity: number;
          status: string;
        }> | null) ?? [];

        const typed: StrategyMonitorPnL[] = raw.map((r) => ({
          realized_pnl: r.realized_pnl ?? 0,
          entry_fill_id: r.entry_fill_id,
          entry_price: r.entry_price,
          entry_date: r.entry_date,
          exit_fill_id: r.exit_fill_id,
          exit_price: r.exit_price,
          exit_date: r.exit_date,
          symbol: r.symbol,
          direction: r.direction,
          quantity: r.quantity,
          status: (r.status === "open" ? "open" : "closed") as "open" | "closed",
        }));
        resolve(typed);
      },
    );
  });
}

/**
 * Compute total realized P&L for a strategy from trade_journal.
 * Sums realized_pnl for all closed trades.
 */
export async function getTotalRealizedPnL(
  db: Database,
  strategyId: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT COALESCE(SUM(realized_pnl), 0) as total
       FROM trade_journal
       WHERE strategy_id = ? AND status = 'closed'`,
      strategyId,
      (err: unknown, rows: unknown) => {
        if (err) return reject(err);
        const typed = rows as Array<{ total: number }> | null;
        const total = typed?.[0]?.total ?? 0;
        resolve(total);
      },
    );
  });
}

/**
 * Fetch all monitoring data for a strategy in one call.
 * Includes recent fills, trade P&L records, and aggregated realized P&L.
 */
export async function getStrategyMonitor(
  db: Database,
  strategyId: string,
): Promise<StrategyMonitorData> {
  const [recentFills, pnlRecords, totalRealizedPnL] = await Promise.all([
    getRecentFills(db, strategyId, 50),
    getTradePnL(db, strategyId, 100),
    getTotalRealizedPnL(db, strategyId),
  ]);

  return {
    strategy_id: strategyId,
    recent_fills: recentFills,
    pnl_records: pnlRecords,
    total_realized_pnl: totalRealizedPnL,
  };
}
