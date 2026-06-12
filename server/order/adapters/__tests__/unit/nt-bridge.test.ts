// QF-233 — NT-bridge broker adapter: submit/cancel/status request-reply,
// exec_reports subscription fans out to onFill / onRejection. Uses an
// in-memory NATS fake (no Docker, no real broker). The Python service
// side that satisfies these subjects is intentionally out of scope —
// see the spawned follow-up Plane ticket from QF-233 implementation.

import { describe, it, expect, beforeEach } from "vitest";
import { StringCodec } from "nats";
import { createNtBridgeAdapter } from "../../nt-bridge.js";
import { createTestLogger } from "../../../../__tests__/helpers/test-logger.js";
import type {
  BrokerAdapter,
  BrokerExecReport,
  BrokerRejection,
  Fill,
} from "../../../../../src/types/order.js";

// ── In-memory NATS fake (request/reply + subscribe) ──────────────────

const sc = StringCodec();

interface FakeSub {
  pump(data: Uint8Array): void;
  close(): void;
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
  // Test helpers
  setReplier(subject: string, replier: (req: unknown) => unknown | Promise<unknown>): void;
  setReplyTimeout(subject: string): void;
  pumpExecReport(subject: string, report: BrokerExecReport): Promise<void>;
  pumpRaw(subject: string, raw: string): Promise<void>;
}

