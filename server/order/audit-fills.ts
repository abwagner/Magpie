// ── audit_fills writer ────────────────────────────────────────────────
// One row per broker fill (incl partial fills). FK back to audit_orders.
// Schema lives in server/db/init.ts.
//
// Defined in: docs/tdd/order-flow.md §6 (audit chain) + §3.2
// (partial-fill format). M11 / QF-208.

import type { Database } from "duckdb";
import type { Fill } from "../../src/types/order.js";
import type { Logger } from "../logger.js";

// ── Row + writer types ────────────────────────────────────────────────

export interface AuditFillRow {
  fill_id: string;
  order_id: string;
  price: number;
  quantity: number;
  fees: number | null;
  filled_at: string;
  expected_price: number | null;
  slippage: number | null;
  // QF-319 — writer-identity source per order-flow.md §4.2.
  source: "qf" | "qf-gated" | "nt-native";
  correlation_id: string | null;
  // QF-244: M12-2 — which Schwab account this fill came from.
  // 'default' is the backward-compat value until M12-3 wires routing.
  account_id: string;
}

export type AuditFillWriter = (row: AuditFillRow) => Promise<void>;

// ── Row builder ───────────────────────────────────────────────────────

export interface BuildFillRowArgs {
  fill: Fill;
  // The Execution Layer's recommended/snapped price for the parent
  // intent. Used to compute realized slippage. When unknown the
  // recorded slippage is null.
  expected_price?: number | null;
  // QF-319 — defaults to 'qf' (OPL is the typical caller). The observer
  // path passes 'nt-native' explicitly.
  source?: "qf" | "qf-gated" | "nt-native";
  correlation_id?: string | null;
  // QF-244 — M12-2: which Schwab account this fill came from.
  // Defaults to 'default' until M12-3 wires the routing account_id.
  account_id?: string;
}

export function buildFillRow(args: BuildFillRowArgs): AuditFillRow {
  const { fill } = args;
  const expected = args.expected_price ?? null;
  const slippage = expected !== null ? fill.price - expected : null;
  return {
    fill_id: fill.fill_id,
    order_id: fill.order_id,
    price: fill.price,
    quantity: fill.quantity,
    fees: fill.fees ?? null,
    filled_at: fill.filled_at,
    expected_price: expected,
    slippage,
    source: args.source ?? "qf",
    correlation_id: args.correlation_id ?? null,
    account_id: args.account_id ?? "default",
  };
}

// ── DB-backed writer ──────────────────────────────────────────────────

export function createAuditFillWriter(db: Database, logger: Logger): AuditFillWriter {
  return async (row: AuditFillRow): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      db.run(
        `INSERT INTO audit_fills (
           fill_id, order_id, price, quantity, fees,
           filled_at, expected_price, slippage, source, correlation_id,
           account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.fill_id,
        row.order_id,
        row.price,
        row.quantity,
        row.fees,
        row.filled_at,
        row.expected_price,
        row.slippage,
        row.source,
        row.correlation_id,
        row.account_id,
        (err: Error | null) => {
          if (err) {
            logger.error("audit_fills write failed", {
              fill_id: row.fill_id,
              order_id: row.order_id,
              error: String(err),
            });
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  };
}
