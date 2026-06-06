// ── Restart Recovery (QF-214) ─────────────────────────────────────────
// Rebuilds the OrderPlane's in-memory state from audit_orders + audit_intents
// after a server restart. Without this, restart mid-trading-day loses the
// entire active order book; with it, the active book + working-order
// monitor index are re-hydrated from durable storage.
//
// Defined in: docs/tdd/order-flow.md §3 (state machine) + this ticket.
//
// Scope of v1:
//   * OrderPlane rehydration. Query audit_orders for non-terminal rows;
//     join with audit_intents; populate OrderPlane's internal maps via
//     the new `rehydrate()` method.
//   * Working-order monitor rehydration. After OrderPlane rebuilds, walk
//     its active orders, parse `audit_intents.originating_signal_json`,
//     and call `monitor.addTask()` for each cancel_on_signal_invalidate
//     order.
//
// Reconciliation (QF-230):
//   * Broker reconciliation — after rehydrateOrderPlane, walks every
//     rehydrated order with a non-null broker_order_id + non-terminal
//     status; calls broker.getOrderStatus and applies the policy table
//     from docs/tdd/broker-integration.md §5 to catch up on filled /
//     cancelled / rejected transitions that happened while QF was down.
//     Emits a restart_recovery alert summarizing the pass.
//
// audit_fills replay (QF-231):
//   * Partial-fill aggregates (filled_quantity, average_fill_price) are
//     re-summed from audit_fills so the in-memory VWAP composes
//     correctly with any post-restart fills.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type {
  BrokerOrderStatus,
  BrokerRejection,
  Fill,
  Order,
  OrderIntent,
  OrderObservationAdapter,
  OrderStatus,
} from "../../src/types/order.js";

type OrderDirection = OrderIntent["direction"];
import type { OrderPlane } from "./plane.js";
import type { AlertRouter } from "../alerts/router.js";

// Terminal states — these orders are done and don't need rehydrating.
// Mirrors the set in working-order-monitor.ts's attachOrderUpdateLifecycle.
const TERMINAL_STATUSES = new Set<OrderStatus>([
  "filled",
  "cancelled",
  "rejected",
  "expired",
  "submission_failed",
  "rejected_by_broker",
]);

// ── Raw audit-row shapes (DuckDB → JS) ────────────────────────────────

interface RawOrderRow {
  order_id: string;
  intent_id: string;
  // QF-310: nullable in the row shape because the column is added via
  // additive ALTER on existing installs (no backfill). Rehydration
  // falls back to intent_id for pre-QF-310 rows. Fresh installs write
  // NOT NULL via the CREATE TABLE definition in server/db/init.ts.
  client_order_id: string | null;
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
}

interface RawIntentRow {
  intent_id: string;
  signal_ids: string;
  portfolio: string;
  symbol: string;
  direction: string;
  quantity: number;
  strategy_id: string;
  created_at: string;
  originating_signal_json: string | null;
}

// ── Public types ──────────────────────────────────────────────────────

export interface RehydrationStats {
  // Orders re-loaded into OrderPlane's in-memory maps.
  orders_loaded: number;
  // Working-order tasks re-registered with the monitor.
  monitor_tasks_loaded: number;
  // Orders whose intent rows weren't found (FK drift; shouldn't happen
  // but we log + drop rather than crash).
  orders_skipped_missing_intent: number;
  // Orders whose originating_signal_json was null. They land in
  // OrderPlane but the working-order monitor can't track them.
  monitor_tasks_skipped_no_signal: number;
}

// ── Implementation ────────────────────────────────────────────────────

