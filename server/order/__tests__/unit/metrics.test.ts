// QF-217 — OrderPlane metrics: counters + lifecycle histogram increment
// at the right state-machine transitions.

import { describe, it, expect, beforeEach } from "vitest";
import { createOrderPlane, type OrderPlane } from "../../plane.js";
import { createOrderPlaneMetrics, type OrderPlaneMetrics } from "../../metrics.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type {
  BrokerAdapter,
  BrokerRejection,
  Fill,
  OrderIntent,
} from "../../../../src/types/order.js";
import type { PortfolioEngine } from "../../../portfolio/engine.js";
import type { FillLog } from "../../fill-log.js";

// ── Mock factories (mirror plane.test.ts) ─────────────────────────────

let fillCallback: ((fill: Fill) => void) | null = null;
let rejectionCallback: ((rejection: BrokerRejection) => void) | null = null;
let submitCount = 0;

function mockBroker(failSubmit = false): BrokerAdapter {
  fillCallback = null;
  rejectionCallback = null;
  submitCount = 0;
  return {
    name: "paper",
    async available() {
      return true;
    },
    async submitOrder() {
      if (failSubmit) throw new Error("submit blew up");
      submitCount++;
      return `broker-order-${submitCount}`;
    },
    async cancelOrder() {},
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

function mockPortfolioEngine(canExecuteOk = true): PortfolioEngine {
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
    applyFill: () => {},
  } as unknown as PortfolioEngine;
}

function mockFillLog(): FillLog {
  return {
    append: () => {},
    replay: () => [],
  } as unknown as FillLog;
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intent_id: `intent-${Math.random()}`,
    portfolio: "main",
    strategy_id: "test-strategy",
    action: "open",
    symbol: "OPT:SPY:2026-06-19:C:500",
    direction: "Short",
    quantity: 2,
    reason: "test",
    signal_ids: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let idCounter = 0;

function makePlane(opts: {
  metrics: OrderPlaneMetrics;
  mode?: string;
  canExecute?: boolean;
  failSubmit?: boolean;
}): OrderPlane {
  return createOrderPlane({
    portfolioEngine: mockPortfolioEngine(opts.canExecute ?? true),
    broker: mockBroker(opts.failSubmit ?? false),
    fillLog: mockFillLog(),
    logger: createTestLogger(),
    generateId: () => `order-${++idCounter}`,
    mode: (opts.mode ?? "paper_local") as never,
    metrics: opts.metrics,
  });
}

async function getCounter(
  metrics: OrderPlaneMetrics,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const json = await metrics.registry.getMetricsAsJSON();
  const metric = json.find((m) => m.name === name);
  if (!metric || !("values" in metric)) return 0;
  const labelKeys = Object.keys(labels);
  const v = metric.values.find((vv) => {
    const ml = vv.labels as Record<string, string>;
    return labelKeys.every((k) => ml[k] === labels[k]);
  });
  return v ? Number(v.value) : 0;
}

async function getHistogramCount(
  metrics: OrderPlaneMetrics,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const json = await metrics.registry.getMetricsAsJSON();
  const metric = json.find((m) => m.name === name);
  if (!metric || !("values" in metric)) return 0;
  const labelKeys = Object.keys(labels);
  // Histogram count appears with metricName === `${name}_count`.
  const v = (
    metric.values as Array<{ metricName?: string; labels: Record<string, string>; value: number }>
  ).find((vv) => {
    if (vv.metricName !== `${name}_count`) return false;
    return labelKeys.every((k) => vv.labels[k] === labels[k]);
  });
  return v ? Number(v.value) : 0;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("OrderPlane metrics", () => {
  let metrics: OrderPlaneMetrics;

  beforeEach(() => {
    idCounter = 0;
    metrics = createOrderPlaneMetrics();
  });

  it("increments orders_submitted_total exactly once on a successful submit", async () => {
    const plane = makePlane({ metrics });
    await plane.submit(makeIntent());
    const v = await getCounter(metrics, "orders_submitted_total", {
      portfolio: "main",
      broker: "paper",
      mode: "paper_local",
    });
    expect(v).toBe(1);
  });

  it("increments orders_rejected_total{reason='risk'} when risk check fails", async () => {
    const plane = makePlane({ metrics, canExecute: false });
    await plane.submit(makeIntent());
    expect(await getCounter(metrics, "orders_rejected_total", { reason: "risk" })).toBe(1);
    expect(await getCounter(metrics, "orders_submitted_total", { broker: "paper" })).toBe(0);
  });

  it("increments orders_rejected_total{reason='halt'} when system is halted", async () => {
    const plane = makePlane({ metrics });
    plane.killSwitch("test halt");
    await plane.submit(makeIntent());
    expect(await getCounter(metrics, "orders_rejected_total", { reason: "halt" })).toBe(1);
  });

  it("increments orders_rejected_total{reason='quote_unavailable'} on pre-submit rejection", async () => {
    const plane = makePlane({ metrics });
    plane.recordPreSubmitRejection(makeIntent(), {
      kind: "quote_unavailable",
      reason: "stale",
    });
    expect(
      await getCounter(metrics, "orders_rejected_total", { reason: "quote_unavailable" }),
    ).toBe(1);
  });

  it("increments orders_cancelled_total with the supplied reason label", async () => {
    const plane = makePlane({ metrics, mode: "manual" });
    const order = await plane.submit(makeIntent());
    await plane.cancel(order.order_id, { reason: "signal_invalidated" });
    expect(
      await getCounter(metrics, "orders_cancelled_total", { reason: "signal_invalidated" }),
    ).toBe(1);
  });

  it("defaults cancel reason to 'manual' when no reason supplied", async () => {
    const plane = makePlane({ metrics, mode: "manual" });
    const order = await plane.submit(makeIntent());
    await plane.cancel(order.order_id);
    expect(await getCounter(metrics, "orders_cancelled_total", { reason: "manual" })).toBe(1);
  });

  it("increments orders_cancelled_total{reason='kill_switch'} on kill-switch sweep", async () => {
    const plane = makePlane({ metrics, mode: "manual" });
    await plane.submit(makeIntent());
    plane.killSwitch("emergency");
    expect(
      await getCounter(metrics, "orders_cancelled_total", { reason: "kill_switch" }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("increments orders_filled_total{partial='false'} on a full fill", async () => {
    const plane = makePlane({ metrics });
    const order = await plane.submit(makeIntent({ quantity: 1 }));
    fillCallback?.({
      fill_id: "f-1",
      order_id: order.order_id,
      broker_order_id: order.broker_order_id!,
      intent_id: order.intent_id,
      portfolio: order.portfolio,
      symbol: "OPT:SPY:2026-06-19:C:500",
      direction: "Short",
      broker: "paper",
      price: 12.5,
      quantity: 1,
      fees: 0,
      filled_at: new Date().toISOString(),
    });
    expect(
      await getCounter(metrics, "orders_filled_total", { broker: "paper", partial: "false" }),
    ).toBe(1);
  });

  it("increments orders_filled_total{partial='true'} on a partial fill", async () => {
    const plane = makePlane({ metrics });
    const order = await plane.submit(makeIntent({ quantity: 5 }));
    fillCallback?.({
      fill_id: "f-1",
      order_id: order.order_id,
      broker_order_id: order.broker_order_id!,
      intent_id: order.intent_id,
      portfolio: order.portfolio,
      symbol: "OPT:SPY:2026-06-19:C:500",
      direction: "Short",
      broker: "paper",
      price: 12.5,
      quantity: 2,
      fees: 0,
      filled_at: new Date().toISOString(),
    });
    expect(
      await getCounter(metrics, "orders_filled_total", { broker: "paper", partial: "true" }),
    ).toBe(1);
  });

  it("increments orders_rejected_by_broker_total with broker_reason_code label", async () => {
    const plane = makePlane({ metrics });
    const order = await plane.submit(makeIntent());
    rejectionCallback?.({
      broker_order_id: order.broker_order_id!,
      reason: "Symbol not found",
      broker_reason_code: "SCHWAB-201",
      rejected_at: new Date().toISOString(),
    });
    expect(
      await getCounter(metrics, "orders_rejected_by_broker_total", {
        broker: "paper",
        broker_reason_code: "SCHWAB-201",
      }),
    ).toBe(1);
  });

  it("records the lifecycle histogram once per order on terminal transition", async () => {
    const plane = makePlane({ metrics });
    const order = await plane.submit(makeIntent({ quantity: 1 }));
    fillCallback?.({
      fill_id: "f-1",
      order_id: order.order_id,
      broker_order_id: order.broker_order_id!,
      intent_id: order.intent_id,
      portfolio: order.portfolio,
      symbol: "OPT:SPY:2026-06-19:C:500",
      direction: "Short",
      broker: "paper",
      price: 12.5,
      quantity: 1,
      fees: 0,
      filled_at: new Date().toISOString(),
    });
    const count = await getHistogramCount(metrics, "order_lifecycle_duration_seconds", {
      terminal_state: "filled",
    });
    expect(count).toBe(1);
  });

  it("does not double-observe lifecycle on a second terminal-state event for the same order", async () => {
    const plane = makePlane({ metrics });
    const order = await plane.submit(makeIntent({ quantity: 1 }));
    fillCallback?.({
      fill_id: "f-1",
      order_id: order.order_id,
      broker_order_id: order.broker_order_id!,
      intent_id: order.intent_id,
      portfolio: order.portfolio,
      symbol: "OPT:SPY:2026-06-19:C:500",
      direction: "Short",
      broker: "paper",
      price: 12.5,
      quantity: 1,
      fees: 0,
      filled_at: new Date().toISOString(),
    });
    // A spurious second fill event for the same order
    fillCallback?.({
      fill_id: "f-2",
      order_id: order.order_id,
      broker_order_id: order.broker_order_id!,
      intent_id: order.intent_id,
      portfolio: order.portfolio,
      symbol: "OPT:SPY:2026-06-19:C:500",
      direction: "Short",
      broker: "paper",
      price: 12.5,
      quantity: 1,
      fees: 0,
      filled_at: new Date().toISOString(),
    });
    const count = await getHistogramCount(metrics, "order_lifecycle_duration_seconds", {
      terminal_state: "filled",
    });
    expect(count).toBe(1);
  });
});
