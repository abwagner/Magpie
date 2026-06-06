// ── audit_orders writer (upsert) ──────────────────────────────────────
// Persists Order state transitions to audit_orders. INSERT on first
// write, UPDATE thereafter (status + lifecycle timestamps + rejection
// reasons). Schema lives in server/db/init.ts.
//
// Defined in: docs/tdd/order-flow.md §3 (state machine) + §7.2
// (all-state-changes-persisted). M11 / QF-207.
//
// Why upsert (snapshot table) rather than append-only ledger:
// audit_orders is a one-row-per-order_id table whose row gets mutated
// via UPDATE as the order moves through its lifecycle. Cross-cutting
// TDD §5 shapes it this way (status + multiple lifecycle timestamps on
// the same row). A future ticket can layer a status_transitions
// ledger table on top if we need per-transition timestamps without
// losing previous states.

import type { Database } from "duckdb";
import type { Order, OperatorEdits, Violation } from "../../src/types/order.js";
import type { Logger } from "../logger.js";

// ── Row + writer types ────────────────────────────────────────────────

export interface AuditOrderRow {
  order_id: string;
  intent_id: string;
  // QF-310: broker-side idempotency token. Set at INSERT time and
  // immutable thereafter (not in the UPDATE list of the upsert below).
  // Equals Order.client_order_id, which equals OrderIntent.client_order_id
  // ?? OrderIntent.intent_id (v1 1-intent/1-submission default).
  // Optional here because the DDL column is nullable (additive-ALTER
  // backfill story) — production buildOrderRow always populates from
  // Order.client_order_id (which IS required). Older test fixtures
  // omit it.
  client_order_id?: string | null;
  broker: string;
  execution_mode: string;
  status: string;
  created_at: string;
  risk_checked_at: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  broker_order_id: string | null;
  // JSON-encoded OperatorEdits, or null when none.
  operator_edits: string | null;
  // JSON-encoded array of risk violations, or null.
  risk_violations: string | null;
  // Free-form reason string from PortfolioEngine.halt, or null.
  halt_reason: string | null;
  // QF-209: free-form reason from BrokerAdapter.onRejection. Populated
  // only on status='rejected_by_broker'.
  broker_rejection_reason: string | null;
  // QF-210: free-form reason for pre-submit rejection due to quote
  // unavailability. Populated only on status='rejected' when the
  // Execution Layer aborted before submit.
  quote_failure_reason: string | null;
  // QF-204: free-form cancel reason for status='cancelled' transitions
  // (signal_invalidated / operator / kill_switch / etc.).
  cancel_reason: string | null;
  // QF-319: writer-identity source per docs/tdd/order-flow.md §4.2.
  // Defaults to 'qf' (this writer is OPL-side). Observer-written rows
  // pass 'nt-native' explicitly. INSERT-only; never UPDATEd on retries.
  source: "qf" | "qf-gated" | "nt-native";
  // QF-319: chain anchor per observability.md §4.2. Optional on the row
  // shape because pre-QF-319 OPL paths don't generate one yet; OPL will
  // populate as that wiring lands.
  correlation_id: string | null;
  // QF-244: M12-2 — which Schwab account this order came from.
  // 'default' is the backward-compat value until M12-3 wires routing.
  account_id: string;
}

export type AuditOrderWriter = (row: AuditOrderRow) => Promise<void>;

// ── Row builder ───────────────────────────────────────────────────────

// Re-export so callers don't have to chase the canonical type through
// src/types/order.js. Shape: { limit, current, proposed, threshold, action }.
export type RiskViolation = Violation;

export interface BuildOrderRowArgs {
  order: Order;
  risk_violations?: RiskViolation[];
  halt_reason?: string;
  // QF-209 — populated on rejected_by_broker transitions.
  broker_rejection_reason?: string;
  // QF-210 — populated on pre-submit quote-unavailable rejections.
  quote_failure_reason?: string;
  // QF-204 — populated on status='cancelled' transitions.
  cancel_reason?: string;
  // QF-319 — writer-identity sourcing. OPL callers don't pass this and
  // the default 'qf' kicks in. The observer's own row-builder passes
  // 'nt-native' explicitly via a separate helper below.
  source?: "qf" | "qf-gated" | "nt-native";
  // QF-319 — chain anchor. Optional from OPL until the lifecycle ULID
  // wiring lands; observer rows always carry one (from NATS headers).
  correlation_id?: string | null;
  // QF-244 — M12-2: which Schwab account resolved this order.
  // Defaults to 'default' until M12-3 lands the routing account_id.
  account_id?: string;
}

