// ── Order & Execution Plane ────────────────────────────────────────
// Order lifecycle state machine: intent → risk check → approval → submit → fill
// Defined in: docs/tdd/order-execution.md
//
// QF-263 (M14-1 Architecture B, QF-259): the Order Plane is narrowed to
// operator manual entry + kill-switch only. NT strategies own the
// auto/semi-auto decision-to-broker path; the QF plane no longer runs
// any auto-approval logic. The two remaining modes are:
//   - "manual"     — every order parks in pending_approval until an
//                    operator approves or rejects it.
//   - "paper_local" — orders are auto-approved (no human in the loop)
//                    and submitted to the active broker. QF-337 retired
//                    the in-process paper fill simulator, so whether a
//                    fill comes back depends on the wired broker: a real
//                    nt-bridge (paper- or live-credentialed bundle)
//                    fills, the disconnected fallback does not.
// The retired modes (auto / semi-auto / paper_broker) and the
// shouldAutoApprove whitelist gate are removed.

import type {
  OrderIntent,
  Order,
  Fill,
  BrokerAdapter,
  BrokerRejection,
  OrderObservationAdapter,
  OrderSubmissionAdapter,
  ExecutionMode,
  OperatorEdits,
} from "../../src/types/order.js";
import type { PortfolioEngine } from "../portfolio/engine.js";
import type { FillLog } from "./fill-log.js";
import type { TradeJournal } from "./trade-journal.js";
import type { Logger } from "../logger.js";
import type { AlertRouter } from "../alerts/router.js";
import { buildOrderRow, type AuditOrderWriter, type RiskViolation } from "./audit-orders.js";
import { buildFillRow, type AuditFillWriter } from "./audit-fills.js";
import type { OrderPlaneMetrics } from "./metrics.js";

// ── Types ──────────────────────────────────────────────────────────

export interface OrderPlaneDeps {
  portfolioEngine: PortfolioEngine;
  // QF-245 — single active broker. LEGACY/backward-compat path: when
  // `brokers` is absent every submit routes here regardless of the
  // intent's account. Still required as the observation anchor (its
  // onFill / onRejection feed the same dispatch as the per-account
  // adapters) even in the multi-broker shape, so production keeps
  // passing the first-enabled adapter here while also populating
  // `brokers`. Optional only so multi-broker tests that supply
  // `brokers` + their own observers don't have to construct a redundant
  // single broker — but at least one of `broker` / `brokers` must be set.
  broker?: BrokerAdapter;
  // QF-245 — per-account submission adapters keyed by account_id (the
  // SchwabAccountConfig.id from config/brokers.json). When present,
  // submit() resolves OrderIntent → portfolio → account → adapter and
  // routes the broker call there. A miss transitions the order to
  // submission_failed with "no broker configured for account <id>".
  // Observation (onFill / onRejection) for these adapters is wired by
  // the caller into the shared handlers via `broker` / `observers`; the
  // dispatch is keyed on broker_order_id so it doesn't matter which
  // adapter delivered the event.
  brokers?: Map<string, OrderSubmissionAdapter>;
  // QF-245 — portfolio → account_id fallback. Consulted only when an
  // OrderIntent carries no `account_id` (legacy intents). The strategy
  // runner normally stamps account_id at intent-creation time; this
  // keeps older intents routable. Returns undefined when the portfolio
  // has no explicit routing, in which case account resolution falls
  // through to the default account id.
  resolvePortfolioAccount?: (portfolioId: string) => string | undefined;
  // QF-245 — account id used for audit attribution + adapter lookup when
  // neither the intent nor the portfolio map resolves one. Mirrors
  // resolveAccountForPortfolio's "first enabled account" fallback so the
  // single-account (synthetic "default") config routes identically to
  // the pre-multi-account behaviour. Defaults to "default".
  defaultAccountId?: string;
  fillLog: FillLog;
  logger: Logger;
  generateId: () => string;
  mode: ExecutionMode;
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
  // QF-336 — optional alert router for broker reject, kill-switch alerts.
  alertRouter?: AlertRouter;
}

