// QF-235 — IBKR observation adapter: subscribes to orders.exec_reports.ibkr
// (NOT orders.exec_reports.schwab), exposes the OrderObservationAdapter
// shape only (no submit/cancel). End-to-end dispatch logic is covered by
// nt-bridge.test.ts; this file verifies the IBKR-specific narrowing.

import { describe, it, expect } from "vitest";
import { StringCodec } from "nats";
import { createIbkrObserverAdapter } from "../../ibkr-observer.js";
import { createTestLogger } from "../../../../__tests__/helpers/test-logger.js";
import type { BrokerExecReport, Fill } from "../../../../../src/types/order.js";

// ── In-memory NATS fake — minimal subscribe + request ────────────────

const sc = StringCodec();

interface FakeSub {
  pump(data: Uint8Array): void;
}

interface FakeNats {
  isClosed(): boolean;
  subscribe(subject: string): {
    [Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }>;
  };
  request(
    subject: string,
    payload: Uint8Array,
    opts: { timeout: number },
  ): Promise<{ data: Uint8Array }>;
  setReplier(subject: string, replier: (req: unknown) => unknown): void;
  pumpExecReport(subject: string, report: BrokerExecReport): Promise<void>;
  subscribedSubjects(): string[];
}

function makeFakeNats(): FakeNats {
  const subscribers = new Map<string, FakeSub>();
  const repliers = new Map<string, (req: unknown) => unknown>();

  function subscribe(subject: string) {
    const queue: Array<{ data: Uint8Array }> = [];
    let resolveNext: ((v: IteratorResult<{ data: Uint8Array }>) => void) | null = null;
    const sub: FakeSub = {
      pump(data) {
        const value = { data };
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value, done: false });
        } else {
          queue.push(value);
        }
      },
    };
    subscribers.set(subject, sub);
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<{ data: Uint8Array }>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            return new Promise((r) => {
              resolveNext = r;
            });
          },
        };
      },
    };
  }

  async function request(
    subject: string,
    payload: Uint8Array,
    _opts: { timeout: number },
  ): Promise<{ data: Uint8Array }> {
    const replier = repliers.get(subject);
    if (!replier) throw new Error(`no replier for ${subject}`);
    const reply = replier(JSON.parse(sc.decode(payload)));
    return { data: sc.encode(JSON.stringify(reply)) };
  }

  return {
    isClosed: () => false,
    subscribe,
    request,
    setReplier: (subject, fn) => {
      repliers.set(subject, fn);
    },
    async pumpExecReport(subject, report) {
      const sub = subscribers.get(subject);
      if (!sub) throw new Error(`no subscriber for ${subject}`);
      sub.pump(sc.encode(JSON.stringify(report)));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    subscribedSubjects: () => Array.from(subscribers.keys()),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ibkr-observer adapter (QF-235)", () => {
  it("subscribes to orders.exec_reports.ibkr (and not orders.exec_reports.schwab)", () => {
    const fakeNats = makeFakeNats();
    createIbkrObserverAdapter(fakeNats as never, {}, createTestLogger());
    expect(fakeNats.subscribedSubjects()).toContain("orders.exec_reports.ibkr");
    expect(fakeNats.subscribedSubjects()).not.toContain("orders.exec_reports.schwab");
  });

  it("fans IBKR fills through onFill with broker='ibkr'", async () => {
    const fakeNats = makeFakeNats();
    const adapter = createIbkrObserverAdapter(fakeNats as never, {}, createTestLogger());
    const received: Fill[] = [];
    adapter.onFill((f) => received.push(f));
    await fakeNats.pumpExecReport("orders.exec_reports.ibkr", {
      broker: "ibkr",
      broker_order_id: "IBKR-42",
      event: "fill",
      ts: "2026-05-19T20:45:00.000Z",
      fill: { fill_id: "F-IBKR-1", price: 100.5, quantity: 10, fees: 0.65 },
    });
    expect(received.length).toBe(1);
    expect(received[0]?.broker).toBe("ibkr");
    expect(received[0]?.broker_order_id).toBe("IBKR-42");
  });

  it("routes getOrderStatus to orders.status.ibkr", async () => {
    const fakeNats = makeFakeNats();
    let observed: unknown = null;
    fakeNats.setReplier("orders.status.ibkr", (req) => {
      observed = req;
      return {
        broker_order_id: (req as { broker_order_id: string }).broker_order_id,
        status: "filled",
        filled_quantity: 5,
        average_fill_price: 101.0,
        rejection_reason: null,
      };
    });
    const adapter = createIbkrObserverAdapter(fakeNats as never, {}, createTestLogger());
    const status = await adapter.getOrderStatus("IBKR-77");
    expect(observed).toMatchObject({ broker_order_id: "IBKR-77" });
    expect(status.status).toBe("filled");
    expect(status.filled_quantity).toBe(5);
  });

  it("routes getPositions to orders.positions.ibkr", async () => {
    const fakeNats = makeFakeNats();
    fakeNats.setReplier("orders.positions.ibkr", () => [
      { symbol: "AAPL", direction: "long", quantity: 100 },
    ]);
    const adapter = createIbkrObserverAdapter(fakeNats as never, {}, createTestLogger());
    const positions = await adapter.getPositions();
    expect(positions).toEqual([{ symbol: "AAPL", direction: "long", quantity: 100 }]);
  });

  it("returns an OrderObservationAdapter that does not expose submit/cancel", () => {
    const fakeNats = makeFakeNats();
    const adapter = createIbkrObserverAdapter(fakeNats as never, {}, createTestLogger());
    // The narrowing is a type-system property; at runtime the adapter
    // returned is plain object literal that doesn't have submitOrder.
    // (NT-bridge under the hood does — but we don't re-export it.)
    expect("submitOrder" in adapter).toBe(false);
    expect("cancelOrder" in adapter).toBe(false);
    expect("getOrderStatus" in adapter).toBe(true);
    expect("getPositions" in adapter).toBe(true);
    expect("onFill" in adapter).toBe(true);
    expect("onRejection" in adapter).toBe(true);
  });
});
