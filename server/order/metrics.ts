// ── OrderPlane Metrics ────────────────────────────────────────────────
// Prometheus instrumentation for the OrderPlane state machine, per
// docs/tdd/order-flow.md §3 + QF-217.
//
// Audit_orders (QF-207) captures the durable per-row trail used for
// forensics + reconstruction. These counters serve a different
// purpose: aggregate time-series dashboards (e.g. "broker rejection
// rate trending up over the last hour" pages on-call) without
// scanning DuckDB. Both surfaces are needed — they don't substitute.
//
// The Registry is isolated (matches QF-52 / QF-28 module pattern) so
// tests can spin up a fresh registry per describe block and the
// eventual /metrics handler composes module registries via
// Aggregator without naming collisions.

import { Counter, Histogram, Registry } from "prom-client";

// ── Types ─────────────────────────────────────────────────────────────

export interface OrderPlaneMetrics {
  registry: Registry;
  // Every submit() that reaches the broker (post-risk-gate, post-approval).
  ordersSubmittedTotal: Counter<"portfolio" | "broker" | "mode">;
  // Every broker fill. `partial="true"` for partial-fill rows; `"false"`
  // when the cumulative qty matches the intent (final fill).
  ordersFilledTotal: Counter<"portfolio" | "broker" | "partial">;
  // Pre-submit rejections. reason ∈ {risk, halt, quote_unavailable, manual}.
  ordersRejectedTotal: Counter<"portfolio" | "reason">;
  // QF-209 async broker rejections. broker_reason_code carries the
  // vendor-supplied identifier (Schwab REJECT_REASON, IBKR errorCode)
  // for cross-broker comparison; the human-readable reason is stored
  // in audit_orders.broker_rejection_reason for the forensic trail.
  ordersRejectedByBrokerTotal: Counter<"portfolio" | "broker" | "broker_reason_code">;
  // Manual + monitor-driven cancels. reason is supplied by the cancel
  // caller; kill-switch cancels carry reason="kill_switch".
  ordersCancelledTotal: Counter<"portfolio" | "reason">;
  // Observed at terminal-state transition (created_at → completed_at).
  // terminal_state ∈ {filled, cancelled, rejected, rejected_by_broker}.
  orderLifecycleDurationSeconds: Histogram<"portfolio" | "terminal_state" | "broker">;
  // QF-247 — restart reconciliation skipped an account's orders because
  // no broker adapter resolved for that account_id (e.g. the account was
  // disabled in brokers.json but audit_orders still carries rows from a
  // prior enabled period). reason ∈ {adapter_missing}.
  brokerReconcileSkippedTotal: Counter<"reason" | "account_id">;
}

// Order lifecycle spans from ~ms (immediate broker fills) to hours
// (resting passive orders that ultimately fill or cancel near close).
// Geometric-ish bucket progression mirrors execution-layer metrics.ts's
// WORKING_ORDER_AGE_BUCKETS so dashboards composed across both surfaces
// share x-axis resolution.
const LIFECYCLE_BUCKETS = [0.01, 0.1, 1, 5, 30, 60, 300, 1800, 3600, 14400];

export function createOrderPlaneMetrics(registry?: Registry): OrderPlaneMetrics {
  const reg = registry ?? new Registry();

  const ordersSubmittedTotal = new Counter({
    name: "orders_submitted_total",
    help: "Orders submitted to a broker (post-risk-gate, post-approval).",
    labelNames: ["portfolio", "broker", "mode"] as const,
    registers: [reg],
  });

  const ordersFilledTotal = new Counter({
    name: "orders_filled_total",
    help: "Fills received from a broker; partial='true' on partial-fill events.",
    labelNames: ["portfolio", "broker", "partial"] as const,
    registers: [reg],
  });

  const ordersRejectedTotal = new Counter({
    name: "orders_rejected_total",
    help: "Pre-submit rejections (risk gate, halt, quote-unavailable, manual).",
    labelNames: ["portfolio", "reason"] as const,
    registers: [reg],
  });

  const ordersRejectedByBrokerTotal = new Counter({
    name: "orders_rejected_by_broker_total",
    help: "Async broker rejections delivered via BrokerAdapter.onRejection.",
    labelNames: ["portfolio", "broker", "broker_reason_code"] as const,
    registers: [reg],
  });

  const ordersCancelledTotal = new Counter({
    name: "orders_cancelled_total",
    help: "Cancels — manual operator, monitor-driven policy, or kill-switch.",
    labelNames: ["portfolio", "reason"] as const,
    registers: [reg],
  });

  const orderLifecycleDurationSeconds = new Histogram({
    name: "order_lifecycle_duration_seconds",
    help: "Time from Order.created_at to terminal-state completed_at.",
    labelNames: ["portfolio", "terminal_state", "broker"] as const,
    buckets: LIFECYCLE_BUCKETS,
    registers: [reg],
  });

  const brokerReconcileSkippedTotal = new Counter({
    name: "broker_reconcile_skipped_total",
    help: "Restart reconciliation skipped an account's orders (no adapter resolved).",
    labelNames: ["reason", "account_id"] as const,
    registers: [reg],
  });

  return {
    registry: reg,
    ordersSubmittedTotal,
    ordersFilledTotal,
    ordersRejectedTotal,
    ordersRejectedByBrokerTotal,
    ordersCancelledTotal,
    orderLifecycleDurationSeconds,
    brokerReconcileSkippedTotal,
  };
}
