// ── Order & Execution Plane ────────────────────────────────────────
// Order lifecycle state machine: intent → risk check → approval → submit → fill
// Defined in: docs/tdd/order-execution.md

import type {
  OrderIntent,
  Order,
  Fill,
  BrokerAdapter,
  BrokerRejection,
  OrderObservationAdapter,
  ExecutionMode,
  OperatorEdits,
} from "../../src/types/order.js";
import type { PortfolioEngine } from "../portfolio/engine.js";
import type { FillLog } from "./fill-log.js";
import type { TradeJournal } from "./trade-journal.js";
import type { Logger } from "../logger.js";
import { buildOrderRow, type AuditOrderWriter, type RiskViolation } from "./audit-orders.js";
import { buildFillRow, type AuditFillWriter } from "./audit-fills.js";
import type { OrderPlaneMetrics } from "./metrics.js";

// ── Types ──────────────────────────────────────────────────────────

export interface OrderPlaneDeps {
  portfolioEngine: PortfolioEngine;
  broker: BrokerAdapter;
  fillLog: FillLog;
  logger: Logger;
  generateId: () => string;
  mode: ExecutionMode;
  whitelist?: SemiAutoWhitelist;
  onOrderUpdate?: (order: Order) => void;
  onFill?: (fill: Fill) => void;
  tradeJournal?: TradeJournal;
  // QF-207 — persist every order state transition to audit_orders.
  // Optional so tests + legacy paths can skip; production wires it via
  // server/index.ts.
  auditOrderWriter?: AuditOrderWriter;
  // QF-208 — persist each broker fill to audit_fills (incl partial fills).
  // Optional; same gating as auditOrderWriter.
  auditFillWriter?: AuditFillWriter;
  // QF-217 — Prometheus counters + lifecycle histogram. Optional; tests
  // omit it. Production wires via createOrderPlaneMetrics().
  metrics?: OrderPlaneMetrics;
  // QF-234 — observation-only adapters (e.g. IBKR via NT, per
  // docs/tdd/broker-integration.md). Their onFill / onRejection
  // callbacks feed the same audit + portfolio + journal path as the
  // active broker's; the only difference is QF didn't initiate the
  // trade. Dispatch is keyed on Fill.broker_order_id, so observed
  // orders are reconciled against the same in-memory map.
  observers?: OrderObservationAdapter[];
}

interface SemiAutoWhitelist {
  symbols: string[];
  max_qty: number;
  strategy_ids: string[];
}

export interface OrderPlane {
  submit(intent: OrderIntent): Promise<Order>;
  // QF-50: `edits` (optional) lets manual-mode operators override the
  // Execution Layer's recommendation at approve-time. Fields that differ
  // from the original intent are captured on Order.operator_edits and
  // persisted to audit_orders.operator_edits. Approving without `edits`
  // (or with an `edits` that matches the recommendation field-for-field)
  // leaves Order.operator_edits null — the standard "approved as
  // recommended" path.
  approve(orderId: string, edits?: OperatorEdits): Promise<void>;
  reject(orderId: string): Promise<void>;
  // QF-204 + QF-217 — optional `reason` lets policy-driven cancels
  // (e.g. signal_invalidated from the working-order monitor) flow
  // through to audit_orders.cancel_reason (QF-204) AND is captured on
  // the orders_cancelled_total counter's `reason` label (QF-217).
  // Manual operator cancels typically omit it; the audit column stays
  // null and the counter labels with reason="manual".
  cancel(orderId: string, opts?: { reason?: string }): Promise<void>;
  // QF-210 — Execution Layer aborts before submit (quote-unavailable).
  // Constructs an Order with status='rejected' in-memory, persists an
  // audit_orders row capturing the failure reason via the appropriate
  // column. Does NOT touch the broker. Returns the synthetic Order so
  // the caller can correlate the rejection with the original intent.
  recordPreSubmitRejection(
    intent: OrderIntent,
    ctx: { kind: "quote_unavailable"; reason: string },
  ): Order;
  getOrder(orderId: string): Order | undefined;
  listOrders(portfolioId?: string): Order[];
  // QF-214 — populate the in-memory orders/intents maps from durable
  // audit storage at server boot. Idempotent: re-calling with the
  // same (order, intent) pair is a no-op overwrite. Does NOT call
  // emitUpdate or persist — restoring state without re-firing
  // lifecycle hooks is the whole point.
  rehydrateOrder(order: Order, intent: OrderIntent): void;
  // QF-230 — reconciliation-time injection of broker-side state that
  // QF missed while down. applyReconciledFill mirrors the broker
  // onFill path (audit + portfolio + journal + status transition);
  // applyReconciledRejection mirrors onRejection. Called by
  // reconcileOrdersWithBroker after rehydrateOrderPlane on startup
  // when broker.getOrderStatus reports filled/partial_fill/rejected
  // for an order QF thinks is still working. Distinct from
  // rehydrateOrder (which restores in-memory state without re-firing
  // side effects) — these DO re-fire because the audit/portfolio
  // pipeline never saw the event in the first place.
  applyReconciledFill(fill: Fill): void;
  applyReconciledRejection(rejection: BrokerRejection): void;
  killSwitch(reason: string): void;
  resetKillSwitch(): void;
  isHalted(): boolean;
}

