// QF-318 — envelope revoker unit tests.
//
// Covers:
//   - revoke round-trip: 'revoked' reply → status revoked + audit mutate fires
//   - idempotency: 'envelope_unknown' reply → also success + audit mutate fires
//   - timeout retry: first attempt times out, second succeeds
//   - max-retries exhausted → status failed + alert emitted
//   - audit mutate failure doesn't poison revoke-success return
//   - sleep is invoked with exponential backoff between attempts

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StringCodec } from "nats";
import {
  createEnvelopeRevoker,
  type AuditEnvelopeRevokeMutator,
  type RevokeReason,
} from "../../envelope-revoker.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";

// ── Fake NATS (request only) ─────────────────────────────────────────

const sc = StringCodec();

interface ReplyStep {
  // 'reply' returns the parsed reply payload.
  // 'timeout' rejects with a timeout-style error.
  // 'throw' rejects with the given error.
  kind: "reply" | "timeout" | "throw";
  payload?: unknown;
  error?: Error;
}

interface FakeNats {
  request(
    subject: string,
    payload: Uint8Array,
    opts: { timeout: number },
  ): Promise<{ data: Uint8Array }>;
  // Test seam: queue per-attempt responses for the next subject.
  queueReplies(subject: string, steps: ReplyStep[]): void;
  observed: Array<{ subject: string; payload: unknown }>;
}

function makeFakeNats(): FakeNats {
  const queues = new Map<string, ReplyStep[]>();
  const observed: Array<{ subject: string; payload: unknown }> = [];

  return {
    observed,
    queueReplies(subject, steps) {
      queues.set(subject, steps);
    },
    async request(subject, payload, _opts) {
      observed.push({
        subject,
        payload: JSON.parse(sc.decode(payload)),
      });
      const q = queues.get(subject);
      if (!q || q.length === 0) {
        throw new Error(`no queued reply for ${subject}`);
      }
      const step = q.shift()!;
      if (step.kind === "timeout") {
        throw new Error(`request timeout: ${subject}`);
      }
      if (step.kind === "throw") {
        throw step.error ?? new Error("test-injected error");
      }
      return { data: sc.encode(JSON.stringify(step.payload)) };
    },
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────

const SUBJECT = "orders.gate.revoke.schwab";

describe("envelope-revoker (QF-318)", () => {
  let fakeNats: FakeNats;
  let mutateCalls: Array<{ envelope_id: string; reason: RevokeReason; revoked_at: string }>;
  let mutator: AuditEnvelopeRevokeMutator;
  let alertCalls: Array<{ envelope_id: string; attempts: number }>;
  let sleepWaits: number[];

  beforeEach(() => {
    fakeNats = makeFakeNats();
    mutateCalls = [];
    mutator = async (envelope_id, reason, revoked_at) => {
      mutateCalls.push({ envelope_id, reason, revoked_at });
    };
    alertCalls = [];
    sleepWaits = [];
  });

  function makeRevoker(opts: { maxRetries?: number; timeoutMs?: number } = {}) {
    return createEnvelopeRevoker({
      nc: fakeNats as never,
      config: {
        broker: "schwab",
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        retryBaseMs: 100,
      },
      logger: createTestLogger(),
      auditMutator: mutator,
      alertEmitter: (envelope_id, attempts) => {
        alertCalls.push({ envelope_id, attempts });
      },
      sleep: async (ms) => {
        sleepWaits.push(ms);
      },
      now: () => "2026-05-29T17:00:00Z",
    });
  }

  it("revoke round-trip: 'revoked' reply returns status revoked + audit mutate fires", async () => {
    fakeNats.queueReplies(SUBJECT, [{ kind: "reply", payload: { status: "revoked" } }]);
    const revoker = makeRevoker();
    const result = await revoker.revokeEnvelope("ENV-1", "operator_initiated");
    expect(result.status).toBe("revoked");
    expect(mutateCalls).toEqual([
      {
        envelope_id: "ENV-1",
        reason: "operator_initiated",
        revoked_at: "2026-05-29T17:00:00Z",
      },
    ]);
    expect(alertCalls).toEqual([]);
    expect(fakeNats.observed).toHaveLength(1);
    expect(fakeNats.observed[0]?.payload).toMatchObject({
      envelope_id: "ENV-1",
      reason: "operator_initiated",
      asof: "2026-05-29T17:00:00Z",
    });
  });

  it("idempotency: 'envelope_unknown' reply is treated as success + audit mutate still fires", async () => {
    fakeNats.queueReplies(SUBJECT, [{ kind: "reply", payload: { status: "envelope_unknown" } }]);
    const revoker = makeRevoker();
    const result = await revoker.revokeEnvelope("ENV-GONE", "strategy_halted");
    expect(result.status).toBe("envelope_unknown");
    expect(mutateCalls).toHaveLength(1);
    expect(alertCalls).toEqual([]);
  });

  it("timeout retry: first attempt times out, second attempt succeeds; revoke returns success", async () => {
    fakeNats.queueReplies(SUBJECT, [
      { kind: "timeout" },
      { kind: "reply", payload: { status: "revoked" } },
    ]);
    const revoker = makeRevoker({ maxRetries: 3 });
    const result = await revoker.revokeEnvelope("ENV-2", "drift_hard_trip");
    expect(result.status).toBe("revoked");
    expect(fakeNats.observed).toHaveLength(2);
    expect(mutateCalls).toHaveLength(1);
    // Backoff after the first failed attempt: 100 * 2^0 = 100ms.
    expect(sleepWaits).toEqual([100]);
  });

  it("exhausted retries: 1 attempt + 3 retries all timeout → status failed + alert fires", async () => {
    fakeNats.queueReplies(SUBJECT, [
      { kind: "timeout" },
      { kind: "timeout" },
      { kind: "timeout" },
      { kind: "timeout" },
    ]);
    const revoker = makeRevoker({ maxRetries: 3 });
    const result = await revoker.revokeEnvelope("ENV-DEAD", "portfolio_halted");
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(4);
    expect(mutateCalls).toEqual([]);
    expect(alertCalls).toEqual([{ envelope_id: "ENV-DEAD", attempts: 4 }]);
    // Exponential backoff: 100, 200, 400 ms after attempts 1, 2, 3.
    expect(sleepWaits).toEqual([100, 200, 400]);
  });

  it("audit mutate failure does NOT flip the revoke-success return value", async () => {
    fakeNats.queueReplies(SUBJECT, [{ kind: "reply", payload: { status: "revoked" } }]);
    mutator = vi.fn(async () => {
      throw new Error("duckdb out to lunch");
    });
    const revoker = createEnvelopeRevoker({
      nc: fakeNats as never,
      config: { broker: "schwab", retryBaseMs: 100 },
      logger: createTestLogger(),
      auditMutator: mutator,
      sleep: async (ms) => {
        sleepWaits.push(ms);
      },
      now: () => "2026-05-29T17:00:00Z",
    });
    const result = await revoker.revokeEnvelope("ENV-3", "concentration_breach_other_strategy");
    expect(result.status).toBe("revoked");
    expect(mutator).toHaveBeenCalledOnce();
  });

  it("no retry when maxRetries=0: single attempt, on timeout returns failed immediately", async () => {
    fakeNats.queueReplies(SUBJECT, [{ kind: "timeout" }]);
    const revoker = makeRevoker({ maxRetries: 0 });
    const result = await revoker.revokeEnvelope("ENV-ONESHOT", "operator_initiated");
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(sleepWaits).toEqual([]); // no backoff between attempts when only one
    expect(alertCalls).toHaveLength(1);
  });
});
