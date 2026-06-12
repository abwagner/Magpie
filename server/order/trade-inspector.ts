// ── Trade Inspector ───────────────────────────────────────────────────
// Aggregates the audit chain (intent → order → fill) for a given fill_id.
// Backs the Trade Inspector GUI surface defined in
// `docs/design_handoff_magpie/source_brief_gui.md` and addresses
// QF-215.
//
// The inspector is a read-only join across the three audit tables. It is
// deliberately a separate module from server/analytics so the OrderPlane
// surface owns its own forensic API alongside the writers (QF-207,
// QF-208, QF-206).
//
// QF-338 — the audit_pricing_decisions chain hop and the audit_signals
// join were retired (their writers were deleted in QF-283 / QF-261).
// audit_intents.signal_ids is still surfaced raw on the intent row for
// forensic context, but is no longer expanded into a joined signal.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";

// ── Public shape ──────────────────────────────────────────────────────

export interface InspectorFillRow {
  fill_id: string;
  order_id: string;
  price: number;
  quantity: number;
  fees: number | null;
  filled_at: string;
  expected_price: number | null;
  slippage: number | null;
  // QF-244: M12-2 — which Schwab account this fill came from.
  account_id: string;
}

export interface InspectorOrderRow {
  order_id: string;
  intent_id: string;
  broker: string;
  execution_mode: string;
  status: string;
  created_at: string;
  risk_checked_at: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  broker_order_id: string | null;
  operator_edits: unknown;
  risk_violations: unknown;
  halt_reason: string | null;
  broker_rejection_reason: string | null;
  quote_failure_reason: string | null;
  // QF-244: M12-2 — which Schwab account this order came from.
  account_id: string;
}

export interface InspectorIntentRow {
  intent_id: string;
  portfolio: string;
  strategy_id: string;
  symbol: string;
  direction: string;
  quantity: number;
  signal_ids: string[];
  created_at: string;
}

export interface TradeInspectorResult {
  fill: InspectorFillRow;
  order: InspectorOrderRow;
  intent: InspectorIntentRow;
}

export class TradeInspectorNotFoundError extends Error {
  public readonly status = 404;
  constructor(fillId: string) {
    super(`No fill with fill_id=${fillId}`);
    this.name = "TradeInspectorNotFoundError";
  }
}

// ── Implementation ────────────────────────────────────────────────────

function runOne<T>(db: Database, sql: string, params: unknown[]): Promise<T | null> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else {
        const arr = (rows as T[]) ?? [];
        resolve(arr[0] ?? null);
      }
    });
  });
}

function safeJsonParse(s: string | null | undefined): unknown {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s; // surface the raw string so the operator can debug malformed JSON
  }
}

function parseSignalIds(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export interface TradeInspector {
  inspect(fillId: string): Promise<TradeInspectorResult>;
}

export function createTradeInspector(db: Database, logger: Logger): TradeInspector {
  return {
    async inspect(fillId: string): Promise<TradeInspectorResult> {
      // 1. Fill row (anchors everything; 404 if missing).
      type RawFill = {
        fill_id: string;
        order_id: string;
        price: number;
        quantity: number;
        fees: number | null;
        filled_at: string;
        expected_price: number | null;
        slippage: number | null;
        account_id: string;
      };
      const fillRaw = await runOne<RawFill>(
        db,
        `SELECT fill_id, order_id, price, quantity, fees, filled_at,
                expected_price, slippage, account_id
         FROM audit_fills WHERE fill_id = ?`,
        [fillId],
      );
      if (!fillRaw) throw new TradeInspectorNotFoundError(fillId);

      // 2. Order, intent — one query per table. DuckDB handles these in
      // O(microseconds) at this scale, and one-query-per-table keeps the
      // chain hops explicit.
      type RawOrder = {
        order_id: string;
        intent_id: string;
        broker: string;
        execution_mode: string;
        status: string;
        created_at: string;
        risk_checked_at: string | null;
        approved_at: string | null;
        submitted_at: string | null;
        completed_at: string | null;
        broker_order_id: string | null;
        operator_edits: string | null;
        risk_violations: string | null;
        halt_reason: string | null;
        broker_rejection_reason: string | null;
        quote_failure_reason: string | null;
        account_id: string;
      };
      const orderRaw = await runOne<RawOrder>(
        db,
        `SELECT order_id, intent_id, broker, execution_mode, status,
                created_at, risk_checked_at, approved_at, submitted_at,
                completed_at, broker_order_id, operator_edits,
                risk_violations, halt_reason, broker_rejection_reason,
                quote_failure_reason, account_id
         FROM audit_orders WHERE order_id = ?`,
        [fillRaw.order_id],
      );
      if (!orderRaw) {
        // FK constraint should make this unreachable, but surface
        // explicitly rather than NPE.
        throw new Error(
          `Inconsistent audit chain: fill ${fillId} references missing order ${fillRaw.order_id}`,
        );
      }

      type RawIntent = {
        intent_id: string;
        portfolio: string;
        strategy_id: string;
        symbol: string;
        direction: string;
        quantity: number;
        signal_ids: string;
        created_at: string;
      };
      const intentRaw = await runOne<RawIntent>(
        db,
        `SELECT intent_id, portfolio, strategy_id, symbol, direction,
                quantity, signal_ids, created_at
         FROM audit_intents WHERE intent_id = ?`,
        [orderRaw.intent_id],
      );
      if (!intentRaw) {
        throw new Error(
          `Inconsistent audit chain: order ${orderRaw.order_id} references missing intent ${orderRaw.intent_id}`,
        );
      }
      const signalIds = parseSignalIds(intentRaw.signal_ids);

      return {
        fill: {
          fill_id: fillRaw.fill_id,
          order_id: fillRaw.order_id,
          price: fillRaw.price,
          quantity: fillRaw.quantity,
          fees: fillRaw.fees,
          filled_at: fillRaw.filled_at,
          expected_price: fillRaw.expected_price,
          slippage: fillRaw.slippage,
          account_id: fillRaw.account_id,
        },
        order: {
          order_id: orderRaw.order_id,
          intent_id: orderRaw.intent_id,
          broker: orderRaw.broker,
          execution_mode: orderRaw.execution_mode,
          status: orderRaw.status,
          created_at: orderRaw.created_at,
          risk_checked_at: orderRaw.risk_checked_at,
          approved_at: orderRaw.approved_at,
          submitted_at: orderRaw.submitted_at,
          completed_at: orderRaw.completed_at,
          broker_order_id: orderRaw.broker_order_id,
          operator_edits: safeJsonParse(orderRaw.operator_edits),
          risk_violations: safeJsonParse(orderRaw.risk_violations),
          halt_reason: orderRaw.halt_reason,
          broker_rejection_reason: orderRaw.broker_rejection_reason,
          quote_failure_reason: orderRaw.quote_failure_reason,
          account_id: orderRaw.account_id,
        },
        intent: {
          intent_id: intentRaw.intent_id,
          portfolio: intentRaw.portfolio,
          strategy_id: intentRaw.strategy_id,
          symbol: intentRaw.symbol,
          direction: intentRaw.direction,
          quantity: intentRaw.quantity,
          signal_ids: signalIds,
          created_at: intentRaw.created_at,
        },
      };
    },
  };
}