// ── Implementation ─────────────────────────────────────────────────

export function createOrderPlane(deps: OrderPlaneDeps): OrderPlane {
  const orders = new Map<string, Order>();
  const intents = new Map<string, OrderIntent>(); // intent_id → intent
  const intentToOrder = new Map<string, string>(); // intent_id → order_id
  let systemHalted = false;
  let haltReason = "";

  function emitUpdate(order: Order): void {
    deps.onOrderUpdate?.(order);
  }

  // QF-217 — record an order's lifecycle duration on terminal transitions.
  // Called once per order (the first time it lands in a terminal state).
  // completed_at must already be set on `order`.
  const observedTerminal = new Set<string>();
  function observeLifecycle(order: Order, terminalState: string): void {
    if (!deps.metrics) return;
    if (observedTerminal.has(order.order_id)) return;
    if (!order.completed_at) return;
    const startMs = Date.parse(order.created_at);
    const endMs = Date.parse(order.completed_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const seconds = Math.max(0, (endMs - startMs) / 1000);
    deps.metrics.orderLifecycleDurationSeconds
      .labels({
        portfolio: order.portfolio,
        terminal_state: terminalState,
        broker: order.broker,
      })
      .observe(seconds);
    observedTerminal.add(order.order_id);
  }

  // QF-207 — fire-and-forget audit persistence at every state
  // transition. Errors are logged inside the writer; the emit path
  // never throws (best-effort, matches the existing trade-journal +
  // audit-pricing-decisions failure semantics).
  function persist(
    order: Order,
    ctx: {
      risk_violations?: RiskViolation[];
      halt_reason?: string;
      broker_rejection_reason?: string;
      quote_failure_reason?: string;
      cancel_reason?: string;
    } = {},
  ): void {
    if (!deps.auditOrderWriter) return;
    deps
      .auditOrderWriter(
        buildOrderRow({
          order,
          ...(ctx.risk_violations ? { risk_violations: ctx.risk_violations } : {}),
          ...(ctx.halt_reason ? { halt_reason: ctx.halt_reason } : {}),
          ...(ctx.broker_rejection_reason
            ? { broker_rejection_reason: ctx.broker_rejection_reason }
            : {}),
          ...(ctx.quote_failure_reason ? { quote_failure_reason: ctx.quote_failure_reason } : {}),
          ...(ctx.cancel_reason ? { cancel_reason: ctx.cancel_reason } : {}),
        }),
      )
      .catch(() => {
        // already logged inside the writer
      });
  }

  function shouldAutoApprove(intent: OrderIntent): boolean {
    const mode = deps.mode;

    if (mode === "paper_local" || mode === "paper_broker" || mode === "auto") {
      return true;
    }

    if (mode === "semi-auto" && deps.whitelist) {
      const wl = deps.whitelist;
      const symbolMatch = wl.symbols.some((pattern) => {
        if (pattern.endsWith("*")) {
          return intent.symbol.startsWith(pattern.slice(0, -1));
        }
        return intent.symbol === pattern;
      });
      const strategyMatch = wl.strategy_ids.includes(intent.strategy_id);
      const qtyMatch = intent.quantity <= wl.max_qty;
      return symbolMatch && strategyMatch && qtyMatch;
    }

    return false; // manual mode
  }

  async function submitToBroker(order: Order, intent: OrderIntent): Promise<void> {
    try {
      order.status = "submitted";
      order.submitted_at = new Date().toISOString();
      emitUpdate(order);
      persist(order);

      const brokerOrderId = await deps.broker.submitOrder({
        // QF-310: passed to the broker's native idempotency token field
        // by the Python NT bridge. A 504-window retry (broker accepted,
        // reply lost) carries the same client_order_id and is dedup'd
        // at the broker rather than creating a duplicate position.
        client_order_id: order.client_order_id,
        symbol: intent.symbol,
        direction: intent.direction,
        quantity: intent.quantity,
        orderType: "market",
      });
      order.broker_order_id = brokerOrderId;
      persist(order);
      deps.metrics?.ordersSubmittedTotal
        .labels({
          portfolio: order.portfolio,
          broker: order.broker,
          mode: order.execution_mode,
        })
        .inc();
    } catch (err) {
      order.status = "submission_failed";
      order.completed_at = new Date().toISOString();
      deps.logger.error("Order submission failed", {
        order_id: order.order_id,
        error: String(err),
      });
      emitUpdate(order);
      persist(order);
      observeLifecycle(order, "submission_failed");
    }
  }

  // QF-209 / QF-234 — async broker rejection handler. Extracted from
  // an inline closure so the active broker AND each observation-only
  // adapter (deps.observers) can subscribe the same logic. Look up
  // the matching order by broker_order_id and transition to
  // "rejected_by_broker" with the reason persisted to audit_orders.
  // Terminal-state guard: rejection arriving after a fill (race) is a
  // no-op; the order is already in a terminal state.
  function handleBrokerRejection(rejection: BrokerRejection): void {
    for (const [, order] of orders) {
      if (order.broker_order_id !== rejection.broker_order_id) continue;
      if (
        order.status === "filled" ||
        order.status === "cancelled" ||
        order.status === "rejected" ||
        order.status === "rejected_by_broker"
      ) {
        deps.logger.warn("Broker rejection ignored — order already in terminal state", {
          order_id: order.order_id,
          current_status: order.status,
          broker_reason: rejection.reason,
        });
        return;
      }
      order.status = "rejected_by_broker";
      order.completed_at = rejection.rejected_at;
      deps.logger.error("Order rejected by broker", {
        order_id: order.order_id,
        broker_order_id: rejection.broker_order_id,
        reason: rejection.reason,
        broker_reason_code: rejection.broker_reason_code,
      });
      emitUpdate(order);
      persist(order, { broker_rejection_reason: rejection.reason });
      deps.metrics?.ordersRejectedByBrokerTotal
        .labels({
          portfolio: order.portfolio,
          broker: order.broker,
          broker_reason_code: rejection.broker_reason_code ?? "unknown",
        })
        .inc();
      observeLifecycle(order, "rejected_by_broker");
      return;
    }
    // Unknown broker_order_id — log + drop. Indicates either a race
    // (rejection delivered before the submitOrder Promise resolved
    // and recorded the broker_order_id) or a broker-side bug. For
    // observation-only adapters this is also the "NT-internal order"
    // case (no QF audit_orders row) per docs/tdd/broker-integration.md.
    deps.logger.warn("Broker rejection for unknown broker_order_id", {
      broker_order_id: rejection.broker_order_id,
      reason: rejection.reason,
    });
  }

  deps.broker.onRejection?.(handleBrokerRejection);

  // QF-234 — fill handler. Same dispatch pattern as rejection: extracted
  // so observers subscribe the same logic without duplicating the audit
  // / portfolio / trade-journal pipeline.
  function handleBrokerFill(fill: Fill): void {
    // Find matching order
    for (const [, order] of orders) {
      if (order.broker_order_id === fill.broker_order_id) {
        // Enrich fill with portfolio + strategy context
        const intent = intents.get(order.intent_id);
        const enrichedFill: Fill = {
          ...fill,
          intent_id: order.intent_id,
          portfolio: order.portfolio,
        };

        // Write to fill log
        deps.fillLog.append(enrichedFill);

        // Apply to portfolio
        deps.portfolioEngine.applyFill(order.portfolio, enrichedFill);

        // Record in trade journal
        if (deps.tradeJournal && intent) {
          const isClosing = intent.action === "close";
          if (isClosing) {
            deps.tradeJournal.recordExit(enrichedFill, "signal").catch((e) => {
              deps.logger.error("Trade journal exit failed", { error: String(e) });
            });
          } else {
            deps.tradeJournal
              .recordEntry(enrichedFill, {
                trade_id: deps.generateId(),
                strategy_id: intent.strategy_id,
                signal_ids: intent.signal_ids,
              })
              .catch((e) => {
                deps.logger.error("Trade journal entry failed", { error: String(e) });
              });
          }
        }

        // QF-208 — cumulative fill arithmetic. Volume-weighted average
        // is the canonical pricing convention: avg = Σ(price * qty) / Σ(qty).
        const intentQty = intent?.quantity ?? fill.quantity;
        const prevQty = order.filled_quantity ?? 0;
        const prevAvg = order.average_fill_price ?? 0;
        const newQty = prevQty + fill.quantity;
        order.filled_quantity = newQty;
        order.average_fill_price =
          newQty > 0 ? (prevAvg * prevQty + fill.price * fill.quantity) / newQty : fill.price;

        // Status transition. Single-fill orders go straight to filled
        // when the broker reports the full intent quantity. Multi-fill
        // orders progress through "partial_fill" until the cumulative
        // matches the intent. Over-fill is logged as an error (a broker
        // contract violation) but the order still moves to filled to
        // avoid stranding it in a working state forever.
        if (newQty > intentQty) {
          deps.logger.error("Over-fill detected — cumulative exceeds intent quantity", {
            order_id: order.order_id,
            intent_quantity: intentQty,
            cumulative_filled: newQty,
          });
          order.status = "filled";
          order.completed_at = fill.filled_at;
        } else if (newQty === intentQty) {
          order.status = "filled";
          order.completed_at = fill.filled_at;
        } else {
          order.status = "partial_fill";
        }
        emitUpdate(order);
        persist(order);

        deps.metrics?.ordersFilledTotal
          .labels({
            portfolio: order.portfolio,
            broker: order.broker,
            partial: order.status === "partial_fill" ? "true" : "false",
          })
          .inc();
        if (order.status === "filled") observeLifecycle(order, "filled");

        // QF-208 — persist the fill row. expected_price is the intent's
        // limit_price when present (limit orders); for market orders
        // there's no clean expected and slippage stays null.
        if (deps.auditFillWriter) {
          const expectedPrice = intent?.limit_price ?? null;
          deps
            .auditFillWriter(buildFillRow({ fill: enrichedFill, expected_price: expectedPrice }))
            .catch(() => {
              // already logged inside the writer
            });
        }

        deps.onFill?.(enrichedFill);
        deps.logger.info("Fill received", {
          order_id: order.order_id,
          fill_id: fill.fill_id,
          symbol: fill.symbol,
          price: fill.price,
          quantity: fill.quantity,
          cumulative_quantity: newQty,
          status: order.status,
        });
        break;
      }
    }
  }

  deps.broker.onFill(handleBrokerFill);

  // QF-234 — observation-only adapters (e.g. IBKR via NT). They feed
  // the same handlers as the active broker; dispatch is keyed on
  // broker_order_id so fills/rejections for orders QF didn't initiate
  // are dropped at the "unknown broker_order_id" log line above.
  for (const observer of deps.observers ?? []) {
    observer.onFill(handleBrokerFill);
    observer.onRejection?.(handleBrokerRejection);
  }

  return {
    async submit(intent: OrderIntent): Promise<Order> {
      if (systemHalted) {
        const order: Order = {
          order_id: deps.generateId(),
          intent_id: intent.intent_id,
          // QF-310: derive broker idempotency token from the intent. Even
          // halt-rejected orders carry it so the audit row is uniformly
          // shaped; the broker is never called in this path.
          client_order_id: intent.client_order_id ?? intent.intent_id,
          portfolio: intent.portfolio,
          broker: deps.broker.name,
          execution_mode: deps.mode,
          status: "rejected",
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        };
        orders.set(order.order_id, order);
        deps.logger.warn("Order rejected: system halted", {
          order_id: order.order_id,
          reason: haltReason,
        });
        emitUpdate(order);
        persist(order, { halt_reason: haltReason });
        deps.metrics?.ordersRejectedTotal
          .labels({ portfolio: order.portfolio, reason: "halt" })
          .inc();
        observeLifecycle(order, "rejected");
        return order;
      }

      const order: Order = {
        order_id: deps.generateId(),
        intent_id: intent.intent_id,
        // QF-310: derive broker idempotency token from the intent at
        // construction time, BEFORE the audit row is persisted and
        // BEFORE any broker call. v1 default is intent_id; future
        // ExecAlgorithm child orders override.
        client_order_id: intent.client_order_id ?? intent.intent_id,
        portfolio: intent.portfolio,
        broker: deps.broker.name,
        execution_mode: deps.mode,
        status: "risk_check",
        created_at: new Date().toISOString(),
      };
      orders.set(order.order_id, order);
      intents.set(intent.intent_id, intent);
      intentToOrder.set(intent.intent_id, order.order_id);
      persist(order);

      // Risk check
      const riskResult = deps.portfolioEngine.canExecute(intent.portfolio, intent);
      order.risk_checked_at = new Date().toISOString();

      if (!riskResult.ok) {
        order.status = "rejected";
        order.completed_at = new Date().toISOString();
        deps.logger.info("Order rejected by risk check", {
          order_id: order.order_id,
          violations: riskResult.violations,
        });
        emitUpdate(order);
        persist(order, { risk_violations: riskResult.violations });
        deps.metrics?.ordersRejectedTotal
          .labels({ portfolio: order.portfolio, reason: "risk" })
          .inc();
        observeLifecycle(order, "rejected");
        return order;
      }

      // Approval gate
      if (shouldAutoApprove(intent)) {
        order.status = "approved";
        order.approved_at = new Date().toISOString();
        emitUpdate(order);
        persist(order);
        await submitToBroker(order, intent);
      } else {
        order.status = "pending_approval";
        deps.logger.info("Order pending approval", { order_id: order.order_id });
        emitUpdate(order);
        persist(order);
      }

      return order;
    },

    async approve(orderId: string, edits?: OperatorEdits): Promise<void> {
      const order = orders.get(orderId);
      if (!order || order.status !== "pending_approval") return;

      order.status = "approved";
      order.approved_at = new Date().toISOString();

      // QF-50 — look up the original intent so we can diff `edits`
      // against the Execution Layer's recommendation. The intents
      // map has held entries since submit() was called.
      let intent = intents.get(order.intent_id);
      if (!intent) {
        // Defensive fallback (only triggers for orders that came in
        // before intent storage was added; legacy path preserved).
        intent = {
          intent_id: order.intent_id,
          portfolio: order.portfolio,
          strategy_id: "",
          action: "open",
          symbol: "",
          direction: "Long",
          quantity: 0,
          reason: "",
          signal_ids: [],
          created_at: order.created_at,
        };
      }

      const diff = diffEdits(intent, edits);
      order.operator_edits = diff;
      if (diff) {
        // Apply the diff to the intent's submission params so the
        // broker sees the operator's edited order, not the original.
        intent = {
          ...intent,
          ...(diff.order_type !== undefined ? { order_type: diff.order_type } : {}),
          ...(diff.limit_price !== undefined ? { limit_price: diff.limit_price } : {}),
          ...(diff.time_in_force !== undefined ? { time_in_force: diff.time_in_force } : {}),
          ...(diff.working_policy_id !== undefined
            ? { working_policy_id: diff.working_policy_id }
            : {}),
        };
        intents.set(intent.intent_id, intent);
        deps.logger.info("Order approved with operator edits", {
          order_id: orderId,
          edits: diff,
        });
      }

      emitUpdate(order);
      persist(order);
      await submitToBroker(order, intent);
    },

    async reject(orderId: string): Promise<void> {
      const order = orders.get(orderId);
      if (!order || order.status !== "pending_approval") return;

      order.status = "rejected";
      order.completed_at = new Date().toISOString();
      deps.logger.info("Order manually rejected", { order_id: orderId });
      emitUpdate(order);
      persist(order);
      deps.metrics?.ordersRejectedTotal
        .labels({ portfolio: order.portfolio, reason: "manual" })
        .inc();
      observeLifecycle(order, "rejected");
    },

    // QF-210 — Execution Layer aborts before submit (quote-unavailable).
    // Build a synthetic rejected Order, register it so it shows up in
    // listOrders, persist an audit_orders row with quote_failure_reason
    // populated. No broker call; no risk gate (the precondition was a
    // missing input that the risk gate can't evaluate anyway).
    recordPreSubmitRejection(intent: OrderIntent, ctx): Order {
      const now = new Date().toISOString();
      const order: Order = {
        order_id: deps.generateId(),
        intent_id: intent.intent_id,
        // QF-310: uniform shape — derive even for synthetic pre-submit
        // rejections so audit_orders rows always have a non-null
        // client_order_id.
        client_order_id: intent.client_order_id ?? intent.intent_id,
        portfolio: intent.portfolio,
        broker: deps.broker.name,
        execution_mode: deps.mode,
        status: "rejected",
        created_at: now,
        completed_at: now,
      };
      orders.set(order.order_id, order);
      intents.set(intent.intent_id, intent);
      intentToOrder.set(intent.intent_id, order.order_id);
      deps.logger.error("Order rejected pre-submit", {
        order_id: order.order_id,
        kind: ctx.kind,
        reason: ctx.reason,
      });
      emitUpdate(order);
      persist(order, { quote_failure_reason: ctx.reason });
      deps.metrics?.ordersRejectedTotal
        .labels({ portfolio: order.portfolio, reason: "quote_unavailable" })
        .inc();
      observeLifecycle(order, "rejected");
      return order;
    },

    async cancel(orderId: string, opts: { reason?: string } = {}): Promise<void> {
      const order = orders.get(orderId);
      if (!order) return;
      if (
        order.status === "filled" ||
        order.status === "cancelled" ||
        order.status === "rejected" ||
        order.status === "rejected_by_broker"
      )
        return;

      if (order.broker_order_id) {
        await deps.broker.cancelOrder(order.broker_order_id);
      }

      order.status = "cancelled";
      order.completed_at = new Date().toISOString();
      deps.logger.info("Order cancelled", { order_id: orderId, reason: opts.reason });
      emitUpdate(order);
      persist(order, opts.reason ? { cancel_reason: opts.reason } : {});
      deps.metrics?.ordersCancelledTotal
        .labels({ portfolio: order.portfolio, reason: opts.reason ?? "manual" })
        .inc();
      observeLifecycle(order, "cancelled");
    },

    getOrder(orderId: string): Order | undefined {
      return orders.get(orderId);
    },

    listOrders(portfolioId?: string): Order[] {
      const all = Array.from(orders.values());
      if (portfolioId) return all.filter((o) => o.portfolio === portfolioId);
      return all;
    },

    rehydrateOrder(order: Order, intent: OrderIntent): void {
      // Idempotent insertion. Doesn't call emitUpdate or persist —
      // rehydration restores state without re-firing the lifecycle
      // pipeline (which would double-write audit rows + re-emit WS
      // events for orders that already happened).
      orders.set(order.order_id, order);
      intents.set(intent.intent_id, intent);
      intentToOrder.set(intent.intent_id, order.order_id);
    },

    // QF-230 — reconciliation injectors. Run the missing fill/rejection
    // through the same dispatch closure broker callbacks use, so audit +
    // portfolio + journal + metrics all land naturally. The caller
    // (reconcileOrdersWithBroker) only invokes these when QF's in-memory
    // state disagrees with broker.getOrderStatus, so re-firing the
    // pipeline is exactly the right move — those side effects never
    // happened while QF was down.
    applyReconciledFill(fill: Fill): void {
      handleBrokerFill(fill);
    },

    applyReconciledRejection(rejection: BrokerRejection): void {
      handleBrokerRejection(rejection);
    },

    killSwitch(reason: string): void {
      systemHalted = true;
      haltReason = reason;
      deps.logger.error("KILL SWITCH ACTIVATED", { reason });

      // Cancel all pending/submitted orders
      for (const [, order] of orders) {
        if (order.status === "pending_approval" || order.status === "submitted") {
          order.status = "cancelled";
          order.completed_at = new Date().toISOString();
          if (order.broker_order_id) {
            deps.broker.cancelOrder(order.broker_order_id).catch(() => {});
          }
          emitUpdate(order);
          persist(order, { halt_reason: reason });
          deps.metrics?.ordersCancelledTotal
            .labels({ portfolio: order.portfolio, reason: "kill_switch" })
            .inc();
          observeLifecycle(order, "cancelled");
        }
      }
    },

    resetKillSwitch(): void {
      systemHalted = false;
      haltReason = "";
      deps.logger.info("Kill switch reset");
    },

    isHalted(): boolean {
      return systemHalted;
    },
  };
}

// ── QF-50: operator-edit diff ────────────────────────────────────────
//
// Compares the operator-supplied `edits` against the original intent's
// Execution Layer recommendation. Returns ONLY the keys where the
// operator's value differs (or null if the operator approved as
// recommended). Numeric fields use strict equality; string fields too.
// The returned object is what audit_orders.operator_edits stores —
// a small JSON blob, never including unchanged fields.
function diffEdits(intent: OrderIntent, edits?: OperatorEdits): OperatorEdits | null {
  if (!edits) return null;
  const out: OperatorEdits = {};
  if (edits.order_type !== undefined && edits.order_type !== intent.order_type) {
    out.order_type = edits.order_type;
  }
  if (edits.limit_price !== undefined && edits.limit_price !== intent.limit_price) {
    out.limit_price = edits.limit_price;
  }
  if (edits.time_in_force !== undefined && edits.time_in_force !== intent.time_in_force) {
    out.time_in_force = edits.time_in_force;
  }
  if (
    edits.working_policy_id !== undefined &&
    edits.working_policy_id !== intent.working_policy_id
  ) {
    out.working_policy_id = edits.working_policy_id;
  }
  return Object.keys(out).length > 0 ? out : null;
}