function runQuery<T>(db: Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

function parseIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // DuckDB returns TIMESTAMP as a JS Date in some configurations; the
  // existing audit_orders writer feeds it back as a string. Normalize
  // here so the in-memory Order matches what the writer produces.
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function parseOperatorEdits(s: string | null): Order["operator_edits"] {
  if (!s) return null;
  try {
    return JSON.parse(s) as Order["operator_edits"];
  } catch {
    return null;
  }
}

function parseSignalIds(raw: string): string[] {
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

function parseOriginatingSignal(s: string | null): unknown | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

// QF-231 — sum audit_fills per order in a single GROUP BY. Restoring
// filled_quantity / average_fill_price from the durable record so the
// VWAP arithmetic in plane.ts's onFill handler keeps composing correctly
// after restart. Returns empty map when no orderIds are passed (saves a
// no-op query). Volume-weighted average is the canonical convention
// (matches QF-208): avg = Σ(price × qty) / Σ(qty).
interface FillAggregate {
  filled_quantity: number;
  average_fill_price: number;
}

interface RawFillAggregateRow {
  order_id: string;
  // DuckDB SUM(INTEGER) returns BigInt; SUM(DOUBLE) returns number.
  // Both shapes get coerced to number before exposure.
  filled_quantity: number | bigint;
  average_fill_price: number;
}

async function loadFillAggregates(
  db: Database,
  orderIds: string[],
): Promise<Map<string, FillAggregate>> {
  if (orderIds.length === 0) return new Map();
  const placeholders = orderIds.map(() => "?").join(",");
  const rows = await runQuery<RawFillAggregateRow>(
    db,
    `SELECT order_id,
            SUM(quantity) AS filled_quantity,
            SUM(price * quantity) / NULLIF(SUM(quantity), 0) AS average_fill_price
     FROM audit_fills
     WHERE order_id IN (${placeholders})
     GROUP BY order_id`,
    orderIds,
  );
  const out = new Map<string, FillAggregate>();
  for (const row of rows) {
    out.set(row.order_id, {
      filled_quantity: Number(row.filled_quantity),
      average_fill_price: Number(row.average_fill_price),
    });
  }
  return out;
}

function rehydrateOrder(row: RawOrderRow): Order {
  // Cast through the OrderStatus union — the DB column is a free-form
  // string, but every value we ever write is from the QF-209 enum.
  const status = row.status as OrderStatus;
  const order: Order = {
    order_id: row.order_id,
    intent_id: row.intent_id,
    // QF-310: fall back to intent_id for pre-QF-310 rows where the
    // ALTER-added column is null. New rows always have a value.
    client_order_id: row.client_order_id ?? row.intent_id,
    portfolio: "", // filled in below from the joined intent
    broker: row.broker,
    execution_mode: row.execution_mode as Order["execution_mode"],
    status,
    created_at: parseIso(row.created_at) ?? new Date().toISOString(),
  };
  const checked = parseIso(row.risk_checked_at);
  if (checked) order.risk_checked_at = checked;
  const approved = parseIso(row.approved_at);
  if (approved) order.approved_at = approved;
  const submitted = parseIso(row.submitted_at);
  if (submitted) order.submitted_at = submitted;
  const completed = parseIso(row.completed_at);
  if (completed) order.completed_at = completed;
  if (row.broker_order_id) order.broker_order_id = row.broker_order_id;
  const edits = parseOperatorEdits(row.operator_edits);
  if (edits) order.operator_edits = edits;
  return order;
}

function rehydrateIntent(row: RawIntentRow): OrderIntent {
  return {
    intent_id: row.intent_id,
    portfolio: row.portfolio,
    strategy_id: row.strategy_id,
    action: "open", // not persisted today; rehydration is best-effort
    symbol: row.symbol,
    direction: row.direction as OrderDirection,
    quantity: row.quantity,
    reason: "rehydrated",
    signal_ids: parseSignalIds(row.signal_ids),
    created_at: parseIso(row.created_at) ?? new Date().toISOString(),
  };
}

// QF-214 — rehydrate the OrderPlane's in-memory maps from durable
// audit storage. Idempotent: calling twice with the same DB content
// produces the same in-memory state.
export async function rehydrateOrderPlane(
  orderPlane: OrderPlane,
  db: Database,
  logger: Logger,
): Promise<RehydrationStats> {
  const stats: RehydrationStats = {
    orders_loaded: 0,
    monitor_tasks_loaded: 0,
    orders_skipped_missing_intent: 0,
    monitor_tasks_skipped_no_signal: 0,
  };

  // 1. Load non-terminal orders.
  const terminalList = Array.from(TERMINAL_STATUSES);
  const placeholders = terminalList.map(() => "?").join(",");
  const orderRows = await runQuery<RawOrderRow>(
    db,
    `SELECT order_id, intent_id, client_order_id, broker, execution_mode, status,
            created_at, risk_checked_at, approved_at, submitted_at,
            completed_at, broker_order_id, operator_edits
     FROM audit_orders
     WHERE status NOT IN (${placeholders})`,
    terminalList,
  );

  if (orderRows.length === 0) {
    logger.info("restart-recovery: no non-terminal orders to rehydrate");
    return stats;
  }

  // 2. Load matching intents in one query (much faster than N+1).
  const intentIds = orderRows.map((r) => r.intent_id);
  const intentPlaceholders = intentIds.map(() => "?").join(",");
  const intentRows = await runQuery<RawIntentRow>(
    db,
    `SELECT intent_id, signal_ids, portfolio, symbol, direction,
            quantity, strategy_id, created_at, originating_signal_json
     FROM audit_intents
     WHERE intent_id IN (${intentPlaceholders})`,
    intentIds,
  );
  const intentsByIntentId = new Map(intentRows.map((r) => [r.intent_id, r]));

  // 3. QF-231 — load per-order fill aggregates so partial-fill state
  // survives restart. Single GROUP BY query keeps it fast; orders with
  // no fills don't appear in the result and default to undefined.
  const orderIds = orderRows.map((r) => r.order_id);
  const fillAggregates = await loadFillAggregates(db, orderIds);

  // 4. Hand each (order, intent) pair to OrderPlane.
  for (const orderRow of orderRows) {
    const intentRow = intentsByIntentId.get(orderRow.intent_id);
    if (!intentRow) {
      stats.orders_skipped_missing_intent++;
      logger.warn("restart-recovery: order references missing intent", {
        order_id: orderRow.order_id,
        intent_id: orderRow.intent_id,
      });
      continue;
    }
    const order = rehydrateOrder(orderRow);
    order.portfolio = intentRow.portfolio;
    const aggregate = fillAggregates.get(orderRow.order_id);
    if (aggregate) {
      order.filled_quantity = aggregate.filled_quantity;
      order.average_fill_price = aggregate.average_fill_price;
      // QF-231 — over-fill detection at rehydration. Mirrors plane.ts's
      // onFill guard: log loudly but don't mask the broker contract
      // violation. The order's status is whatever audit_orders said it
      // was; we don't transition it here.
      if (aggregate.filled_quantity > intentRow.quantity) {
        logger.error("restart-recovery: rehydrated order has over-fill", {
          order_id: orderRow.order_id,
          intent_quantity: intentRow.quantity,
          cumulative_filled: aggregate.filled_quantity,
        });
      }
    }
    const intent = rehydrateIntent(intentRow);
    orderPlane.rehydrateOrder(order, intent);
    stats.orders_loaded++;
  }

  logger.info("restart-recovery: OrderPlane rehydrated", {
    orders_loaded: stats.orders_loaded,
    skipped_missing_intent: stats.orders_skipped_missing_intent,
  });
  return stats;
}

// ── Broker Reconciliation (QF-230) ───────────────────────────────────

export interface ReconciliationStats {
  checked: number;
  working: number;
  filled_synthesized: number;
  cancelled_synthesized: number;
  rejected_synthesized: number;
  unknown: number;
  errors: number;
}

// QF-230 — walk rehydrated orders, ask broker.getOrderStatus what
// actually happened while QF was down, transition any state drift.
// Policy table per docs/tdd/broker-integration.md §5:
//
//   QF state at startup | Broker state            | Action
//   --------------------|-------------------------|----------------------------
//   submitted/partial   | working                 | leave alone
//   submitted/partial   | filled / partial_fill   | synthesize Fill for missing
//                       |                         | quantity at broker's VWAP
//   submitted/partial   | cancelled               | orderPlane.cancel with
//                       |                         | reason=reconciled_at_startup
//   submitted/partial   | rejected                | synthesize BrokerRejection
//                       |                         | (transitions to rejected_by_broker)
//   submitted/partial   | unknown                 | leave alone, log + count
//
// Orders QF doesn't have an audit_orders row for are invisible to QF
// (intentional — see broker-integration.md §2.3); this walk only
// reconciles orders QF originated.
export async function reconcileOrdersWithBroker(
  orderPlane: OrderPlane,
  broker: OrderObservationAdapter,
  logger: Logger,
  alertRouter?: AlertRouter,
): Promise<ReconciliationStats> {
  const stats: ReconciliationStats = {
    checked: 0,
    working: 0,
    filled_synthesized: 0,
    cancelled_synthesized: 0,
    rejected_synthesized: 0,
    unknown: 0,
    errors: 0,
  };

  const candidates = orderPlane.listOrders().filter((o) => {
    if (TERMINAL_STATUSES.has(o.status)) return false;
    if (!o.broker_order_id) return false;
    return true;
  });

  for (const order of candidates) {
    stats.checked++;
    let brokerStatus: BrokerOrderStatus;
    try {
      brokerStatus = await broker.getOrderStatus(order.broker_order_id!);
    } catch (err) {
      stats.errors++;
      logger.error("reconcile: getOrderStatus failed", {
        order_id: order.order_id,
        broker_order_id: order.broker_order_id,
        error: String(err),
      });
      continue;
    }

    if (brokerStatus.status === "unknown") {
      stats.unknown++;
      logger.warn("reconcile: broker reports unknown for order QF tracks", {
        order_id: order.order_id,
        broker_order_id: order.broker_order_id,
      });
      continue;
    }
    if (brokerStatus.status === "working") {
      stats.working++;
      continue;
    }

    if (brokerStatus.status === "filled" || brokerStatus.status === "partial_fill") {
      const localQty = order.filled_quantity ?? 0;
      const brokerQty = brokerStatus.filled_quantity;
      const diff = brokerQty - localQty;
      if (diff <= 0) {
        // Broker reports filled but QF already has the audit row; no-op.
        // (Happens when QF wrote the audit_fills before crashing without
        // updating audit_orders to the matching terminal status — rare.)
        continue;
      }
      const price = brokerStatus.average_fill_price ?? 0;
      const syntheticFill: Fill = {
        fill_id: `recon-${order.order_id}-${Date.now()}`,
        order_id: order.order_id,
        intent_id: order.intent_id,
        portfolio: order.portfolio,
        symbol: "", // enrichment happens in handleBrokerFill via the matched order
        direction: "",
        quantity: diff,
        price,
        fees: 0,
        filled_at: new Date().toISOString(),
        broker: order.broker,
        broker_order_id: order.broker_order_id!,
      };
      orderPlane.applyReconciledFill(syntheticFill);
      stats.filled_synthesized++;
      logger.warn("reconcile: synthesized missing fill from broker", {
        order_id: order.order_id,
        missing_quantity: diff,
        broker_avg_price: price,
      });
      continue;
    }

    if (brokerStatus.status === "cancelled") {
      await orderPlane.cancel(order.order_id, { reason: "reconciled_at_startup" });
      stats.cancelled_synthesized++;
      logger.warn("reconcile: synthesized cancel from broker", {
        order_id: order.order_id,
      });
      continue;
    }

    if (brokerStatus.status === "rejected") {
      const syntheticRejection: BrokerRejection = {
        broker_order_id: order.broker_order_id!,
        reason: brokerStatus.rejection_reason ?? "reconciled_at_startup",
        rejected_at: new Date().toISOString(),
      };
      orderPlane.applyReconciledRejection(syntheticRejection);
      stats.rejected_synthesized++;
      logger.warn("reconcile: synthesized broker rejection", {
        order_id: order.order_id,
        reason: syntheticRejection.reason,
      });
      continue;
    }
  }

  logger.info("restart-recovery: broker reconciliation complete", { ...stats });

  if (alertRouter && stats.checked > 0) {
    const reconciled =
      stats.filled_synthesized + stats.cancelled_synthesized + stats.rejected_synthesized;
    const level = stats.unknown > 0 || stats.errors > 0 ? "warning" : "info";
    const payload: Record<string, unknown> = {
      checked: stats.checked,
      working: stats.working,
      filled_synthesized: stats.filled_synthesized,
      cancelled_synthesized: stats.cancelled_synthesized,
      rejected_synthesized: stats.rejected_synthesized,
      unknown: stats.unknown,
      errors: stats.errors,
    };
    alertRouter
      .record({
        type: "restart_recovery",
        level,
        message: `Restart recovery: ${stats.checked} orders checked, ${reconciled} reconciled, ${stats.unknown} unreconciled`,
        payload,
      })
      .catch((err) => {
        logger.warn("reconcile: alert dispatch failed", { error: String(err) });
      });
  }

  return stats;
}
