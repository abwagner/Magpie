// ── Order & Execution Types ────────────────────────────────────────
// Defined in: docs/tdd/order-execution.md

export type ExecutionMode = "paper_local" | "paper_broker" | "manual" | "semi-auto" | "auto";

export type OrderStatus =
  | "proposed"
  | "risk_check"
  | "approved"
  | "pending_approval"
  | "submitted"
  | "partial_fill"
  | "filled"
  | "rejected"
  | "cancelled"
  | "expired"
  | "submission_failed"
  // QF-209 — terminal state for orders the broker accepted at submit
  // but rejected asynchronously (exchange halt, locate failure, price
  // band breach, account suspension, etc.). Distinct from `rejected`
  // (pre-submit halt/risk) because the broker_order_id is populated.
  | "rejected_by_broker";

// QF-16 — shared limit-order primitives. Centralized here (rather than
// in src/types/execution.ts) because they're properties of orders;
// the Execution Layer imports them so its PricingDecision and
// ExecutionDefaults speak the same vocabulary as OrderIntent.
export type OrderType = "market" | "limit";
export type TimeInForce = "day" | "gtc" | "ioc" | "fok";

export interface OrderIntent {
  intent_id: string;
  // QF-310 — broker-side idempotency token. Distinct from intent_id
  // (audit PK) and order_id (per-submission PK) to give retries a
  // stable handle the broker can dedup against. Optional at intent
  // creation; OPL derives `client_order_id = intent_id` when absent
  // (v1 1-intent/1-submission default). When a future ExecAlgorithm
  // emits multiple broker submissions per intent, each child carries
  // its own distinct client_order_id. See broker-integration.md §4.1.
  client_order_id?: string;
  portfolio: string;
  strategy_id: string;
  action: "open" | "close";
  symbol: string;
  direction: "Long" | "Short" | "close";
  quantity: number;
  reason: string;
  signal_ids: string[];
  position_id?: string;
  created_at: string;
  // ── QF-16 — limit-order fields ────────────────────────────────────
  // All optional; absent fields preserve market-order behavior. The
  // Execution Layer (decidePrice) populates them when the resolved
  // pricing strategy returns a limit decision; the Order Plane
  // records them for audit + downstream broker submission.
  order_type?: OrderType;
  // Required when `order_type === "limit"`. Type-only contract here —
  // runtime invariant lives in the Order Plane's intent-creation path.
  limit_price?: number;
  time_in_force?: TimeInForce;
  // Working-order lifecycle hints. The Execution Layer enforces TTL;
  // the Order Plane stores both for audit so a row in audit_orders
  // can be traced back to its execution profile composition.
  working_ttl_ms?: number;
  working_policy_id?: string;
}

export interface Fill {
  fill_id: string;
  order_id: string;
  intent_id: string;
  portfolio: string;
  symbol: string;
  direction: string;
  quantity: number;
  price: number;
  fees: number;
  filled_at: string;
  broker: string;
  broker_order_id?: string;
  v?: number;
}

export interface Order {
  order_id: string;
  intent_id: string;
  // QF-310 — broker-side idempotency token threaded through to the
  // broker's native client_order_id field. Populated by OPL at order
  // construction time; immutable for the order's lifetime. v1: equals
  // the OrderIntent's client_order_id, which itself defaults to
  // intent_id. See src/types/order.ts OrderIntent.client_order_id and
  // broker-integration.md §4.1.
  client_order_id: string;
  portfolio: string;
  broker: string;
  execution_mode: ExecutionMode;
  status: OrderStatus;
  created_at: string;
  risk_checked_at?: string;
  approved_at?: string;
  submitted_at?: string;
  completed_at?: string;
  broker_order_id?: string;
  // QF-16 — set on replacement orders so the audit trail can walk the
  // chain of replacements back to the original submission. Null /
  // absent on first-submission orders.
  replaces_order_id?: string;
  // QF-50 — only fields the operator overrode at approve time.
  // Computed as the diff against the original intent's
  // Execution-Layer-produced recommendation. Null when the operator
  // approved without any modifications.
  operator_edits?: OperatorEdits | null;
  // QF-208 — cumulative fill arithmetic across one or more partial
  // fills from the broker. filled_quantity counts up as fills arrive;
  // when it equals intent.quantity the order transitions to "filled".
  // average_fill_price is the volume-weighted average of all fills so
  // far (single-fill orders set it to the lone fill's price). Both are
  // null/0 until the first fill.
  filled_quantity?: number;
  average_fill_price?: number;
}

// QF-50 — operator-supplied overrides applied when approving an order
// from manual mode. Each present key indicates the operator chose to
// override the Execution Layer's recommendation for that field. The
// audit trail stores this as JSON in `audit_orders.operator_edits`;
// null means the operator approved without changes.
export interface OperatorEdits {
  order_type?: OrderType;
  limit_price?: number;
  time_in_force?: TimeInForce;
  working_policy_id?: string;
}

