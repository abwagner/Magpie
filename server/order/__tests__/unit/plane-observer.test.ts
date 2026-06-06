// QF-234 — OrderPlane accepts OrderObservationAdapter[] observers in addition
// to the active broker. Fills/rejections from observers must flow through the
// same audit/portfolio/journal pipeline as the active broker — the only
// difference is QF didn't initiate the trade.

import { describe, it, expect, beforeEach } from "vitest";
import { createOrderPlane, type OrderPlane } from "../../plane.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type {
  BrokerAdapter,
  BrokerRejection,
  Fill,
  OrderIntent,
  OrderObservationAdapter,
} from "../../../../src/types/order.js";
import type { PortfolioEngine } from "../../../portfolio/engine.js";
import type { FillLog } from "../../fill-log.js";

// ── Mock factories ───────────────────────────────────────────────────

function activeBroker(): BrokerAdapter {
  return {
    name: "mock-active",
    async available() {
      return true;
    },
    async submitOrder() {
      return "active-broker-order-1";
    },
    async cancelOrder() {},
    async getOrderStatus(id) {
      return {
        broker_order_id: id,
        status: "unknown" as const,
        filled_quantity: 0,
        average_fill_price: null,
        rejection_reason: null,
      };
    },
    async getPositions() {
      return [];
    },
    onFill() {},
    onRejection() {},
  };
}

function observerWithCallbacks(): OrderObservationAdapter & {
  fire(fill: Fill): void;
  fireRejection(rej: BrokerRejection): void;
} {
  const fillCbs: Array<(f: Fill) => void> = [];
  const rejCbs: Array<(r: BrokerRejection) => void> = [];
  return {
    name: "mock-observer",
    async available() {
      return true;
    },
    async getOrderStatus(id) {
      return {
        broker_order_id: id,
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
      fillCbs.push(cb);
    },
    onRejection(cb) {
      rejCbs.push(cb);
    },
    fire(fill) {
      for (const cb of fillCbs) cb(fill);
    },
    fireRejection(rej) {
      for (const cb of rejCbs) cb(rej);
    },
  };
}

let appendedFills: Fill[] = [];
let fillsApplied: Array<{ portfolio: string; fill: Fill }> = [];

function mockPortfolioEngine(): PortfolioEngine {
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
    canExecute: () => ({ ok: true, violations: [] }),
    applyFill: (portfolio: string, fill: Fill) => {
      fillsApplied.push({ portfolio, fill });
    },
  } as unknown as PortfolioEngine;
}

function mockFillLog(): FillLog {
  appendedFills = [];
  return {
    append: (fill: Fill) => {
      appendedFills.push(fill);
    },
    replay: () => [],
  } as unknown as FillLog;
}

function makeIntent(): OrderIntent {
  return {
    intent_id: `intent-${Math.random()}`,
    portfolio: "main",
    strategy_id: "test",
    action: "open",
    symbol: "OPT:SPY:2026-06-19:C:500",
    direction: "Long",
    quantity: 1,
    reason: "test",
    signal_ids: [],
    created_at: new Date().toISOString(),
  };
}

let idCounter = 0;

// ── Tests ────────────────────────────────────────────────────────────

describe("order plane — observer dispatch (QF-234)", () => {
  let plane: OrderPlane;
  let observer: ReturnType<typeof observerWithCallbacks>;

  beforeEach(() => {
    idCounter = 0;
    observer = observerWithCallbacks();
    plane = createOrderPlane({
      portfolioEngine: mockPortfolioEngine(),
      broker: activeBroker(),
      fillLog: mockFillLog(),
      logger: createTestLogger(),
      generateId: () => `order-${++idCounter}`,
      mode: "paper_local",
      observers: [observer],
    });
  });

  it("routes an observer fill through the same audit/portfolio path as the active broker", async () => {
    const order = await plane.submit(makeIntent());
    // Pin the broker_order_id the observer will reference.
    const observerBrokerOrderId = order.broker_order_id;
    expect(observerBrokerOrderId).toBeDefined();

    const observedFill: Fill = {
      fill_id: "observer-fill-1",
      order_id: "ignored-by-dispatch",
      intent_id: "",
      portfolio: "",
      symbol: order.broker,
      direction: "Long",
      quantity: 1,
      price: 5.0,
      fees: 0.65,
      filled_at: new Date().toISOString(),
      broker: "mock-observer",
      broker_order_id: observerBrokerOrderId,
    };
    observer.fire(observedFill);

    // The dispatch enriches intent_id + portfolio from the matched order.
    expect(appendedFills.length).toBe(1);
    expect(appendedFills[0]?.intent_id).toBe(order.intent_id);
    expect(appendedFills[0]?.portfolio).toBe(order.portfolio);
    expect(appendedFills[0]?.broker_order_id).toBe(observerBrokerOrderId);
    expect(fillsApplied.length).toBe(1);
    expect(fillsApplied[0]?.fill.price).toBe(5.0);

    const updated = plane.getOrder(order.order_id);
    expect(updated?.status).toBe("filled");
    expect(updated?.filled_quantity).toBe(1);
    expect(updated?.average_fill_price).toBe(5.0);
  });

  it("drops observer fills for unknown broker_order_id (NT-internal-orders case)", () => {
    const orphanFill: Fill = {
      fill_id: "orphan-1",
      order_id: "irrelevant",
      intent_id: "",
      portfolio: "",
      symbol: "OPT:SPY:2026-06-19:C:500",
      direction: "Long",
      quantity: 1,
      price: 5.0,
      fees: 0.65,
      filled_at: new Date().toISOString(),
      broker: "mock-observer",
      broker_order_id: "broker-order-id-QF-never-saw",
    };
    observer.fire(orphanFill);

    expect(appendedFills.length).toBe(0);
    expect(fillsApplied.length).toBe(0);
  });

  it("routes an observer rejection to rejected_by_broker on the matched order", async () => {
    const order = await plane.submit(makeIntent());
    expect(order.status).toBe("submitted");

    observer.fireRejection({
      broker_order_id: order.broker_order_id!,
      reason: "exchange halt",
      broker_reason_code: "HALT_REGULATORY",
      rejected_at: new Date().toISOString(),
    });

    const updated = plane.getOrder(order.order_id);
    expect(updated?.status).toBe("rejected_by_broker");
    expect(updated?.completed_at).toBeDefined();
  });
});
