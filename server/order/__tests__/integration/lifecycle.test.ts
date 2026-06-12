/**
 * Integration test: Order lifecycle
 *
 * Tests paper_local full flow, state transitions, and the disconnected
 * adapter (no broker configured) → submission_failed path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createOrderPlane, type OrderPlane } from "../../plane.js";
import { createPortfolioEngine, type PortfolioEngine } from "../../../portfolio/engine.js";
import { createFillLog } from "../../fill-log.js";
import { createFakeBroker } from "../fixtures/fake-broker.js";
import { createDisconnectedAdapter } from "../../adapters/disconnected.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import { testPortfolioConfig } from "../../../__tests__/helpers/fixtures.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

const logger = createTestLogger();
let tempDir: string;
let engine: PortfolioEngine;
let orderPlane: OrderPlane;
let fills: unknown[];

function makeIntent(overrides = {}) {
  return {
    intent_id: `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    portfolio: "main",
    strategy_id: "test-strategy",
    action: "open" as const,
    symbol: "OPT:SPY:2026-05-16:C:500",
    direction: "Short" as const,
    quantity: 1,
    reason: "test",
    signal_ids: [] as string[],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("order lifecycle", () => {
  beforeEach(() => {
    tempDir = join(tmpdir(), `test-fills-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    fills = [];
    engine = createPortfolioEngine({ logger });
    engine.initPortfolio("main", testPortfolioConfig());

    const fillLog = createFillLog(join(tempDir, "main.jsonl"));
    const broker = createFakeBroker({ autoFill: true });

    orderPlane = createOrderPlane({
      portfolioEngine: engine,
      broker: broker.adapter,
      fillLog,
      logger,
      generateId: () => `order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      mode: "paper_local",
      onFill: (fill) => {
        fills.push(fill);
      },
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("paper_local mode", () => {
    // The fake broker fills asynchronously (setImmediate, like the
    // retired paper adapter). Wait a tick after submit for the fill
    // callback to fire.
    async function submitAndWaitForFill(intent: ReturnType<typeof makeIntent>) {
      const order = await orderPlane.submit(intent);
      await new Promise((r) => setTimeout(r, 50));
      return order;
    }

    it("submits intent → auto-approved → submitted (fill arrives async)", async () => {
      const order = await submitAndWaitForFill(makeIntent());

      expect(order).toBeDefined();
      // After the async fill fires, order should be filled
      const updated = orderPlane.getOrder(order.order_id);
      expect(updated?.status).toBe("filled");
    });

    it("writes fill to portfolio engine", async () => {
      await submitAndWaitForFill(makeIntent());

      const state = engine.getState("main");
      expect(state.positions.length).toBeGreaterThan(0);
    });

    it("fires onFill callback", async () => {
      await submitAndWaitForFill(makeIntent());
      expect(fills.length).toBeGreaterThan(0);
    });

    it("writes fill log entry", async () => {
      await submitAndWaitForFill(makeIntent());

      const fillLog = createFillLog(join(tempDir, "main.jsonl"));
      const logEntries = fillLog.read();
      expect(logEntries.length).toBeGreaterThan(0);
    });
  });

  describe("state machine", () => {
    it("tracks order in list", async () => {
      await orderPlane.submit(makeIntent());
      const orders = orderPlane.listOrders("main");
      expect(orders.length).toBeGreaterThan(0);
    });

    it("retrieves order by id", async () => {
      const order = await orderPlane.submit(makeIntent());
      const retrieved = orderPlane.getOrder(order.order_id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.order_id).toBe(order.order_id);
    });
  });

  // QF-337 — backward-compat check. With no broker enabled in
  // brokers.json the OrderPlane holds the disconnected fallback (which
  // replaces the retired in-process paper adapter). An auto-approved
  // paper_local order must still be SUBMITTED to the broker, then land in
  // submission_failed when the broker refuses — the honest state for an
  // OPL with no execution transport behind it.
  describe("disconnected adapter (no broker configured)", () => {
    let auditWrites: Array<{ order_id: string; status: string }>;
    let disconnectedPlane: OrderPlane;

    beforeEach(() => {
      auditWrites = [];
      const fillLog = createFillLog(join(tempDir, "disconnected.jsonl"));
      disconnectedPlane = createOrderPlane({
        portfolioEngine: engine,
        broker: createDisconnectedAdapter(),
        fillLog,
        logger,
        generateId: () => `order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        mode: "paper_local",
        auditOrderWriter: async (row) => {
          auditWrites.push({ order_id: row.order_id, status: row.status });
        },
      });
    });

    it("auto-approves, attempts submit, then transitions to submission_failed", async () => {
      const order = await disconnectedPlane.submit(makeIntent());
      const updated = disconnectedPlane.getOrder(order.order_id);

      // paper_local auto-approves and the OPL flips to "submitted" before
      // calling the broker; the refusing broker then drives it terminal.
      expect(updated?.status).toBe("submission_failed");
      expect(updated?.completed_at).toBeDefined();
    });

    it("the disconnected broker refuses submitOrder with 'no broker configured'", async () => {
      const adapter = createDisconnectedAdapter();
      await expect(
        adapter.submitOrder({
          client_order_id: "intent-1",
          symbol: "OPT:SPY:2026-05-16:C:500",
          direction: "Short",
          quantity: 1,
          orderType: "market",
        }),
      ).rejects.toThrow(/no broker configured/);
    });

    it("audit_orders reflects the submitted → submission_failed sequence", async () => {
      const order = await disconnectedPlane.submit(makeIntent());
      const statuses = auditWrites
        .filter((w) => w.order_id === order.order_id)
        .map((w) => w.status);
      expect(statuses).toContain("submitted");
      expect(statuses[statuses.length - 1]).toBe("submission_failed");
    });
  });

  describe("risk rejection", () => {
    it("rejects intent exceeding max_order_size", async () => {
      const order = await orderPlane.submit(makeIntent({ quantity: 15 }));
      expect(order.status).toBe("rejected");
    });

    it("rejects intent when system is halted", async () => {
      orderPlane.killSwitch("test halt");
      const order = await orderPlane.submit(makeIntent());
      expect(order.status).toBe("rejected");
    });
  });
});