export interface RiskCheckResult {
  ok: boolean;
  violations: Violation[];
}

export interface Violation {
  limit: string;
  current: number;
  proposed: number;
  threshold: number;
  action: "reject" | "halt";
}

// QF-234 — contract split. Brokers QF actively submits to implement
// OrderSubmissionAdapter; brokers QF only observes (IBKR via NT, per
// docs/tdd/broker-integration.md) implement OrderObservationAdapter.
// `BrokerAdapter` is preserved as an intersection alias so existing
// call sites that hold the combined surface keep compiling — QF-236
// removes the alias once internal references are migrated.

export interface OrderSubmissionAdapter {
  name: string;
  available(): Promise<boolean>;
  submitOrder(params: SubmitOrderParams): Promise<string>;
  cancelOrder(brokerOrderId: string): Promise<void>;
}

export interface OrderObservationAdapter {
  name: string;
  available(): Promise<boolean>;
  // QF-234 — restart-reconciliation hook (QF-230 calls this on startup
  // to detect orders QF thinks are open but the broker has already
  // filled/cancelled while QF was down). Brokers that don't expose a
  // status query return { status: "unknown", ... }.
  getOrderStatus(brokerOrderId: string): Promise<BrokerOrderStatus>;
  getPositions(): Promise<BrokerPosition[]>;
  onFill(callback: (fill: Fill) => void): void;
  // QF-209 — optional. Brokers that surface async rejection (exchange
  // halt, locate failure, price band breach, account suspension) wire
  // this callback. The Order Plane looks up the matching order by
  // broker_order_id and transitions it to "rejected_by_broker".
  onRejection?(callback: (rejection: BrokerRejection) => void): void;
}

export type BrokerAdapter = OrderSubmissionAdapter & OrderObservationAdapter;

// QF-209 — emitted by BrokerAdapter.onRejection.
export interface BrokerRejection {
  broker_order_id: string;
  // Short summary suitable for an operator-facing UI / log line.
  reason: string;
  // Optional vendor-specific code (e.g., Schwab's REJECT_REASON, IBKR's
  // errorCode). Useful for downstream classification but not parsed.
  broker_reason_code?: string;
  rejected_at: string;
}

export interface SubmitOrderParams {
  // QF-310 — broker-side idempotency token. Passed through to the
  // broker's native client_order_id field by the Python NT bridge so
  // a 504-window retry (broker accepted, reply lost) gets recognized
  // as a duplicate at the broker rather than creating a second order.
  // Required for every submission. See broker-integration.md §4.1.
  client_order_id: string;
  symbol: string;
  direction: string;
  quantity: number;
  orderType: "market" | "limit";
  limitPrice?: number;
}

export interface BrokerPosition {
  symbol: string;
  direction: string;
  quantity: number;
}

// QF-234 — reply payload for OrderObservationAdapter.getOrderStatus.
// Used by restart reconciliation (QF-230) to detect QF-vs-broker
// disagreements at startup. "unknown" is a real return value for
// brokers that don't expose a per-order status query.
export interface BrokerOrderStatus {
  broker_order_id: string;
  status: "working" | "filled" | "partial_fill" | "cancelled" | "rejected" | "unknown";
  filled_quantity: number;
  average_fill_price: number | null;
  rejection_reason: string | null;
}

// QF-233 — wire format for execution reports flowing TS ← Python over
// `orders.exec_reports.<broker>` (one-way pub). Schema mirrored in
// the Python NT bridge as a pydantic model so both runtimes share
// field names. The NT bridge constructs one per NT OrderEvent
// (Fill, PartialFill, Cancelled, Rejected, Submitted) and publishes
// onto the broker-specific subject. See docs/tdd/broker-integration.md §3.
export interface BrokerExecReport {
  broker: string;
  broker_order_id: string;
  event: "fill" | "partial_fill" | "cancelled" | "rejected" | "submitted";
  // ISO-8601 timestamp from NT's OrderEvent.
  ts: string;
  // Populated on event === "fill" | "partial_fill".
  fill?: {
    fill_id: string;
    price: number;
    quantity: number;
    fees: number | null;
  };
  // Populated on event === "rejected".
  rejection_reason?: string;
  // Optional vendor-specific code (Schwab REJECT_REASON, IBKR errorCode).
  broker_reason_code?: string;
  // QF-319 — chain back-reference. Set on QF-mediated orders (OPL/gate
  // recorded the intent_id when the order went out) and null on
  // pure-NT-native orders where no QF parent intent exists. Python
  // brokers (schwab-nt, ibkr-nt) already emit this field per their wire
  // contract; the IBKR bridge always sends null (NT-side initiated).
  intent_id?: string | null;
  // QF-319 — correlation_id from NATS X-Correlation-Id header threading.
  // Falls through here when present in the wire payload; observer also
  // reads from NATS headers as the primary source.
  correlation_id?: string | null;
}
