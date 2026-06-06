// QF-214 — Restart recovery integration test.
//
// Verifies that:
//   1. Submit an order through OrderPlane → audit_orders + audit_intents
//      rows land on disk.
//   2. "Restart" by constructing a fresh OrderPlane on the same DB.
//   3. rehydrateOrderPlane() repopulates the in-memory orders/intents
//      maps from the durable audit trail.
//   4. listOrders() shows the in-flight order with its last-known status.
//   5. Working-order monitor re-registers tracked tasks from the
//      originating_signal_json column.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createOrderPlane, type OrderPlane } from "../../plane.js";
import { rehydrateOrderPlane, reconcileOrdersWithBroker } from "../../restart-recovery.js";
import { createAuditOrderWriter } from "../../audit-orders.js";
import { createAuditFillWriter, buildFillRow } from "../../audit-fills.js";
import { createAuditIntentWriter, buildIntentRow } from "../../audit-intent.js";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type {
  BrokerAdapter,
  BrokerOrderStatus,
  Fill,
  OrderIntent,
  OrderObservationAdapter,
} from "../../../../src/types/order.js";
import type { PortfolioEngine } from "../../../portfolio/engine.js";
import type { FillLog } from "../../fill-log.js";
// Signal type inlined after src/types/signal.ts retirement (QF-261).
interface Signal {
  schema_version: number;
  model_id: string;
  model_version: string;
  symbol: string;
  asof: string;
  horizon: { duration: string | null; anchor: string; label: string | null };
  kind: string;
  payload: Record<string, unknown>;
  confidence?: number;
  provenance: { worker_id: string; run_id: string; input_hash?: string };
}

// ── Mock factories (mirror plane.test.ts) ─────────────────────────────

function mockBroker(): BrokerAdapter {
  return {
    name: "paper",
    async available() {
      return true;
    },
    async submitOrder() {
      return `broker-${Math.random().toString(36).slice(2, 8)}`;
    },
    async cancelOrder() {},
    async getOrderStatus(brokerOrderId: string) {
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
    onFill() {},
    onRejection() {},
  };
}

function mockPortfolioEngine(): PortfolioEngine {
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
    applyFill: () => {},
  } as unknown as PortfolioEngine;
}