export interface OrderPlane {
  submit(intent: OrderIntent): Promise<Order>;
  // QF-50: `edits` (optional) lets manual-mode operators override the
  // submitted intent's params at approve-time. Fields that differ from
  // the original intent are captured on Order.operator_edits and
  // persisted to audit_orders.operator_edits. Approving without `edits`
  // (or with an `edits` that matches the intent field-for-field) leaves
  // Order.operator_edits null — the standard "approved as submitted"
  // path.
  approve(orderId: string, edits?: OperatorEdits): Promise<void>;
  reject(orderId: string): Promise<void>;
  // QF-204 + QF-217 — optional `reason` lets policy-driven cancels
  // (e.g. signal_invalidated from the working-order monitor) flow
  // through to audit_orders.cancel_reason (QF-204) AND is captured on
  // the orders_cancelled_total counter's `reason` label (QF-217).
  // Manual operator cancels typically omit it; the audit column stays
  // null and the counter labels with reason="manual".
  cancel(orderId: string, opts?: { reason?: string }): Promise<void>;
  // QF-210 — caller aborts before submit (quote-unavailable).
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
  // QF-245 — per-order account attribution. Resolved once at submit()
  // time and reused by the fill/rejection handlers so the audit_orders /
  // audit_fills rows carry the account the order actually routed to,
  // rather than re-resolving (the portfolio routing could change under
  // us between submit and fill).
  const orderAccount = new Map<string, string>(); // order_id → account_id
  let systemHalted = false;
  let haltReason = "";

  if (deps.broker === undefined && (deps.brokers === undefined || deps.brokers.size === 0)) {
    throw new Error("OrderPlane requires either `broker` (legacy) or a non-empty `brokers` map");
  }

  const defaultAccountId = deps.defaultAccountId ?? "default";

  // QF-245 — name reported on Order.broker + metrics labels. In the
  // multi-broker shape every adapter is the same logical broker
  // ("schwab") fronting different accounts, so the legacy broker's name
  // is the canonical label; fall back to the first per-account adapter.
  function brokerName(): string {
    if (deps.broker) return deps.broker.name;
    const first = deps.brokers?.values().next().value;
    return first?.name ?? "unknown";
  }

  // QF-245 — resolve OrderIntent → account_id. Intent-stamped account
  // wins (the strategy runner resolves it from portfolio config at
  // intent-creation time); legacy intents fall back to the portfolio
  // routing map, then to the configured default account.
  function resolveAccountId(intent: OrderIntent): string {
    return (
      intent.account_id ?? deps.resolvePortfolioAccount?.(intent.portfolio) ?? defaultAccountId
    );
  }