function makeFakeNats(): FakeNats {
  const subscribers = new Map<string, FakeSub>();
  const repliers = new Map<string, (req: unknown) => unknown | Promise<unknown>>();
  const timeoutSubjects = new Set<string>();

  function subscribe(subject: string) {
    const queue: Array<{ data: Uint8Array }> = [];
    let resolveNext: ((v: IteratorResult<{ data: Uint8Array }>) => void) | null = null;
    let closed = false;
    const sub: FakeSub = {
      pump(data) {
        if (closed) return;
        const value = { data };
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value, done: false });
        } else {
          queue.push(value);
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
          next(): Promise<IteratorResult<{ data: Uint8Array }>> {
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

  async function request(
    subject: string,
    payload: Uint8Array,
    opts: { timeout: number },
  ): Promise<{ data: Uint8Array }> {
    if (timeoutSubjects.has(subject)) {
      await new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`request timeout: ${subject}`)), opts.timeout),
      );
      throw new Error("unreachable");
    }
    const replier = repliers.get(subject);
    if (!replier) throw new Error(`no replier for ${subject}`);
    const reqPayload = JSON.parse(sc.decode(payload));
    const reply = await replier(reqPayload);
    return { data: sc.encode(JSON.stringify(reply)) };
  }

  return {
    isClosed: () => false,
    subscribe,
    request,
    setReplier(subject, fn) {
      repliers.set(subject, fn);
    },
    setReplyTimeout(subject) {
      timeoutSubjects.add(subject);
    },
    async pumpExecReport(subject, report) {
      const sub = subscribers.get(subject);
      if (!sub) throw new Error(`no subscriber for ${subject}`);
      sub.pump(sc.encode(JSON.stringify(report)));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    async pumpRaw(subject, raw) {
      const sub = subscribers.get(subject);
      if (!sub) throw new Error(`no subscriber for ${subject}`);
      sub.pump(sc.encode(raw));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("nt-bridge adapter (QF-233)", () => {
  let fakeNats: FakeNats;
  let adapter: BrokerAdapter;

  beforeEach(() => {
    fakeNats = makeFakeNats();
    adapter = createNtBridgeAdapter(
      // The createNtBridgeAdapter signature wants a NatsConnection; FakeNats
      // implements the methods we touch (subscribe / request / isClosed).
      fakeNats as never,
      { broker: "schwab", submitTimeoutMs: 100, queryTimeoutMs: 100 },
      createTestLogger(),
    );
  });

  describe("submitOrder", () => {
    it("publishes the params, parses the reply, returns broker_order_id", async () => {
      let observedPayload: unknown = null;
      fakeNats.setReplier("orders.submit.schwab", (req) => {
        observedPayload = req;
        return { broker_order_id: "BRK-12345", accepted: true };
      });
      const id = await adapter.submitOrder({
        client_order_id: "01HXAMPLEINTENTID000000000",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Long",
        quantity: 1,
        orderType: "market",
      });
      expect(id).toBe("BRK-12345");
      expect(observedPayload).toMatchObject({
        // QF-310: broker-side idempotency token must appear on the
        // NATS payload so the Python bridge can forward it to the
        // broker's native client_order_id field.
        client_order_id: "01HXAMPLEINTENTID000000000",
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Long",
        quantity: 1,
        orderType: "market",
      });
    });

    it("throws when the bridge replies with an error", async () => {
      fakeNats.setReplier("orders.submit.schwab", () => ({
        error: "broker not authenticated",
      }));
      await expect(
        adapter.submitOrder({
          client_order_id: "I1",
          symbol: "X",
          direction: "Long",
          quantity: 1,
          orderType: "market",
        }),
      ).rejects.toThrow(/broker not authenticated/);
    });

    it("throws when the bridge reply has neither broker_order_id nor error", async () => {
      fakeNats.setReplier("orders.submit.schwab", () => ({}));
      await expect(
        adapter.submitOrder({
          client_order_id: "I2",
          symbol: "X",
          direction: "Long",
          quantity: 1,
          orderType: "market",
        }),
      ).rejects.toThrow(/no broker_order_id/);
    });

    it("throws on request timeout", async () => {
      fakeNats.setReplyTimeout("orders.submit.schwab");
      await expect(
        adapter.submitOrder({
          client_order_id: "I3",
          symbol: "X",
          direction: "Long",
          quantity: 1,
          orderType: "market",
        }),
      ).rejects.toThrow(/timeout/);
    });
  });

  describe("cancelOrder", () => {
    it("publishes broker_order_id and returns on accepted reply", async () => {
      let observed: unknown = null;
      fakeNats.setReplier("orders.cancel.schwab", (req) => {
        observed = req;
        return { accepted: true };
      });
      await adapter.cancelOrder("BRK-12345");
      expect(observed).toMatchObject({ broker_order_id: "BRK-12345" });
    });

    it("throws on error reply", async () => {
      fakeNats.setReplier("orders.cancel.schwab", () => ({ error: "already filled" }));
      await expect(adapter.cancelOrder("BRK-12345")).rejects.toThrow(/already filled/);
    });
  });

  describe("getOrderStatus", () => {
    it("returns the BrokerOrderStatus reply verbatim", async () => {
      fakeNats.setReplier("orders.status.schwab", (req) => ({
        broker_order_id: (req as { broker_order_id: string }).broker_order_id,
        status: "filled",
        filled_quantity: 1,
        average_fill_price: 5.0,
        rejection_reason: null,
      }));
      const status = await adapter.getOrderStatus("BRK-9");
      expect(status).toEqual({
        broker_order_id: "BRK-9",
        status: "filled",
        filled_quantity: 1,
        average_fill_price: 5.0,
        rejection_reason: null,
      });
    });
  });

  describe("getPositions", () => {
    it("returns BrokerPosition[] from the reply", async () => {
      fakeNats.setReplier("orders.positions.schwab", () => [
        { symbol: "SPY", direction: "long", quantity: 100 },
      ]);
      const positions = await adapter.getPositions();
      expect(positions).toEqual([{ symbol: "SPY", direction: "long", quantity: 100 }]);
    });

    it("carries the raw Schwab row through (QF-272)", async () => {
      fakeNats.setReplier("orders.positions.schwab", () => [
        {
          symbol: "AAPL",
          direction: "Long",
          quantity: 5,
          raw: { instrument: { assetType: "EQUITY", symbol: "AAPL" }, marketValue: 500 },
        },
      ]);
      const positions = await adapter.getPositions();
      expect(positions[0]!.raw).toEqual({
        instrument: { assetType: "EQUITY", symbol: "AAPL" },
        marketValue: 500,
      });
    });

    it("throws when the bridge replies with an error object", async () => {
      fakeNats.setReplier("orders.positions.schwab", () => ({
        error: "list_positions failed",
      }));
      await expect(adapter.getPositions()).rejects.toThrow(/list_positions failed/);
    });
  });

  describe("getAccounts (QF-272)", () => {
    it("returns BrokerAccount[] from the reply", async () => {
      fakeNats.setReplier("orders.accounts.schwab", () => [
        { accountNumber: "123", hashValue: "HASH", type: "MARGIN" },
      ]);
      const accounts = await adapter.getAccounts!();
      expect(accounts).toEqual([{ accountNumber: "123", hashValue: "HASH", type: "MARGIN" }]);
    });

    it("throws when the bridge replies with an error object", async () => {
      fakeNats.setReplier("orders.accounts.schwab", () => ({
        error: "list_accounts failed",
      }));
      await expect(adapter.getAccounts!()).rejects.toThrow(/list_accounts failed/);
    });
  });

  describe("exec_reports subscription", () => {
    it("fans 'fill' reports to onFill callbacks with the wire payload mapped to Fill", async () => {
      const received: Fill[] = [];
      adapter.onFill((f) => received.push(f));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-77",
        event: "fill",
        ts: "2026-05-19T20:30:00.000Z",
        fill: {
          fill_id: "F-1",
          price: 5.25,
          quantity: 1,
          fees: 0.65,
        },
      });
      expect(received.length).toBe(1);
      expect(received[0]).toMatchObject({
        fill_id: "F-1",
        broker_order_id: "BRK-77",
        broker: "schwab",
        price: 5.25,
        quantity: 1,
        fees: 0.65,
        filled_at: "2026-05-19T20:30:00.000Z",
      });
    });

    it("fans 'rejected' reports to onRejection callbacks", async () => {
      const received: BrokerRejection[] = [];
      adapter.onRejection?.((r) => received.push(r));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-99",
        event: "rejected",
        ts: "2026-05-19T20:31:00.000Z",
        rejection_reason: "price band breach",
        broker_reason_code: "PRICE_BAND",
      });
      expect(received.length).toBe(1);
      expect(received[0]).toMatchObject({
        broker_order_id: "BRK-99",
        reason: "price band breach",
        broker_reason_code: "PRICE_BAND",
        rejected_at: "2026-05-19T20:31:00.000Z",
      });
    });

    it("stamps the adapter's account_id on fanned-out rejections (QF-246)", async () => {
      const received: BrokerRejection[] = [];
      adapter.onRejection?.((r) => received.push(r));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-99",
        event: "rejected",
        ts: "2026-05-19T20:31:00.000Z",
        rejection_reason: "price band breach",
      });
      // Default-account adapter → account_id "default".
      expect(received[0]?.account_id).toBe("default");
    });

    it("prefers the exec report's account_id over the adapter's on rejections (QF-246)", async () => {
      const received: BrokerRejection[] = [];
      adapter.onRejection?.((r) => received.push(r));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-99",
        event: "rejected",
        ts: "2026-05-19T20:31:00.000Z",
        rejection_reason: "price band breach",
        account_id: "ACCT123",
      });
      expect(received[0]?.account_id).toBe("ACCT123");
    });

    it("drops 'cancelled' and 'submitted' reports (informational only — OrderPlane drives those locally)", async () => {
      const fills: Fill[] = [];
      const rejections: BrokerRejection[] = [];
      adapter.onFill((f) => fills.push(f));
      adapter.onRejection?.((r) => rejections.push(r));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-7",
        event: "cancelled",
        ts: "2026-05-19T20:32:00.000Z",
      });
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-8",
        event: "submitted",
        ts: "2026-05-19T20:33:00.000Z",
      });
      expect(fills.length).toBe(0);
      expect(rejections.length).toBe(0);
    });

    it("survives malformed JSON on the subject without crashing the loop", async () => {
      const fills: Fill[] = [];
      adapter.onFill((f) => fills.push(f));
      await fakeNats.pumpRaw("orders.exec_reports.schwab", "not json");
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-after-malformed",
        event: "fill",
        ts: "2026-05-19T20:34:00.000Z",
        fill: { fill_id: "F-2", price: 1, quantity: 1, fees: 0 },
      });
      expect(fills.length).toBe(1);
      expect(fills[0]?.broker_order_id).toBe("BRK-after-malformed");
    });

    it("stamps the adapter's account_id on fanned-out fills (QF-246)", async () => {
      const received: Fill[] = [];
      adapter.onFill((f) => received.push(f));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab", {
        broker: "schwab",
        broker_order_id: "BRK-1",
        event: "fill",
        ts: "2026-05-19T20:30:00.000Z",
        fill: { fill_id: "F-3", price: 1, quantity: 1, fees: 0 },
      });
      // Default-account adapter → account_id "default".
      expect(received[0]?.account_id).toBe("default");
    });
  });

  // ── QF-246 — per-account subject namespacing ───────────────────────
  describe("per-account subject namespacing (QF-246)", () => {
    it("targets suffixed subjects when accountId is set", async () => {
      const acct = createNtBridgeAdapter(
        fakeNats as never,
        { broker: "schwab", accountId: "ACCT123", submitTimeoutMs: 100, queryTimeoutMs: 100 },
        createTestLogger(),
      );
      let observed: unknown = null;
      fakeNats.setReplier("orders.submit.schwab.ACCT123", (req) => {
        observed = req;
        return { broker_order_id: "BRK-A", accepted: true };
      });
      const id = await acct.submitOrder({
        client_order_id: "I1",
        symbol: "X",
        direction: "Long",
        quantity: 1,
        orderType: "market",
      });
      expect(id).toBe("BRK-A");
      expect(observed).not.toBeNull();
    });

    it("keeps bare subjects for the default account (backward-compat)", async () => {
      const def = createNtBridgeAdapter(
        fakeNats as never,
        { broker: "schwab", accountId: "default", submitTimeoutMs: 100, queryTimeoutMs: 100 },
        createTestLogger(),
      );
      fakeNats.setReplier("orders.submit.schwab", () => ({
        broker_order_id: "BRK-D",
        accepted: true,
      }));
      const id = await def.submitOrder({
        client_order_id: "I2",
        symbol: "X",
        direction: "Long",
        quantity: 1,
        orderType: "market",
      });
      expect(id).toBe("BRK-D");
    });

    it("stamps the account_id on fills from the suffixed exec_reports subject", async () => {
      const acct = createNtBridgeAdapter(
        fakeNats as never,
        { broker: "schwab", accountId: "ACCT123" },
        createTestLogger(),
      );
      const received: Fill[] = [];
      acct.onFill((f) => received.push(f));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab.ACCT123", {
        broker: "schwab",
        broker_order_id: "BRK-2",
        event: "fill",
        ts: "2026-05-19T20:30:00.000Z",
        fill: { fill_id: "F-4", price: 1, quantity: 1, fees: 0 },
      });
      expect(received[0]?.account_id).toBe("ACCT123");
    });

    it("prefers the report's own account_id over the adapter's config", async () => {
      const acct = createNtBridgeAdapter(
        fakeNats as never,
        { broker: "schwab", accountId: "ACCT123" },
        createTestLogger(),
      );
      const received: Fill[] = [];
      acct.onFill((f) => received.push(f));
      await fakeNats.pumpExecReport("orders.exec_reports.schwab.ACCT123", {
        broker: "schwab",
        broker_order_id: "BRK-3",
        event: "fill",
        ts: "2026-05-19T20:30:00.000Z",
        account_id: "OTHER",
        fill: { fill_id: "F-5", price: 1, quantity: 1, fees: 0 },
      });
      expect(received[0]?.account_id).toBe("OTHER");
    });
  });
});
