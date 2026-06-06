import { describe, it, expect, beforeEach } from "vitest";
import { createOrderPlane, type OrderPlane } from "../../plane.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type {
  BrokerAdapter,
  BrokerRejection,
  Fill,
  OrderIntent,
  SubmitOrderParams,
} from "../../../../src/types/order.js";
import type { PortfolioEngine } from "../../../portfolio/engine.js";
import type { FillLog } from "../../fill-log.js";

// ── Mock factories ───────────────────────────────────────────────

let fillCallback: ((fill: Fill) => void) | null = null;
let rejectionCallback: ((rejection: BrokerRejection) => void) | null = null;
let submitCount = 0;
let cancelledIds: string[] = [];
// QF-310: capture submission params for client_order_id assertions.
let submittedParams: SubmitOrderParams[] = [];

function mockBroker(): BrokerAdapter {
  fillCallback = null;
  rejectionCallback = null;
  submitCount = 0;
  cancelledIds = [];
  submittedParams = [];
  return {
    name: "mock",
    async available() {
      return true;
    },
    async submitOrder(params) {
      submittedParams.push(params);
      submitCount++;
      return `broker-order-${submitCount}`;
    },
    async cancelOrder(id) {
      cancelledIds.push(id);
    },
    async getOrderStatus(brokerOrderId) {
      return {
        broker_order_id: brokerOrderId,
        status: "unknown" as const,
        filled_quantity: 0,
        average_fill_price: null,
        rejection_reason: null,
      };
    },
    async getPositions() {
      return [];
    },
    onFill(cb) {
      fillCallback = cb;
    },
    onRejection(cb) {
      rejectionCallback = cb;
    },
  };
}

let fillsApplied: Array<{ portfolio: string; fill: Fill }> = [];

function mockPortfolioEngine(canExecuteOk = true): PortfolioEngine {
  fillsApplied = [];
  return {
    getState: () => ({
      positions: [],
      cash: 100000,
      equity: 100000,
      daily_realized_pnl: 0,
      halted: false,
      halt_reason: null,
    }),
    canExecute: () =>
      canExecuteOk
        ? { ok: true, violations: [] }
        : { ok: false, violations: [{ limit: "max_order_size", current: 20, max: 10 }] },
    applyFill: (portfolio: string, fill: Fill) => {
      fillsApplied.push({ portfolio, fill });
    },
  } as unknown as PortfolioEngine;
}

let appendedFills: Fill[] = [];