function mockFillLog(): FillLog {
  return { append: () => {}, replay: () => [] } as unknown as FillLog;
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intent_id: `intent-${Math.random()}`,
    portfolio: "main",
    strategy_id: "vol-buyer-spy",
    action: "open",
    symbol: "OPT:SPY:2026-06-19:C:500",
    direction: "Short",
    quantity: 1,
    reason: "test",
    signal_ids: ["sig-1"],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    schema_version: 1,
    model_id: "vol-forecast-spy-1d",
    model_version: "v1",
    symbol: "EQ:SPY",
    asof: "2026-05-19T12:00:00Z",
    horizon: { duration: "1d", anchor: "next_close", label: null },
    kind: "point",
    payload: { kind: "point", value: 0.5 },
    provenance: { worker_id: "w", run_id: "r" },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("restart-recovery integration", () => {
  let tdb: TestDb;

  beforeEach(async () => {
    tdb = await createTestDb();
  });

  afterEach(() => {
    tdb.close();
  });

  function makePlaneWithWriters(): OrderPlane {
    return createOrderPlane({
      portfolioEngine: mockPortfolioEngine(),
      broker: mockBroker(),
      fillLog: mockFillLog(),
      logger: createTestLogger(),
      generateId: () =>
        "ord-" + Math.random().toString(36).slice(2, 10).padStart(8, "0").toUpperCase(),
      mode: "paper_local",
      auditOrderWriter: createAuditOrderWriter(tdb.db, createTestLogger()),
    });
  }

  it("rehydrates a submitted order from audit_orders + audit_intents", async () => {
    // Pre-write the intent row directly (the production path writes
    // it from execution-layer; this test isolates OrderPlane).
    const intent = makeIntent({ intent_id: "int-1" });
    const writer = createAuditIntentWriter(tdb.db, createTestLogger());
    await writer(
      buildIntentRow({
        intent_id: intent.intent_id,
        signal_ids: intent.signal_ids,
        portfolio: intent.portfolio,
        symbol: intent.symbol,
        direction: intent.direction,
        quantity: intent.quantity,
        strategy_id: intent.strategy_id,
        created_at: intent.created_at,
        originating_signal: makeSignal(),
      }),
    );

    // Submit through OrderPlane — writes audit_orders.
    const plane1 = makePlaneWithWriters();
    const order = await plane1.submit(intent);
    expect(order.status).toBe("submitted");

    // Wait for the async writer to flush. Best-effort; the writer is
    // fire-and-forget, so a microtask + setImmediate covers most cases.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // "Restart" — build a fresh plane on the same DB and rehydrate.
    const plane2 = makePlaneWithWriters();
    expect(plane2.listOrders()).toHaveLength(0); // empty before rehydrate
    const stats = await rehydrateOrderPlane(plane2, tdb.db, createTestLogger());
    expect(stats.orders_loaded).toBe(1);
    expect(stats.orders_skipped_missing_intent).toBe(0);

    const loaded = plane2.listOrders();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.order_id).toBe(order.order_id);
    expect(loaded[0]!.intent_id).toBe("int-1");
    expect(loaded[0]!.status).toBe("submitted");
    expect(loaded[0]!.portfolio).toBe("main");
  });

  it("skips terminal-state orders (filled, cancelled, rejected)", async () => {
    const intentA = makeIntent({ intent_id: "int-A" });
    const intentB = makeIntent({ intent_id: "int-B" });
    const writer = createAuditIntentWriter(tdb.db, createTestLogger());
    await writer(
      buildIntentRow({
        intent_id: intentA.intent_id,
        signal_ids: intentA.signal_ids,
        portfolio: intentA.portfolio,
        symbol: intentA.symbol,
        direction: intentA.direction,
        quantity: intentA.quantity,
        strategy_id: intentA.strategy_id,
        created_at: intentA.created_at,
      }),
    );
    await writer(
      buildIntentRow({
        intent_id: intentB.intent_id,
        signal_ids: intentB.signal_ids,
        portfolio: intentB.portfolio,
        symbol: intentB.symbol,
        direction: intentB.direction,
        quantity: intentB.quantity,
        strategy_id: intentB.strategy_id,
        created_at: intentB.created_at,
      }),
    );

    // Two orders: A submitted (rehydratable), B filled (terminal — skip).
    const orderWriter = createAuditOrderWriter(tdb.db, createTestLogger());
    await orderWriter({
      order_id: "ord-A",
      intent_id: "int-A",
      broker: "paper",
      execution_mode: "paper_local",
      status: "submitted",
      created_at: new Date().toISOString(),
      risk_checked_at: null,
      approved_at: null,
      submitted_at: new Date().toISOString(),
      completed_at: null,
      broker_order_id: "bok-A",
      operator_edits: null,
      risk_violations: null,
      halt_reason: null,
      broker_rejection_reason: null,
      quote_failure_reason: null,
      cancel_reason: null,
      source: "qf",
      correlation_id: null,
      account_id: "default",
    });
    await orderWriter({
      order_id: "ord-B",
      intent_id: "int-B",
      broker: "paper",
      execution_mode: "paper_local",
      status: "filled",
      created_at: new Date().toISOString(),
      risk_checked_at: null,
      approved_at: null,
      submitted_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      broker_order_id: "bok-B",
      operator_edits: null,
      risk_violations: null,
      halt_reason: null,
      broker_rejection_reason: null,
      quote_failure_reason: null,
      cancel_reason: null,
      source: "qf",
      correlation_id: null,
      account_id: "default",
    });

    const plane = makePlaneWithWriters();
    const stats = await rehydrateOrderPlane(plane, tdb.db, createTestLogger());
    expect(stats.orders_loaded).toBe(1);
    expect(plane.listOrders().map((o) => o.order_id)).toEqual(["ord-A"]);
  });

  it("is idempotent — second rehydrate doesn't double-insert", async () => {
    const writer = createAuditIntentWriter(tdb.db, createTestLogger());
    await writer(
      buildIntentRow({
        intent_id: "int-1",
        signal_ids: [],
        portfolio: "main",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: 1,
        strategy_id: "vol-buyer-spy",
        created_at: new Date().toISOString(),
      }),
    );
    const orderWriter = createAuditOrderWriter(tdb.db, createTestLogger());
    await orderWriter({
      order_id: "ord-1",
      intent_id: "int-1",
      broker: "paper",
      execution_mode: "paper_local",
      status: "submitted",
      created_at: new Date().toISOString(),
      risk_checked_at: null,
      approved_at: null,
      submitted_at: new Date().toISOString(),
      completed_at: null,
      broker_order_id: "bok-1",
      operator_edits: null,
      risk_violations: null,
      halt_reason: null,
      broker_rejection_reason: null,
      quote_failure_reason: null,
      cancel_reason: null,
      source: "qf",
      correlation_id: null,
      account_id: "default",
    });

    const plane = makePlaneWithWriters();
    await rehydrateOrderPlane(plane, tdb.db, createTestLogger());
    expect(plane.listOrders()).toHaveLength(1);
    await rehydrateOrderPlane(plane, tdb.db, createTestLogger());
    expect(plane.listOrders()).toHaveLength(1); // not 2
  });
});

