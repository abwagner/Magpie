// QF-319 — Audit observer consumer:
//  - subscribes to orders.exec_reports.<broker>
//  - dedups against existing audit_orders rows (OPL/qf chain wins)
//  - writes nt-native rows for orders without a qf parent row
//  - skips when intent_id is null (pure-NT order, no QF intent FK)
//  - threads correlation_id from NATS headers
//
// Uses an in-memory NATS fake mirroring the one in nt-bridge.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { StringCodec } from "nats";
import { createNtObserverConsumer } from "../../nt-observer-consumer.js";
import { createTestLogger } from "../../../../__tests__/helpers/test-logger.js";
import type { AuditOrderRow } from "../../../audit-orders.js";
import type { AuditFillRow } from "../../../audit-fills.js";
import type { BrokerExecReport } from "../../../../../src/types/order.js";

// ── Fake NATS (subscribe + headers) ──────────────────────────────────

const sc = StringCodec();

interface FakeHeaders {
  get(key: string): string | undefined;
}

interface FakeMsg {
  data: Uint8Array;
  headers?: FakeHeaders;
}

interface FakeSub {
  pump(msg: FakeMsg): void;
  close(): void;
}

interface FakeNats {
  isClosed(): boolean;
  subscribe(subject: string): {
    [Symbol.asyncIterator](): AsyncIterator<FakeMsg>;
  };
  pumpExecReport(
    subject: string,
    report: BrokerExecReport,
    headersMap?: Record<string, string>,
  ): Promise<void>;
}

