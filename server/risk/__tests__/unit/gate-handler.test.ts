// QF-315 — gate-handler RPC unit tests.
//
// Covers:
//   - parse + reject malformed payload
//   - approve path returns intent_id + envelope_id
//   - reject path returns reason + null envelope_id
//   - audit_intents row is written with source='qf-gated' + gate fields
//   - evaluator throw maps to config_invalid reject (no fail-open)
//   - correlation_id from NATS header threads onto the audit row

import { describe, it, expect, beforeEach } from "vitest";
import { StringCodec } from "nats";
import {
  createGateHandler,
  type GateEvaluator,
  type GateRequest,
  type GateResponse,
} from "../../gate-handler.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type { AuditIntentRow } from "../../../order/audit-intent.js";

// ── Fake NATS (subscribe + msg.respond) ───────────────────────────────

const sc = StringCodec();

interface FakeHeaders {
  get(key: string): string | undefined;
}

interface FakeMsg {
  data: Uint8Array;
  reply?: string;
  headers?: FakeHeaders;
  respond(payload: Uint8Array): void;
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
  pumpRequest(
    subject: string,
    payload: unknown,
    opts?: { headers?: Record<string, string>; malformed?: string },
  ): Promise<Uint8Array | null>;
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
    async pumpRequest(subject, payload, opts) {
      const sub = subscribers.get(subject);
      if (!sub) throw new Error(`no subscriber for ${subject}`);
      let captured: Uint8Array | null = null;
      const headersMap = opts?.headers;
      const msg: FakeMsg = {
        data: opts?.malformed ? sc.encode(opts.malformed) : sc.encode(JSON.stringify(payload)),
        reply: "INBOX-test",
        respond(p: Uint8Array) {
          captured = p;
        },
      };
      if (headersMap) {
        msg.headers = {
          get(key: string) {
            return headersMap[key];
          },
        };
      }
      sub.pump(msg);
      // Let the for-await loop process + reply + queue the audit write.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return captured;
    },
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────

function makeRequest(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    intent: {
      intent_id: "WILL_BE_REPLACED",
      portfolio: "main",
      strategy_id: "s-1",
      action: "open",
      symbol: "SPY",
      direction: "Long",
      quantity: 1,
      reason: "strategy_signal",
      signal_ids: ["sig-1"],
      created_at: "2026-05-29T15:00:00Z",
    },
    strategy_id: "s-1",
    portfolio_id: "main",
    current_position: null,
    account_balance: 100000,
    asof: "2026-05-29T15:00:00Z",
    ...overrides,
  };
}