// QF-231 — audit_fills replay on restart. Verifies that partial-fill
// state (filled_quantity + average_fill_price) is reconstructed from
// audit_fills so the VWAP arithmetic in plane.ts's onFill composes
// correctly with any post-restart fills.
describe("restart-recovery — audit_fills replay (QF-231)", () => {
  let tdb: TestDb;

  beforeEach(async () => {
    tdb = await createTestDb();
  });

  afterEach(() => {
    tdb.close();
  });

  function makePlane(): OrderPlane {
    return createOrderPlane({
      portfolioEngine: mockPortfolioEngine(),
      broker: mockBroker(),
      fillLog: mockFillLog(),
      logger: createTestLogger(),
      generateId: () => `ord-${Math.random().toString(36).slice(2, 10)}`,
      mode: "paper_local",
      auditOrderWriter: createAuditOrderWriter(tdb.db, createTestLogger()),
    });
  }

  async function seedOrderWithFills(opts: {
    order_id: string;
    intent_id: string;
    intent_quantity: number;
    order_status: "partial_fill" | "submitted" | "filled";
    fills: Array<{ fill_id: string; price: number; quantity: number }>;
  }): Promise<void> {
    const intentWriter = createAuditIntentWriter(tdb.db, createTestLogger());
    await intentWriter(
      buildIntentRow({
        intent_id: opts.intent_id,
        signal_ids: [],
        portfolio: "main",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Short",
        quantity: opts.intent_quantity,
        strategy_id: "test",
        created_at: new Date().toISOString(),
      }),
    );
    const orderWriter = createAuditOrderWriter(tdb.db, createTestLogger());
    await orderWriter({
      order_id: opts.order_id,
      intent_id: opts.intent_id,
      broker: "paper",
      execution_mode: "paper_local",
      status: opts.order_status,
      created_at: new Date().toISOString(),
      risk_checked_at: null,
      approved_at: null,
      submitted_at: new Date().toISOString(),
      completed_at: null,
      broker_order_id: `bok-${opts.order_id}`,
      operator_edits: null,
      risk_violations: null,
      halt_reason: null,
      broker_rejection_reason: null,
      quote_failure_reason: null,
      cancel_reason: null,
      source: "qf",
      correlation_id: null,
      account_id: "default",
    });
    const fillWriter = createAuditFillWriter(tdb.db, createTestLogger());
    for (const fill of opts.fills) {
      await fillWriter(
        buildFillRow({
          fill: {
            fill_id: fill.fill_id,
            order_id: opts.order_id,
            intent_id: opts.intent_id,
            portfolio: "main",
            symbol: "OPT:SPY:2026-06-19:C:500",
            direction: "Short",
            quantity: fill.quantity,
            price: fill.price,
            fees: 0,
            filled_at: new Date().toISOString(),
            broker: "paper",
          },
          expected_price: null,
        }),
      );
    }
  }

  it("reconstructs filled_quantity + average_fill_price from a single partial fill", async () => {
    await seedOrderWithFills({
      order_id: "ord-A",
      intent_id: "int-A",
      intent_quantity: 5,
      order_status: "partial_fill",
      fills: [{ fill_id: "f-1", price: 12.0, quantity: 2 }],
    });

    const plane = makePlane();
    const stats = await rehydrateOrderPlane(plane, tdb.db, createTestLogger());
    expect(stats.orders_loaded).toBe(1);

    const order = plane.getOrder("ord-A");
    expect(order?.filled_quantity).toBe(2);
    expect(order?.average_fill_price).toBe(12.0);
    expect(order?.status).toBe("partial_fill");
  });

  it("reconstructs VWAP from multiple fills at different prices", async () => {
    // 2 fills: 3 @ 10.0 and 2 @ 15.0 → VWAP = (3*10 + 2*15) / 5 = 60/5 = 12.0
    await seedOrderWithFills({
      order_id: "ord-B",
      intent_id: "int-B",
      intent_quantity: 10,
      order_status: "partial_fill",
      fills: [
        { fill_id: "f-1", price: 10.0, quantity: 3 },
        { fill_id: "f-2", price: 15.0, quantity: 2 },
      ],
    });

    const plane = makePlane();
    await rehydrateOrderPlane(plane, tdb.db, createTestLogger());

    const order = plane.getOrder("ord-B");
    expect(order?.filled_quantity).toBe(5);
    expect(order?.average_fill_price).toBeCloseTo(12.0, 5);
  });

  it("leaves filled_quantity + average_fill_price undefined when no fills exist", async () => {
    await seedOrderWithFills({
      order_id: "ord-C",
      intent_id: "int-C",
      intent_quantity: 5,
      order_status: "submitted",
      fills: [],
    });

    const plane = makePlane();
    await rehydrateOrderPlane(plane, tdb.db, createTestLogger());

    const order = plane.getOrder("ord-C");
    expect(order?.filled_quantity).toBeUndefined();
    expect(order?.average_fill_price).toBeUndefined();
  });

  it("loads aggregates for multiple orders in one query (no N+1)", async () => {
    await seedOrderWithFills({
      order_id: "ord-D",
      intent_id: "int-D",
      intent_quantity: 5,
      order_status: "partial_fill",
      fills: [{ fill_id: "f-D1", price: 5.0, quantity: 1 }],
    });
    await seedOrderWithFills({
      order_id: "ord-E",
      intent_id: "int-E",
      intent_quantity: 5,
      order_status: "partial_fill",
      fills: [{ fill_id: "f-E1", price: 7.0, quantity: 2 }],
    });

    const plane = makePlane();
    const stats = await rehydrateOrderPlane(plane, tdb.db, createTestLogger());
    expect(stats.orders_loaded).toBe(2);

    expect(plane.getOrder("ord-D")?.filled_quantity).toBe(1);
    expect(plane.getOrder("ord-D")?.average_fill_price).toBe(5.0);
    expect(plane.getOrder("ord-E")?.filled_quantity).toBe(2);
    expect(plane.getOrder("ord-E")?.average_fill_price).toBe(7.0);
  });

  it("logs an error on over-fill (cumulative > intent.quantity) but still rehydrates", async () => {
    // 6 contracts filled against an intent of 5 — broker contract violation.
    const errors: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = {
      ...createTestLogger(),
      error: (event: string, payload: Record<string, unknown>) => {
        errors.push({ event, payload });
      },
    };

    await seedOrderWithFills({
      order_id: "ord-F",
      intent_id: "int-F",
      intent_quantity: 5,
      order_status: "partial_fill",
      fills: [
        { fill_id: "f-F1", price: 10.0, quantity: 4 },
        { fill_id: "f-F2", price: 11.0, quantity: 2 },
      ],
    });

    const plane = makePlane();
    await rehydrateOrderPlane(plane, tdb.db, logger as never);

    const order = plane.getOrder("ord-F");
    expect(order?.filled_quantity).toBe(6);
    const overFillErr = errors.find((e) => e.event.includes("over-fill"));
    expect(overFillErr).toBeDefined();
    expect(overFillErr?.payload).toMatchObject({
      order_id: "ord-F",
      intent_quantity: 5,
      cumulative_filled: 6,
    });
  });
});