function makeFakeNats(): FakeNats {
  const subscribers = new Map<string, FakeSub>();

  function subscribe(subject: string) {
    const queue: FakeMsg[] = [];
    let resolveNext: ((v: IteratorResult<FakeMsg>) => void) | null = null;
    let closed = false;
    const sub: FakeSub = {
      pump(msg) {
        if (closed) return;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: msg, done: false });
        } else {
          queue.push(msg);
        }
      },
      close() {
        closed = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: undefined as never, done: true });
        }
      },
    };
    subscribers.set(subject, sub);
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<FakeMsg>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((r) => {
              resolveNext = r;
            });
          },
        };
      },
    };
  }

  return {
    isClosed: () => false,
    subscribe,
    async pumpExecReport(subject, report, headersMap) {
      const sub = subscribers.get(subject);
      if (!sub) throw new Error(`no subscriber for ${subject}`);
      const msg: FakeMsg = {
        data: sc.encode(JSON.stringify(report)),
      };
      if (headersMap) {
        msg.headers = {
          get(key: string) {
            return headersMap[key];
          },
        };
      }
      sub.pump(msg);
      // Yield the event loop so the for-await loop processes the msg.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────

function makeReport(overrides: Partial<BrokerExecReport> = {}): BrokerExecReport {
  return {
    broker: "schwab",
    broker_order_id: "BRK-1",
    event: "fill",
    ts: "2026-05-29T15:00:00Z",
    fill: { fill_id: "F-1", price: 100, quantity: 1, fees: 0 },
    intent_id: "INT-1",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("nt-observer-consumer (QF-319)", () => {
  let fakeNats: FakeNats;
  let writtenOrders: AuditOrderRow[];
  let writtenFills: AuditFillRow[];
  let qfRowsByBrokerOrderId: Map<string, string>;

  beforeEach(() => {
    fakeNats = makeFakeNats();
    writtenOrders = [];
    writtenFills = [];
    qfRowsByBrokerOrderId = new Map();
    createNtObserverConsumer({
      nc: fakeNats as never,
      config: { broker: "schwab" },
      logger: createTestLogger(),
      lookupQfOrderId: async (brokerOrderId) => qfRowsByBrokerOrderId.get(brokerOrderId) ?? null,
      auditOrderWriter: async (row) => {
        writtenOrders.push(row);
      },
      auditFillWriter: async (row) => {
        writtenFills.push(row);
      },
    });
  });

  it("dedup-skips when audit_orders already has a qf-source row for this broker_order_id", async () => {
    qfRowsByBrokerOrderId.set("BRK-OPL", "ORD-QF-1");
    await fakeNats.pumpExecReport(
      "orders.exec_reports.schwab",
      makeReport({ broker_order_id: "BRK-OPL", intent_id: "INT-OPL" }),
    );
    expect(writtenOrders).toEqual([]);
    expect(writtenFills).toEqual([]);
  });

  it("writes nt-native audit_orders + audit_fills when no qf row exists and intent_id is set", async () => {
    await fakeNats.pumpExecReport(
      "orders.exec_reports.schwab",
      makeReport({
        broker_order_id: "BRK-NT-1",
        intent_id: "INT-CHILD-1",
        fill: { fill_id: "F-CHILD-1", price: 42.5, quantity: 3, fees: 0.05 },
      }),
    );
    expect(writtenOrders).toHaveLength(1);
    expect(writtenOrders[0]).toMatchObject({
      order_id: "BRK-NT-1",
      intent_id: "INT-CHILD-1",
      broker: "schwab",
      status: "filled",
      broker_order_id: "BRK-NT-1",
      source: "nt-native",
    });
    expect(writtenFills).toHaveLength(1);
    expect(writtenFills[0]).toMatchObject({
      fill_id: "F-CHILD-1",
      order_id: "BRK-NT-1",
      price: 42.5,
      quantity: 3,
      fees: 0.05,
      source: "nt-native",
    });
  });

  it("skips entirely when intent_id is null (pure-NT order, no QF parent)", async () => {
    await fakeNats.pumpExecReport(
      "orders.exec_reports.schwab",
      makeReport({ broker_order_id: "BRK-NT-PURE", intent_id: null }),
    );
    expect(writtenOrders).toEqual([]);
    expect(writtenFills).toEqual([]);
  });

  it("writes partial_filled status without crashing on multiple partials", async () => {
    await fakeNats.pumpExecReport(
      "orders.exec_reports.schwab",
      makeReport({
        broker_order_id: "BRK-PARTIAL",
        event: "partial_fill",
        intent_id: "INT-P",
        fill: { fill_id: "F-1", price: 50, quantity: 1, fees: 0 },
      }),
    );
    expect(writtenOrders[0]?.status).toBe("partial_filled");
    expect(writtenFills).toHaveLength(1);
  });

  it("writes audit_orders only (no fill row) on broker-side rejection", async () => {
    await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
      broker: "schwab",
      broker_order_id: "BRK-REJ",
      event: "rejected",
      ts: "2026-05-29T15:00:00Z",
      intent_id: "INT-REJ",
      rejection_reason: "INSUFFICIENT_BUYING_POWER",
    });
    expect(writtenOrders).toHaveLength(1);
    expect(writtenOrders[0]).toMatchObject({
      order_id: "BRK-REJ",
      status: "rejected_by_broker",
      broker_rejection_reason: "INSUFFICIENT_BUYING_POWER",
      source: "nt-native",
    });
    expect(writtenFills).toEqual([]);
  });

  it("ignores submitted / cancelled events (informational only, no audit row)", async () => {
    await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
      broker: "schwab",
      broker_order_id: "BRK-SUB",
      event: "submitted",
      ts: "2026-05-29T15:00:00Z",
      intent_id: "INT-SUB",
    });
    await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
      broker: "schwab",
      broker_order_id: "BRK-CAN",
      event: "cancelled",
      ts: "2026-05-29T15:00:00Z",
      intent_id: "INT-CAN",
    });
    expect(writtenOrders).toEqual([]);
    expect(writtenFills).toEqual([]);
  });

  it("propagates correlation_id from NATS X-Correlation-Id header onto both rows", async () => {
    await fakeNats.pumpExecReport(
      "orders.exec_reports.schwab",
      makeReport({ broker_order_id: "BRK-CORR", intent_id: "INT-CORR" }),
      { "X-Correlation-Id": "corr-from-headers" },
    );
    expect(writtenOrders[0]?.correlation_id).toBe("corr-from-headers");
    expect(writtenFills[0]?.correlation_id).toBe("corr-from-headers");
  });

  it("falls back to payload correlation_id when NATS header is absent", async () => {
    await fakeNats.pumpExecReport(
      "orders.exec_reports.schwab",
      makeReport({
        broker_order_id: "BRK-CORR2",
        intent_id: "INT-CORR2",
        correlation_id: "corr-from-body",
      }),
    );
    expect(writtenOrders[0]?.correlation_id).toBe("corr-from-body");
    expect(writtenFills[0]?.correlation_id).toBe("corr-from-body");
  });
});