export function buildOrderRow(args: BuildOrderRowArgs): AuditOrderRow {
  const { order } = args;
  return {
    order_id: order.order_id,
    intent_id: order.intent_id,
    client_order_id: order.client_order_id,
    broker: order.broker,
    execution_mode: order.execution_mode,
    status: order.status,
    created_at: order.created_at,
    risk_checked_at: order.risk_checked_at ?? null,
    approved_at: order.approved_at ?? null,
    submitted_at: order.submitted_at ?? null,
    completed_at: order.completed_at ?? null,
    broker_order_id: order.broker_order_id ?? null,
    operator_edits: serializeOperatorEdits(order.operator_edits ?? null),
    risk_violations: args.risk_violations ? JSON.stringify(args.risk_violations) : null,
    halt_reason: args.halt_reason ?? null,
    broker_rejection_reason: args.broker_rejection_reason ?? null,
    quote_failure_reason: args.quote_failure_reason ?? null,
    cancel_reason: args.cancel_reason ?? null,
    source: args.source ?? "qf",
    correlation_id: args.correlation_id ?? null,
    account_id: args.account_id ?? "default",
  };
}

// ── nt-native row builder (QF-319) ────────────────────────────────────
// The audit observer doesn't have a full Order — only the parsed
// BrokerExecReport. Build the row directly from observer-known fields.
// Caller is responsible for ensuring intent_id is not null (per the
// dedup-and-skip-null contract in docs/tdd/order-flow.md §4.1).
export interface BuildNtNativeOrderRowArgs {
  order_id: string;
  intent_id: string;
  broker: string;
  status: string;
  created_at: string;
  broker_order_id: string;
  broker_rejection_reason?: string | null;
  correlation_id?: string | null;
  // QF-244 — M12-2: which Schwab account this order came from.
  // Defaults to 'default' until M12-3 wires the NT-side account_id.
  account_id?: string;
}

export function buildNtNativeOrderRow(args: BuildNtNativeOrderRowArgs): AuditOrderRow {
  return {
    order_id: args.order_id,
    intent_id: args.intent_id,
    broker: args.broker,
    execution_mode: "live",
    status: args.status,
    created_at: args.created_at,
    risk_checked_at: null,
    approved_at: null,
    submitted_at: args.created_at,
    completed_at:
      args.status === "filled" || args.status === "rejected_by_broker" ? args.created_at : null,
    broker_order_id: args.broker_order_id,
    operator_edits: null,
    risk_violations: null,
    halt_reason: null,
    broker_rejection_reason: args.broker_rejection_reason ?? null,
    quote_failure_reason: null,
    cancel_reason: null,
    source: "nt-native",
    correlation_id: args.correlation_id ?? null,
    account_id: args.account_id ?? "default",
  };
}

function serializeOperatorEdits(edits: OperatorEdits | null): string | null {
  return edits ? JSON.stringify(edits) : null;
}

// ── DB-backed upsert writer ───────────────────────────────────────────
//
// DuckDB supports INSERT … ON CONFLICT DO UPDATE; we use it so the same
// callsite handles "first transition" (INSERT) and "later transitions"
// (UPDATE). The conflict target is the order_id primary key.

export function createAuditOrderWriter(db: Database, logger: Logger): AuditOrderWriter {
  return async (row: AuditOrderRow): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      db.run(
        // QF-319: source + correlation_id are INSERT-only. UPDATE clause
        // intentionally omits them — the original writer's identity is
        // immutable; later transitions (status updates) don't reattribute.
        // QF-244: account_id is also INSERT-only; it is set at submission
        // time and does not change as the order moves through its lifecycle.
        `INSERT INTO audit_orders (
           order_id, intent_id, client_order_id, broker, execution_mode, status,
           created_at, risk_checked_at, approved_at, submitted_at,
           completed_at, broker_order_id, operator_edits,
           risk_violations, halt_reason, broker_rejection_reason,
           quote_failure_reason, cancel_reason, source, correlation_id,
           account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           status                  = excluded.status,
           risk_checked_at         = excluded.risk_checked_at,
           approved_at             = excluded.approved_at,
           submitted_at            = excluded.submitted_at,
           completed_at            = excluded.completed_at,
           broker_order_id         = excluded.broker_order_id,
           operator_edits          = excluded.operator_edits,
           risk_violations         = excluded.risk_violations,
           halt_reason             = excluded.halt_reason,
           broker_rejection_reason = excluded.broker_rejection_reason,
           quote_failure_reason    = excluded.quote_failure_reason,
           cancel_reason           = excluded.cancel_reason`,
        // QF-310: client_order_id is INSERT-only (intentionally absent
        // from the UPDATE list). Retries reuse the same client_order_id
        // (broker dedup key) but a retry would either reuse the same
        // order_id (UPDATE) or generate a new order_id (INSERT with the
        // same client_order_id from intent_id derivation). In neither
        // case do we want to mutate client_order_id on UPDATE.
        row.order_id,
        row.intent_id,
        row.client_order_id ?? null,
        row.broker,
        row.execution_mode,
        row.status,
        row.created_at,
        row.risk_checked_at,
        row.approved_at,
        row.submitted_at,
        row.completed_at,
        row.broker_order_id,
        row.operator_edits,
        row.risk_violations,
        row.halt_reason,
        row.broker_rejection_reason,
        row.quote_failure_reason,
        row.cancel_reason,
        row.source,
        row.correlation_id,
        row.account_id,
        (err: Error | null) => {
          if (err) {
            logger.error("audit_orders write failed", {
              order_id: row.order_id,
              status: row.status,
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