function parseReply(reply: Uint8Array | null): GateResponse {
  if (!reply) throw new Error("no reply captured");
  return JSON.parse(sc.decode(reply)) as GateResponse;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("gate-handler (QF-315)", () => {
  let fakeNats: FakeNats;
  let writtenIntents: AuditIntentRow[];
  let idCounter: number;
  let evaluator: GateEvaluator;

  beforeEach(() => {
    fakeNats = makeFakeNats();
    writtenIntents = [];
    idCounter = 0;
    evaluator = {
      evaluate: () => ({ decision: "approve", reason: null }),
    };
  });

  function wire(eval_: GateEvaluator = evaluator) {
    createGateHandler({
      nc: fakeNats as never,
      config: { broker: "schwab" },
      logger: createTestLogger(),
      evaluator: eval_,
      auditIntentWriter: async (row) => {
        writtenIntents.push(row);
      },
      generateIntentId: () => `INT-${++idCounter}`,
      now: () => "2026-05-29T15:00:00Z",
    });
  }

  it("approve path: reply has decision/intent_id/envelope_id all set", async () => {
    wire();
    const reply = await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    const parsed = parseReply(reply);
    expect(parsed.decision).toBe("approve");
    expect(parsed.reason).toBeNull();
    expect(parsed.intent_id).toBe("INT-1");
    expect(parsed.envelope_id).toBe("INT-1");
  });

  it("reject path: reply has reason, intent_id, null envelope_id", async () => {
    wire({
      evaluate: () => ({ decision: "reject", reason: "limit_exceeded_per_strategy" }),
    });
    const reply = await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    const parsed = parseReply(reply);
    expect(parsed.decision).toBe("reject");
    expect(parsed.reason).toBe("limit_exceeded_per_strategy");
    expect(parsed.intent_id).toBe("INT-1");
    expect(parsed.envelope_id).toBeNull();
  });

  it("writes audit_intents row with source='qf-gated' + gate_decision + envelope_id on approve", async () => {
    wire();
    await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    // Yield once more so the fire-and-forget audit write completes.
    await new Promise((r) => setImmediate(r));
    expect(writtenIntents).toHaveLength(1);
    expect(writtenIntents[0]).toMatchObject({
      intent_id: "INT-1",
      portfolio: "main",
      symbol: "SPY",
      direction: "Long",
      quantity: 1,
      strategy_id: "s-1",
      source: "qf-gated",
      gate_decision: "approve",
      gate_reason: null,
      envelope_id: "INT-1",
    });
  });

  it("writes audit_intents row with gate_decision='reject' + null envelope_id on reject", async () => {
    wire({
      evaluate: () => ({ decision: "reject", reason: "concentration" }),
    });
    await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    await new Promise((r) => setImmediate(r));
    expect(writtenIntents[0]).toMatchObject({
      source: "qf-gated",
      gate_decision: "reject",
      gate_reason: "concentration",
      envelope_id: null,
    });
  });

  it("evaluator throw maps to config_invalid reject (no fail-open)", async () => {
    wire({
      evaluate: () => {
        throw new Error("boom");
      },
    });
    const reply = await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    const parsed = parseReply(reply);
    expect(parsed.decision).toBe("reject");
    expect(parsed.reason).toBe("config_invalid");
  });

  it("malformed payload replies reject(config_invalid) with empty intent_id", async () => {
    wire();
    const reply = await fakeNats.pumpRequest("orders.gate.schwab", null, {
      malformed: "not json",
    });
    const parsed = parseReply(reply);
    expect(parsed.decision).toBe("reject");
    expect(parsed.reason).toBe("config_invalid");
    expect(parsed.intent_id).toBe("");
    expect(parsed.envelope_id).toBeNull();
  });

  it("threads correlation_id from NATS X-Correlation-Id header onto audit row", async () => {
    wire();
    await fakeNats.pumpRequest("orders.gate.schwab", makeRequest(), {
      headers: { "X-Correlation-Id": "corr-1" },
    });
    await new Promise((r) => setImmediate(r));
    expect(writtenIntents[0]?.correlation_id).toBe("corr-1");
  });

  // ── QF-316: warm-up gate + pending-intents enrollment ─────────────

  it("warm-up gate: rejects with gate_unavailable_open_blocked until markReady", async () => {
    const { createWarmUpGate } = await import("../../rehydration.js");
    const { createPendingIntentsStore } = await import("../../pending-intents.js");
    const warmUp = createWarmUpGate();
    const pending = createPendingIntentsStore();
    createGateHandler({
      nc: fakeNats as never,
      config: { broker: "schwab" },
      logger: createTestLogger(),
      evaluator,
      auditIntentWriter: async (row) => {
        writtenIntents.push(row);
      },
      generateIntentId: () => `INT-${++idCounter}`,
      warmUpGate: warmUp,
      pendingIntents: pending,
      now: () => "2026-05-29T15:00:00Z",
    });
    const beforeReady = await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    const parsedBefore = parseReply(beforeReady);
    expect(parsedBefore.decision).toBe("reject");
    expect(parsedBefore.reason).toBe("gate_unavailable_open_blocked");
    expect(parsedBefore.intent_id).toBe("");
    // Audit + enrollment skipped during warm-up.
    expect(writtenIntents).toEqual([]);
    expect(pending.size()).toBe(0);

    warmUp.markReady();
    const afterReady = await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    const parsedAfter = parseReply(afterReady);
    expect(parsedAfter.decision).toBe("approve");
    expect(parsedAfter.envelope_id).toBe("INT-1");
    await new Promise((r) => setImmediate(r));
    expect(pending.size()).toBe(1);
    expect(pending.get("INT-1")?.status).toBe("pending");
  });

  it("approve path enrolls parent intent into pending-intents store", async () => {
    const { createPendingIntentsStore } = await import("../../pending-intents.js");
    const pending = createPendingIntentsStore();
    createGateHandler({
      nc: fakeNats as never,
      config: { broker: "schwab" },
      logger: createTestLogger(),
      evaluator,
      auditIntentWriter: async (row) => {
        writtenIntents.push(row);
      },
      generateIntentId: () => `INT-${++idCounter}`,
      pendingIntents: pending,
      now: () => "2026-05-29T15:00:00Z",
    });
    await fakeNats.pumpRequest(
      "orders.gate.schwab",
      makeRequest({ portfolio_id: "main", strategy_id: "s-1" }),
    );
    await new Promise((r) => setImmediate(r));
    expect(pending.get("INT-1")).toMatchObject({
      intent_id: "INT-1",
      envelope_id: "INT-1",
      strategy_id: "s-1",
      portfolio_id: "main",
      broker: "schwab",
      status: "pending",
      remaining_qty: 1,
    });
  });

  it("reject path does NOT enroll into pending-intents store", async () => {
    const { createPendingIntentsStore } = await import("../../pending-intents.js");
    const pending = createPendingIntentsStore();
    createGateHandler({
      nc: fakeNats as never,
      config: { broker: "schwab" },
      logger: createTestLogger(),
      evaluator: {
        evaluate: () => ({ decision: "reject", reason: "limit_exceeded_per_strategy" }),
      },
      auditIntentWriter: async (row) => {
        writtenIntents.push(row);
      },
      generateIntentId: () => `INT-${++idCounter}`,
      pendingIntents: pending,
      now: () => "2026-05-29T15:00:00Z",
    });
    await fakeNats.pumpRequest("orders.gate.schwab", makeRequest());
    await new Promise((r) => setImmediate(r));
    expect(pending.size()).toBe(0);
  });
});