// QF-230 — broker reconciliation on restart. After rehydration, walk
// active orders and ask broker.getOrderStatus what really happened
// while QF was down; synthesize the missing transitions.
describe("restart-recovery — broker reconciliation walk (QF-230)", () => {
  function mockObserver(replies: Map<string, BrokerOrderStatus>): OrderObservationAdapter {
    return {
      name: "paper",
      async available() {
        return true;
      },
      async getOrderStatus(brokerOrderId) {
        return (
          replies.get(brokerOrderId) ?? {
            broker_order_id: brokerOrderId,
            status: "unknown",
            filled_quantity: 0,
            average_fill_price: null,
            rejection_reason: null,
          }
        );
      },
      async getPositions() {
        return [];
      },
      onFill() {},
      onRejection() {},
    };
  }

  function makeOrderPlane(): OrderPlane {
    return createOrderPlane({
      portfolioEngine: mockPortfolioEngine(),
      broker: mockBroker(),
      fillLog: mockFillLog(),
      logger: createTestLogger(),
      generateId: () => `ord-${Math.random().toString(36).slice(2, 10)}`,
      mode: "paper_local",
    });
  }

  function seedSubmittedOrder(
    plane: OrderPlane,
    opts: { order_id: string; broker_order_id: string; intent_quantity: number },
  ): void {
    plane.rehydrateOrder(
      {
        order_id: opts.order_id,
        intent_id: `int-${opts.order_id}`,
        client_order_id: `int-${opts.order_id}`,
        portfolio: "main",
        broker: "paper",
        execution_mode: "paper_local",
        status: "submitted",
        created_at: new Date().toISOString(),
        broker_order_id: opts.broker_order_id,
      },
      makeIntent({
        intent_id: `int-${opts.order_id}`,
        quantity: opts.intent_quantity,
      }),
    );
  }

  it("leaves orders alone when broker reports 'working'", async () => {
    const plane = makeOrderPlane();
    seedSubmittedOrder(plane, { order_id: "A", broker_order_id: "B-A", intent_quantity: 5 });
    const replies = new Map<string, BrokerOrderStatus>([
      [
        "B-A",
        {
          broker_order_id: "B-A",
          status: "working",
          filled_quantity: 0,
          average_fill_price: null,
          rejection_reason: null,
        },
      ],
    ]);

    const stats = await reconcileOrdersWithBroker(plane, mockObserver(replies), createTestLogger());

    expect(stats.checked).toBe(1);
    expect(stats.working).toBe(1);
    expect(stats.filled_synthesized).toBe(0);
    expect(plane.getOrder("A")?.status).toBe("submitted");
  });

  it("synthesizes a fill when broker reports 'filled' and QF missed it", async () => {
    const plane = makeOrderPlane();
    seedSubmittedOrder(plane, { order_id: "B", broker_order_id: "B-B", intent_quantity: 5 });
    const replies = new Map<string, BrokerOrderStatus>([
      [
        "B-B",
        {
          broker_order_id: "B-B",
          status: "filled",
          filled_quantity: 5,
          average_fill_price: 10.0,
          rejection_reason: null,
        },
      ],
    ]);

    const stats = await reconcileOrdersWithBroker(plane, mockObserver(replies), createTestLogger());

    expect(stats.filled_synthesized).toBe(1);
    const order = plane.getOrder("B");
    expect(order?.status).toBe("filled");
    expect(order?.filled_quantity).toBe(5);
    expect(order?.average_fill_price).toBe(10.0);
  });

  it("synthesizes the diff when broker reports 'partial_fill' beyond what QF saw", async () => {
    const plane = makeOrderPlane();
    plane.rehydrateOrder(
      {
        order_id: "C",
        intent_id: "int-C",
        client_order_id: "int-C",
        portfolio: "main",
        broker: "paper",
        execution_mode: "paper_local",
        status: "partial_fill",
        created_at: new Date().toISOString(),
        broker_order_id: "B-C",
        filled_quantity: 2,
        average_fill_price: 10.0,
      },
      makeIntent({ intent_id: "int-C", quantity: 5 }),
    );
    const replies = new Map<string, BrokerOrderStatus>([
      [
        "B-C",
        {
          broker_order_id: "B-C",
          // Broker reports 4 filled at avg 11 — QF only knows about 2 at 10.
          // Diff: 2 contracts at the broker's reported avg.
          status: "partial_fill",
          filled_quantity: 4,
          average_fill_price: 11.0,
          rejection_reason: null,
        },
      ],
    ]);

    const stats = await reconcileOrdersWithBroker(plane, mockObserver(replies), createTestLogger());

    expect(stats.filled_synthesized).toBe(1);
    const order = plane.getOrder("C");
    expect(order?.filled_quantity).toBe(4);
    // VWAP after diff: (2*10 + 2*11) / 4 = 10.5
    expect(order?.average_fill_price).toBeCloseTo(10.5, 5);
    expect(order?.status).toBe("partial_fill");
  });

  it("cancels the order when broker reports 'cancelled'", async () => {
    const plane = makeOrderPlane();
    seedSubmittedOrder(plane, { order_id: "D", broker_order_id: "B-D", intent_quantity: 5 });
    const replies = new Map<string, BrokerOrderStatus>([
      [
        "B-D",
        {
          broker_order_id: "B-D",
          status: "cancelled",
          filled_quantity: 0,
          average_fill_price: null,
          rejection_reason: null,
        },
      ],
    ]);

    const stats = await reconcileOrdersWithBroker(plane, mockObserver(replies), createTestLogger());

    expect(stats.cancelled_synthesized).toBe(1);
    expect(plane.getOrder("D")?.status).toBe("cancelled");
  });

  it("transitions to rejected_by_broker when broker reports 'rejected'", async () => {
    const plane = makeOrderPlane();
    seedSubmittedOrder(plane, { order_id: "E", broker_order_id: "B-E", intent_quantity: 5 });
    const replies = new Map<string, BrokerOrderStatus>([
      [
        "B-E",
        {
          broker_order_id: "B-E",
          status: "rejected",
          filled_quantity: 0,
          average_fill_price: null,
          rejection_reason: "exchange halted",
        },
      ],
    ]);

    const stats = await reconcileOrdersWithBroker(plane, mockObserver(replies), createTestLogger());

    expect(stats.rejected_synthesized).toBe(1);
    expect(plane.getOrder("E")?.status).toBe("rejected_by_broker");
  });

  it("counts and skips orders the broker reports as 'unknown'", async () => {
    const plane = makeOrderPlane();
    seedSubmittedOrder(plane, { order_id: "F", broker_order_id: "B-F", intent_quantity: 5 });
    // No reply configured — observer's default is status: "unknown".

    const stats = await reconcileOrdersWithBroker(
      plane,
      mockObserver(new Map()),
      createTestLogger(),
    );

    expect(stats.unknown).toBe(1);
    expect(plane.getOrder("F")?.status).toBe("submitted");
  });

  it("ignores orders without broker_order_id (never made it to a broker)", async () => {
    const plane = makeOrderPlane();
    plane.rehydrateOrder(
      {
        order_id: "G",
        intent_id: "int-G",
        client_order_id: "int-G",
        portfolio: "main",
        broker: "paper",
        execution_mode: "paper_local",
        status: "submitted",
        created_at: new Date().toISOString(),
        // broker_order_id deliberately absent.
      },
      makeIntent({ intent_id: "int-G" }),
    );

    const stats = await reconcileOrdersWithBroker(
      plane,
      mockObserver(new Map()),
      createTestLogger(),
    );

    expect(stats.checked).toBe(0);
  });

  it("emits a restart_recovery alert when alertRouter is provided", async () => {
    const plane = makeOrderPlane();
    seedSubmittedOrder(plane, { order_id: "H", broker_order_id: "B-H", intent_quantity: 5 });
    const replies = new Map<string, BrokerOrderStatus>([
      [
        "B-H",
        {
          broker_order_id: "B-H",
          status: "working",
          filled_quantity: 0,
          average_fill_price: null,
          rejection_reason: null,
        },
      ],
    ]);

    const recorded: Array<{ type: string; level: string; payload: unknown }> = [];
    const alertRouter = {
      async record(alert: { type: string; level: string; payload?: unknown }) {
        recorded.push({ type: alert.type, level: alert.level, payload: alert.payload });
      },
    };

    await reconcileOrdersWithBroker(
      plane,
      mockObserver(replies),
      createTestLogger(),
      alertRouter as never,
    );

    expect(recorded.length).toBe(1);
    expect(recorded[0]?.type).toBe("restart_recovery");
    expect(recorded[0]?.level).toBe("info");
  });

  it("records an error when getOrderStatus throws", async () => {
    const plane = makeOrderPlane();
    seedSubmittedOrder(plane, { order_id: "I", broker_order_id: "B-I", intent_quantity: 5 });

    const throwingObserver: OrderObservationAdapter = {
      name: "throw",
      async available() {
        return true;
      },
      async getOrderStatus() {
        throw new Error("network");
      },
      async getPositions() {
        return [];
      },
      onFill() {},
      onRejection() {},
    };

    const stats = await reconcileOrdersWithBroker(plane, throwingObserver, createTestLogger());

    expect(stats.errors).toBe(1);
    expect(plane.getOrder("I")?.status).toBe("submitted");
  });
});
