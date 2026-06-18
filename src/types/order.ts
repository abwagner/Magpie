// ── Order & Execution Types ────────────────────────────────────────
// Defined in: docs/tdd/order-execution.md

// QF-263 (M14-1 Architecture B) — the Order Plane is narrowed to
// operator manual entry + kill-switch only. The retired auto / semi-auto
// / paper_broker modes lived in the old auto-execution path now owned by
// NT strategies. "paper_local" is the in-process fill simulator;
// "manual" parks every order in pending_approval for an operator.
export type ExecutionMode = "paper_local" | "manual";

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
  | "rejected_by_broker"
  // QF-309 — option-lifecycle terminal states (additive per
  // docs/tdd/portfolio-risk-engine.md §11.3). `expired` (above) covers
  // worthless expiry; `assigned` is a short option assigned by the
  // counterparty; `exercised` is a long option auto-exercised at expiry.
  // All three land as audit_orders rows with source='nt-native' (broker
  // push) or source='qf' (calendar-swept worthless expiry).
  | "assigned"
  | "exercised";

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
  // QF-245 — M12-3: target brokerage account id (the
  // SchwabAccountConfig.id from config/brokers.json). The strategy
  // runner resolves it from the portfolio's routing config at
  // intent-creation time so the Order Plane doesn't have to re-resolve
  // per submit. Optional: legacy intents leave it unset and the Order
  // Plane falls back to the portfolio→account map, then the default
  // account.
  account_id?: string;
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
  // ── QF-362 — multi-leg combo orders ───────────────────────────────
  // Present ⇒ this intent is a multi-leg option combo (vertical,
  // calendar, condor, …). The parent intent describes the aggregate;
  // `legs` are the child legs that compose it. `symbol` is the
  // underlying, `quantity` the number of combo units, and (for a limit)
  // `limit_price` the NET price per combo unit (debit > 0, credit < 0).
  // At the IBKR boundary the combo is submitted as ONE BAG/spread order
  // at the net price (verified NT API), so the legs are representational
  // + the source of the broker's comboLegs — not separate submissions.
  legs?: ComboLegSpec[];
}

// A leg of a multi-leg combo at intent time. `option_symbol` is the
// per-leg option symbol (OCC / broker form) from the chain; `broker_conid`
// is resolved by the broker bridge (IBKR conId) when building the combo.
export interface ComboLegSpec {
  leg_id: string;
  right: "call" | "put";
  side: "buy" | "sell";
  ratio: number;
  option_symbol: string;
  strike: number;
  expiration: string;
  broker_conid?: number;
}

// A child leg of a live combo Order, with fill allocation. The combo
// fills as a unit at a net price; per-leg quantity = combo units × ratio,
// and `average_fill_price` is the leg's allocated share of the net fill.
export interface OrderLeg extends ComboLegSpec {
  filled_quantity?: number;
  average_fill_price?: number;
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
  // QF-246 — M12-4: originating brokerage account id. Stamped by the
  // broker adapter on fan-out (from the exec report's account_id, or the
  // adapter's configured account when the report omits it). Optional:
  // legacy single-account ("default") fills + paper fills leave it unset.
  account_id?: string;
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
  // QF-362 — child legs when this order is a multi-leg combo (mirrors
  // the parent intent's `legs`, carrying per-leg fill allocation). Absent
  // for single-leg orders.
  legs?: OrderLeg[];
  // QF-247 — M12-5: brokerage account this order routed to (the
  // SchwabAccountConfig.id from config/brokers.json). Mirrors the
  // audit_orders.account_id column written at submission time (QF-244).
  // Optional in the in-memory shape: OPL keeps the authoritative routing
  // account in its own order_id→account map, but restart recovery stamps
  // it here from the durable audit row so reconciliation can partition
  // the walk by account. Legacy single-account ("default") + paper
  // orders may leave it unset.
  account_id?: string;
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
  // QF-272 — optional account discovery (account number / hash / type).
  // Only the live brokers that front a real account (NT bridge) implement
  // it; paper / observation-only adapters omit it and callers fall back.
  getAccounts?(): Promise<BrokerAccount[]>;
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
  // QF-246 — M12-4: originating brokerage account id, mirroring Fill's
  // account_id. The broker adapter stamps it on fan-out (from the exec
  // report's account_id, or the adapter's configured account when the
  // report omits it). Optional: legacy single-account ("default") deploys
  // + paper rejections leave it unset. Drives audit attribution (M12-3).
  account_id?: string;
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
  // QF-363 — multi-leg combo legs. When present, the Python bridge builds
  // ONE IBKR BAG/spread order from these (`symbol` = underlying, `quantity`
  // = combo units, the net price is the limit). `legs` is the same wire key
  // on both sides; see broker-integration.md for the combo contract.
  legs?: ComboLegSpec[];
}

export interface BrokerPosition {
  symbol: string;
  direction: string;
  quantity: number;
  // QF-272 — optional broker-native raw position row. The Schwab NT
  // bridge forwards the raw `/accounts?fields=positions` row here so the
  // GUI's /api/positions can run the same categorization parser the REST
  // fallback uses. Reconciliation ignores it; brokers that don't carry a
  // raw row (paper) omit it.
  raw?: Record<string, unknown>;
}

// QF-272 — account discovery metadata for /api/accounts. Mirrors the
// Schwab REST `SchwabAccount` shape; served via the NT bridge's
// `orders.accounts.<broker>` subject (REST fallback when NT is down).
export interface BrokerAccount {
  accountNumber: string;
  hashValue: string;
  type?: string;
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
  // QF-246 — M12-4: originating brokerage account id. The Python bridge
  // sets it on per-account ("non-default") deploys and omits it for the
  // legacy single-account deploy; the adapter falls back to its own
  // configured account when absent. Drives audit attribution (M12-3).
  account_id?: string;
}