function mockFillLog(): FillLog {
  appendedFills = [];
  return {
    append: (fill: Fill) => {
      appendedFills.push(fill);
    },
    replay: () => [],
  } as unknown as FillLog;
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intent_id: `intent-${Date.now()}`,
    portfolio: "main",
    strategy_id: "test-strategy",
    action: "open",
    symbol: "OPT:SPY:2026-06-19:C:500",
    direction: "Short",
    quantity: 1,
    reason: "test",
    signal_ids: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let idCounter = 0;

// ── Tests ────────────────────────────────────────────────────────

describe("order plane", () => {
  let plane: OrderPlane;

  beforeEach(() => {
    idCounter = 0;
  });

  function makePlane(
    opts: {
      mode?: string;
      canExecute?: boolean;
      whitelist?: unknown;
      auditWrites?: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }>;
    } = {},
  ): OrderPlane {
    return createOrderPlane({
      portfolioEngine: mockPortfolioEngine(opts.canExecute ?? true),
      broker: mockBroker(),
      fillLog: mockFillLog(),
      logger: createTestLogger(),
      generateId: () => `order-${++idCounter}`,
      mode: (opts.mode ?? "paper_local") as never,
      whitelist: opts.whitelist as never,
      ...(opts.auditWrites
        ? {
            auditOrderWriter: async (row) => {
              opts.auditWrites!.push({
                status: row.status,
                risk_violations: row.risk_violations,
                halt_reason: row.halt_reason,
              });
            },
          }
        : {}),
    });
  }

  describe("submit", () => {
    it("auto-approves and submits in paper_local mode", async () => {
      plane = makePlane({ mode: "paper_local" });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("submitted");
      expect(order.broker_order_id).toBe("broker-order-1");
    });

    it("auto-approves in paper_broker mode", async () => {
      plane = makePlane({ mode: "paper_broker" });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("submitted");
    });

    it("rejects when risk check fails", async () => {
      plane = makePlane({ canExecute: false });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("rejected");
      expect(submitCount).toBe(0);
    });

    it("rejects when system is halted", async () => {
      plane = makePlane();
      plane.killSwitch("test halt");
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("rejected");
    });

    // QF-310 — broker-side idempotency token. Order.client_order_id
    // must default to intent_id, must be in the audit row at INSERT,
    // and must be passed through to the broker on the submit call.
    it("derives client_order_id from intent_id when intent doesn't supply one", async () => {
      plane = makePlane({ mode: "paper_local" });
      const intent = makeIntent({ intent_id: "I_PLAIN" });
      const order = await plane.submit(intent);
      expect(order.client_order_id).toBe("I_PLAIN");
      expect(submittedParams).toHaveLength(1);
      expect(submittedParams[0]?.client_order_id).toBe("I_PLAIN");
    });

    it("uses intent.client_order_id when supplied (future ExecAlgorithm child orders)", async () => {
      plane = makePlane({ mode: "paper_local" });
      const intent = makeIntent({
        intent_id: "I_PARENT",
        client_order_id: "CHILD_TOKEN",
      });
      const order = await plane.submit(intent);
      expect(order.client_order_id).toBe("CHILD_TOKEN");
      expect(submittedParams[0]?.client_order_id).toBe("CHILD_TOKEN");
    });

    it("sets pending_approval in manual mode", async () => {
      plane = makePlane({ mode: "manual" });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("pending_approval");
      expect(submitCount).toBe(0);
    });
  });

  describe("semi-auto whitelist", () => {
    it("auto-approves matching whitelist", async () => {
      plane = makePlane({
        mode: "semi-auto",
        whitelist: { symbols: ["OPT:SPY:*"], max_qty: 5, strategy_ids: ["test-strategy"] },
      });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("submitted");
    });

    it("requires approval when symbol doesn't match", async () => {
      plane = makePlane({
        mode: "semi-auto",
        whitelist: { symbols: ["OPT:QQQ:*"], max_qty: 5, strategy_ids: ["test-strategy"] },
      });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("pending_approval");
    });

    it("requires approval when qty exceeds whitelist", async () => {
      plane = makePlane({
        mode: "semi-auto",
        whitelist: { symbols: ["OPT:SPY:*"], max_qty: 0, strategy_ids: ["test-strategy"] },
      });
      const order = await plane.submit(makeIntent({ quantity: 1 }));
      expect(order.status).toBe("pending_approval");
    });
  });

  describe("approve / reject", () => {
    it("approve submits a pending order to broker", async () => {
      plane = makePlane({ mode: "manual" });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("pending_approval");

      await plane.approve(order.order_id);
      const updated = plane.getOrder(order.order_id)!;
      expect(updated.status).toBe("submitted");
      expect(updated.approved_at).toBeDefined();
    });

    it("reject sets status to rejected", async () => {
      plane = makePlane({ mode: "manual" });
      const order = await plane.submit(makeIntent());
      await plane.reject(order.order_id);
      expect(plane.getOrder(order.order_id)!.status).toBe("rejected");
    });

    it("approve on non-pending is a no-op", async () => {
      plane = makePlane();
      const order = await plane.submit(makeIntent());
      // Already submitted (paper_local auto-approves)
      await plane.approve(order.order_id);
      // No error, no double submit
      expect(submitCount).toBe(1);
    });

    // ── QF-50: approve with operator edits ─────────────────────────

    it("approve without edits leaves operator_edits null", async () => {
      plane = makePlane({ mode: "manual" });
      const intent = makeIntent({
        order_type: "limit",
        limit_price: 12.5,
        time_in_force: "day",
        working_policy_id: "patient",
      });
      const order = await plane.submit(intent);
      await plane.approve(order.order_id);
      expect(plane.getOrder(order.order_id)!.operator_edits).toBeNull();
    });

    it("approve with body matching the recommendation field-for-field → operator_edits null", async () => {
      // Approving with the same values the Execution Layer recommended
      // should not register as an operator edit (the operator just
      // confirmed the recommendation).
      plane = makePlane({ mode: "manual" });
      const intent = makeIntent({
        order_type: "limit",
        limit_price: 12.5,
        time_in_force: "day",
        working_policy_id: "patient",
      });
      const order = await plane.submit(intent);
      await plane.approve(order.order_id, {
        order_type: "limit",
        limit_price: 12.5,
        time_in_force: "day",
        working_policy_id: "patient",
      });
      expect(plane.getOrder(order.order_id)!.operator_edits).toBeNull();
    });

    it("approve with a limit-price edit captures the diff on Order.operator_edits", async () => {
      plane = makePlane({ mode: "manual" });
      const intent = makeIntent({
        order_type: "limit",
        limit_price: 12.5,
        time_in_force: "day",
      });
      const order = await plane.submit(intent);
      await plane.approve(order.order_id, { limit_price: 12.55 });
      const updated = plane.getOrder(order.order_id)!;
      expect(updated.operator_edits).toEqual({ limit_price: 12.55 });
      // Unchanged fields are NOT in the diff.
      expect(updated.operator_edits).not.toHaveProperty("order_type");
    });

    it("approve with multi-field edits captures only the keys that differ", async () => {
      plane = makePlane({ mode: "manual" });
      const intent = makeIntent({
        order_type: "limit",
        limit_price: 12.5,
        time_in_force: "day",
        working_policy_id: "patient",
      });
      const order = await plane.submit(intent);
      await plane.approve(order.order_id, {
        limit_price: 12.55, // changed
        time_in_force: "day", // same — not captured
        working_policy_id: "aggressive", // changed
      });
      expect(plane.getOrder(order.order_id)!.operator_edits).toEqual({
        limit_price: 12.55,
        working_policy_id: "aggressive",
      });
    });
  });

  describe("cancel", () => {
    it("cancels a submitted order", async () => {
      plane = makePlane();
      const order = await plane.submit(makeIntent());
      await plane.cancel(order.order_id);
      expect(plane.getOrder(order.order_id)!.status).toBe("cancelled");
      expect(cancelledIds).toContain("broker-order-1");
    });

    it("no-op on filled order", async () => {
      plane = makePlane();
      const order = await plane.submit(makeIntent());
      // Simulate fill
      if (fillCallback) {
        fillCallback({
          fill_id: "fill-1",
          order_id: order.order_id,
          broker_order_id: "broker-order-1",
          symbol: "OPT:SPY:2026-06-19:C:500",
          direction: "Short",
          quantity: 1,
          price: 12.5,
          fees: 0,
          filled_at: new Date().toISOString(),
          intent_id: "",
          portfolio: "",
          broker: "paper",
        });
      }
      await plane.cancel(order.order_id);
      expect(plane.getOrder(order.order_id)!.status).toBe("filled");
    });
  });

  describe("fill callback", () => {
    it("enriches fill and applies to portfolio", async () => {
      plane = makePlane();
      const order = await plane.submit(makeIntent());

      fillCallback!({
        fill_id: "fill-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });

      expect(plane.getOrder(order.order_id)!.status).toBe("filled");
      expect(appendedFills).toHaveLength(1);
      expect(appendedFills[0]!.portfolio).toBe("main");
      expect(fillsApplied).toHaveLength(1);
    });
  });

  describe("kill switch", () => {
    it("cancels pending and submitted orders", async () => {
      plane = makePlane();
      const o1 = await plane.submit(makeIntent());
      plane.killSwitch("test");
      expect(plane.getOrder(o1.order_id)!.status).toBe("cancelled");
      expect(plane.isHalted()).toBe(true);
    });

    it("resetKillSwitch resumes", async () => {
      plane = makePlane();
      plane.killSwitch("test");
      plane.resetKillSwitch();
      expect(plane.isHalted()).toBe(false);
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("submitted");
    });
  });

  describe("listOrders", () => {
    it("returns all orders", async () => {
      plane = makePlane();
      await plane.submit(makeIntent());
      await plane.submit(makeIntent());
      expect(plane.listOrders()).toHaveLength(2);
    });

    it("filters by portfolio", async () => {
      plane = makePlane();
      await plane.submit(makeIntent({ portfolio: "main" }));
      await plane.submit(makeIntent({ portfolio: "other" }));
      expect(plane.listOrders("main")).toHaveLength(1);
    });
  });

  // ── QF-207: audit_orders persistence ───────────────────────────────

  describe("auditOrderWriter integration", () => {
    it("persists every transition through the paper-local happy path (risk_check → submitted → filled)", async () => {
      const auditWrites: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }> = [];
      plane = makePlane({ mode: "paper_local", auditWrites });
      const order = await plane.submit(makeIntent());

      // Simulate a fill so we observe the filled transition.
      fillCallback!({
        fill_id: "fill-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });

      const statuses = auditWrites.map((w) => w.status);
      // Expected sequence: risk_check → approved → submitted (post-status-set)
      // → submitted (post-broker_order_id) → filled.
      expect(statuses).toEqual(["risk_check", "approved", "submitted", "submitted", "filled"]);
      expect(auditWrites.every((w) => w.risk_violations === null)).toBe(true);
      expect(auditWrites.every((w) => w.halt_reason === null)).toBe(true);
    });

    it("persists the risk_violations JSON when a risk-check rejects", async () => {
      const auditWrites: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }> = [];
      plane = makePlane({ canExecute: false, auditWrites });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("rejected");

      const last = auditWrites[auditWrites.length - 1]!;
      expect(last.status).toBe("rejected");
      expect(last.risk_violations).toBeTruthy();
      const violations = JSON.parse(last.risk_violations!);
      expect(violations[0].limit).toBe("max_order_size");
      expect(last.halt_reason).toBeNull();
    });

    it("persists the halt_reason when kill switch blocks a submit", async () => {
      const auditWrites: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }> = [];
      plane = makePlane({ auditWrites });
      plane.killSwitch("test halt");
      await plane.submit(makeIntent());

      const reject = auditWrites.find((w) => w.status === "rejected" && w.halt_reason);
      expect(reject).toBeDefined();
      expect(reject!.halt_reason).toBe("test halt");
    });

    it("persists the manual approve+operator_edits transition", async () => {
      const auditWrites: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }> = [];
      plane = makePlane({ mode: "manual", auditWrites });
      const order = await plane.submit(makeIntent());
      expect(order.status).toBe("pending_approval");

      await plane.approve(order.order_id, { limit_price: 12.55 });
      const statuses = auditWrites.map((w) => w.status);
      expect(statuses).toContain("pending_approval");
      expect(statuses).toContain("approved");
      expect(statuses).toContain("submitted");
    });

    it("persists the manual reject transition", async () => {
      const auditWrites: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }> = [];
      plane = makePlane({ mode: "manual", auditWrites });
      const order = await plane.submit(makeIntent());
      await plane.reject(order.order_id);
      expect(auditWrites.some((w) => w.status === "rejected")).toBe(true);
    });

    it("persists the cancel transition", async () => {
      const auditWrites: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }> = [];
      plane = makePlane({ auditWrites });
      const order = await plane.submit(makeIntent());
      await plane.cancel(order.order_id);
      expect(auditWrites.some((w) => w.status === "cancelled")).toBe(true);
    });
  });

  // ── QF-208: partial fills + audit_fills ─────────────────────────────

  describe("partial fills + audit_fills", () => {
    function makePlaneWithFills(
      opts: {
        mode?: string;
        auditFills?: Array<{ fill_id: string; order_id: string; quantity: number }>;
      } = {},
    ): OrderPlane {
      return createOrderPlane({
        portfolioEngine: mockPortfolioEngine(true),
        broker: mockBroker(),
        fillLog: mockFillLog(),
        logger: createTestLogger(),
        generateId: () => `id-${++idCounter}`,
        mode: (opts.mode ?? "paper_local") as never,
        ...(opts.auditFills
          ? {
              auditFillWriter: async (row) => {
                opts.auditFills!.push({
                  fill_id: row.fill_id,
                  order_id: row.order_id,
                  quantity: row.quantity,
                });
              },
            }
          : {}),
      });
    }

    it("single full fill → status=filled, average_fill_price = fill price", async () => {
      plane = makePlaneWithFills();
      const order = await plane.submit(makeIntent({ quantity: 1 }));
      fillCallback!({
        fill_id: "f-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      const updated = plane.getOrder(order.order_id)!;
      expect(updated.status).toBe("filled");
      expect(updated.filled_quantity).toBe(1);
      expect(updated.average_fill_price).toBe(12.5);
    });

    it("two partial fills summing to intent quantity → submitted → partial_fill → filled", async () => {
      plane = makePlaneWithFills();
      const order = await plane.submit(makeIntent({ quantity: 4 }));

      fillCallback!({
        fill_id: "f-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      let updated = plane.getOrder(order.order_id)!;
      expect(updated.status).toBe("partial_fill");
      expect(updated.filled_quantity).toBe(1);
      expect(updated.average_fill_price).toBe(12.5);

      fillCallback!({
        fill_id: "f-2",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 3,
        price: 12.6,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      updated = plane.getOrder(order.order_id)!;
      expect(updated.status).toBe("filled");
      expect(updated.filled_quantity).toBe(4);
      // VWAP: (12.5*1 + 12.6*3) / 4 = 12.575
      expect(updated.average_fill_price).toBeCloseTo(12.575, 5);
    });

    it("over-fill is logged + treated as filled (broker contract violation)", async () => {
      plane = makePlaneWithFills();
      const order = await plane.submit(makeIntent({ quantity: 1 }));
      fillCallback!({
        fill_id: "f-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 3, // > intent.quantity
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      const updated = plane.getOrder(order.order_id)!;
      expect(updated.status).toBe("filled");
      expect(updated.filled_quantity).toBe(3);
    });

    it("partial then cancel → status=cancelled with cumulative preserved", async () => {
      plane = makePlaneWithFills();
      const order = await plane.submit(makeIntent({ quantity: 4 }));
      fillCallback!({
        fill_id: "f-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      await plane.cancel(order.order_id);
      const updated = plane.getOrder(order.order_id)!;
      expect(updated.status).toBe("cancelled");
      expect(updated.filled_quantity).toBe(1);
      expect(updated.average_fill_price).toBe(12.5);
    });

    it("rejected_by_broker — async broker rejection transitions a submitted order to terminal state (QF-209)", async () => {
      const auditWrites: Array<{
        status: string;
        risk_violations: string | null;
        halt_reason: string | null;
      }> = [];
      plane = makePlane({ mode: "paper_local", auditWrites });
      const order = await plane.submit(makeIntent({ quantity: 1 }));
      expect(order.status).toBe("submitted");
      expect(rejectionCallback).toBeDefined();

      rejectionCallback!({
        broker_order_id: "broker-order-1",
        reason: "exchange halt — locate failure",
        broker_reason_code: "LOCATE_FAIL",
        rejected_at: "2026-05-19T12:00:05.000Z",
      });

      const updated = plane.getOrder(order.order_id)!;
      expect(updated.status).toBe("rejected_by_broker");
      expect(updated.completed_at).toBe("2026-05-19T12:00:05.000Z");
      // The broker_order_id stays populated for traceability.
      expect(updated.broker_order_id).toBe("broker-order-1");
      // Audit row captures the rejection reason.
      expect(auditWrites.some((w) => w.status === "rejected_by_broker")).toBe(true);
    });

    it("rejected_by_broker — unknown broker_order_id is a logged no-op (QF-209)", async () => {
      plane = makePlane({ mode: "paper_local" });
      await plane.submit(makeIntent());
      // Rejection for a broker_order_id we don't know.
      rejectionCallback!({
        broker_order_id: "broker-order-999",
        reason: "ghost rejection",
        rejected_at: "2026-05-19T12:00:00.000Z",
      });
      // No order transitioned; the submitted one is unaffected.
      expect(plane.listOrders().every((o) => o.status !== "rejected_by_broker")).toBe(true);
    });

    it("rejected_by_broker — rejection after fill is ignored (terminal-state guard, QF-209)", async () => {
      plane = makePlane({ mode: "paper_local" });
      const order = await plane.submit(makeIntent());
      // Fill the order
      fillCallback!({
        fill_id: "f-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      expect(plane.getOrder(order.order_id)!.status).toBe("filled");
      // Late rejection — should be ignored.
      rejectionCallback!({
        broker_order_id: "broker-order-1",
        reason: "race condition",
        rejected_at: new Date().toISOString(),
      });
      expect(plane.getOrder(order.order_id)!.status).toBe("filled");
    });

    it("auditFillWriter fires once per broker fill (incl. each partial)", async () => {
      const auditFills: Array<{ fill_id: string; order_id: string; quantity: number }> = [];
      plane = makePlaneWithFills({ auditFills });
      const order = await plane.submit(makeIntent({ quantity: 2 }));
      fillCallback!({
        fill_id: "f-1",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.5,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      fillCallback!({
        fill_id: "f-2",
        order_id: order.order_id,
        broker_order_id: "broker-order-1",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        price: 12.6,
        fees: 0,
        filled_at: new Date().toISOString(),
        intent_id: "",
        portfolio: "",
        broker: "paper",
      });
      expect(auditFills).toHaveLength(2);
      expect(auditFills.map((w) => w.fill_id)).toEqual(["f-1", "f-2"]);
      expect(auditFills.every((w) => w.order_id === order.order_id)).toBe(true);
    });
  });
});