  // QF-245 — pick the submission adapter for a resolved account. Legacy
  // single-broker path (no `brokers` map): always the lone broker.
  // Multi-broker path: look up by account_id, returning undefined on a
  // miss so submit() can fail-fast with a clear rejection reason.
  function resolveBroker(accountId: string): OrderSubmissionAdapter | undefined {
    if (deps.brokers && deps.brokers.size > 0) {
      return deps.brokers.get(accountId);
    }
    return deps.broker;
  }

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
  // never throws (best-effort, matches the existing trade-journal
  // failure semantics).
  function persist(
    order: Order,
    ctx: {
      risk_violations?: RiskViolation[];
      halt_reason?: string;
      broker_rejection_reason?: string;
      quote_failure_reason?: string;
      cancel_reason?: string;
      // QF-245 — explicit override; otherwise the order's resolved
      // account (from orderAccount) is attributed, falling back to the
      // default account id for rows persisted before resolution.
      account_id?: string;
    } = {},
  ): void {
    if (!deps.auditOrderWriter) return;
    const accountId = ctx.account_id ?? orderAccount.get(order.order_id) ?? defaultAccountId;
    deps
      .auditOrderWriter(
        buildOrderRow({
          order,
          account_id: accountId,
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

  // QF-263 — the only auto-approval path left is paper_local. Every
  // other mode ("manual") parks the order in pending_approval for an
  // operator. QF-337 retired the in-process paper simulator, so an
  // auto-approved order is submitted to whatever broker is wired (the
  // disconnected fallback when none). The retired auto / semi-auto /
  // paper_broker modes and their whitelist gate are gone; NT strategies
  // own auto execution per M14-1 Architecture B.
  function autoApprovesLocally(): boolean {
    return deps.mode === "paper_local";
  }

  async function submitToBroker(order: Order, intent: OrderIntent): Promise<void> {
    // QF-245 — resolve the per-account adapter. The account_id was
    // stamped on orderAccount at submit() time. A miss in the
    // multi-broker shape (account exists in routing but no adapter was
    // wired, e.g. the account is disabled) fails the order fast with a
    // clear rejection reason and an audit_orders row — never a silent
    // drop or a route to the wrong account.
    const accountId = orderAccount.get(order.order_id) ?? defaultAccountId;
    const broker = resolveBroker(accountId);
    if (!broker) {
      order.status = "submission_failed";
      order.completed_at = new Date().toISOString();
      const reason = `no broker configured for account ${accountId}`;
      deps.logger.error("Order submission failed: no broker for account", {
        order_id: order.order_id,
        account_id: accountId,
      });
      emitUpdate(order);
      persist(order, { broker_rejection_reason: reason, account_id: accountId });
      observeLifecycle(order, "submission_failed");
      return;
    }

    try {
      order.status = "submitted";
      order.submitted_at = new Date().toISOString();
      emitUpdate(order);
      persist(order);

      const brokerOrderId = await broker.submitOrder({
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
      if (deps.alertRouter) {
        void deps.alertRouter
          .record({
            type: `broker.reject.${order.broker}`,
            level: "warning",
            message: `Order ${order.order_id} rejected by ${order.broker}: ${rejection.reason}`,
            payload: {
              order_id: order.order_id,
              broker_order_id: rejection.broker_order_id,
              reason: rejection.reason,
              broker_reason_code: rejection.broker_reason_code,
            },
          })
          .catch((err) => {
            deps.logger.warn("broker reject alert failed", { error: String(err), order_id: order.order_id });
          });
      }
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

  // QF-245 — observation wiring. The legacy single broker (when present)
  // is the canonical observation anchor; in the multi-broker shape the
  // caller passes the per-account adapters through `observers` so their
  // fills/rejections reach the same handlers. Dispatch is keyed on
  // broker_order_id, so it doesn't matter which adapter delivered the
  // event.
  deps.broker?.onRejection?.(handleBrokerRejection);

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
          // QF-245 — attribute the fill to the account the order routed
          // to. The observation adapters all feed this one handler, so we
          // recover the account from orderAccount (keyed at submit time)
          // rather than from the delivering adapter.
          const accountId = orderAccount.get(order.order_id) ?? defaultAccountId;
          deps
            .auditFillWriter(
              buildFillRow({
                fill: enrichedFill,
                expected_price: expectedPrice,
                account_id: accountId,
              }),
            )
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

  deps.broker?.onFill(handleBrokerFill);

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
          broker: brokerName(),
          execution_mode: deps.mode,
          status: "rejected",
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        };
        orders.set(order.order_id, order);
        orderAccount.set(order.order_id, resolveAccountId(intent));
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
        broker: brokerName(),
        execution_mode: deps.mode,
        status: "risk_check",
        created_at: new Date().toISOString(),
      };
      orders.set(order.order_id, order);
      intents.set(intent.intent_id, intent);
      intentToOrder.set(intent.intent_id, order.order_id);
      // QF-245 — resolve + remember the account before the first audit
      // write so every row for this order is attributed consistently.
      orderAccount.set(order.order_id, resolveAccountId(intent));
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
      if (autoApprovesLocally()) {
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
      // against the submitted intent's params. The intents map has
      // held entries since submit() was called.
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

    // QF-210 — caller aborts before submit (quote-unavailable).
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
        broker: brokerName(),
        execution_mode: deps.mode,
        status: "rejected",
        created_at: now,
        completed_at: now,
      };
      orders.set(order.order_id, order);
      intents.set(intent.intent_id, intent);
      intentToOrder.set(intent.intent_id, order.order_id);
      orderAccount.set(order.order_id, resolveAccountId(intent));
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
        // QF-245 — cancel against the same account the order routed to.
        const broker = resolveBroker(orderAccount.get(order.order_id) ?? defaultAccountId);
        await broker?.cancelOrder(order.broker_order_id);
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
      // QF-245 — restore the routing account so a post-restart cancel of
      // a rehydrated working order reaches the right per-account adapter.
      // QF-247 — the audit_orders row's account_id (stamped on the Order at
      // submission time) is authoritative; it survives even when the intent
      // can't re-derive the same account (audit_intents doesn't persist
      // account_id, so resolveAccountId(intent) would fall back to the
      // portfolio map / default). Prefer it; fall back to intent resolution
      // for pre-M12 rows where the Order carries no account_id.
      orderAccount.set(order.order_id, order.account_id ?? resolveAccountId(intent));
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
      if (deps.alertRouter) {
        void deps.alertRouter
          .record({
            type: "kill_switch.activated",
            level: "critical",
            message: `Kill switch activated: ${reason}`,
            payload: {
              reason,
            },
          })
          .catch((err) => {
            deps.logger.warn("kill switch alert failed", { error: String(err) });
          });
      }

      // Cancel all pending/submitted orders
      for (const [, order] of orders) {
        if (order.status === "pending_approval" || order.status === "submitted") {
          order.status = "cancelled";
          order.completed_at = new Date().toISOString();
          if (order.broker_order_id) {
            // QF-245 — route the kill-switch cancel to the order's account.
            const broker = resolveBroker(orderAccount.get(order.order_id) ?? defaultAccountId);
            broker?.cancelOrder(order.broker_order_id).catch(() => {});
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
// submitted params. Returns ONLY the keys where the operator's value
// differs (or null if the operator approved as submitted). Numeric
// fields use strict equality; string fields too.
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
