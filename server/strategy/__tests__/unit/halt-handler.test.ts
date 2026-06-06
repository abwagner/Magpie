// QF-324 — Strategy halt → envelope revoke handler.
//
// Covers:
//   - no open envelopes → no revoker calls, no panic
//   - one open envelope → revoker called once with strategy_halted +
//     pending-intents row marked envelope_revoked
//   - multiple envelopes across two brokers → dispatched to correct
//     revokers in parallel
//   - unknown broker → logged + counted as failed; revoke skipped
//   - failed revoke → pending-intents row NOT marked envelope_revoked

import { describe, it, expect, beforeEach } from "vitest";
import { createStrategyHaltHandler } from "../../halt-handler.js";
import { createPendingIntentsStore } from "../../../risk/pending-intents.js";
import type { EnvelopeRevoker } from "../../../risk/envelope-revoker.js";
import type { PendingIntent } from "../../../risk/pending-intents.js";
import type { Strategy } from "../../lifecycle.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";

function makeIntent(overrides: Partial<PendingIntent> = {}): PendingIntent {
  return {
    intent_id: "INT-1",
    strategy_id: "s-1",
    portfolio_id: "main",
    broker: "schwab",
    symbol: "SPY",
    side: "buy",
    qty: 1,
    remaining_qty: 1,
    estimated_notional: 100,
    estimated_delta: 0,
    asof: "2026-05-29T17:00:00Z",
    status: "pending",
    envelope_id: "INT-1",
    ...overrides,
  };
}

function strategy(id: string): Strategy {
  return {
    id,
    state: "halted",
    operator_notes: "",
    history: [],
    updated_at: "2026-05-29T17:00:00Z",
    name: id,
  } as unknown as Strategy;
}

describe("strategy halt handler (QF-324)", () => {
  let pending: ReturnType<typeof createPendingIntentsStore>;
  let revokeCalls: Array<{ broker: string; envelope_id: string; reason: string }>;
  let revokers: Map<string, EnvelopeRevoker>;

  function makeRevoker(
    broker: string,
    replyStatus: "revoked" | "envelope_unknown" | "failed" = "revoked",
  ): EnvelopeRevoker {
    return {
      async revokeEnvelope(envelope_id, reason) {
        revokeCalls.push({ broker, envelope_id, reason });
        return { status: replyStatus, attempts: 1 };
      },
    };
  }

  beforeEach(() => {
    pending = createPendingIntentsStore();
    revokeCalls = [];
    revokers = new Map<string, EnvelopeRevoker>();
  });

  it("no-op when strategy has no open envelopes", async () => {
    revokers.set("schwab", makeRevoker("schwab"));
    const handle = createStrategyHaltHandler({
      logger: createTestLogger(),
      pendingIntents: pending,
      revokers,
    });
    await handle(strategy("s-empty"));
    expect(revokeCalls).toEqual([]);
  });

  it("single envelope: revokes + marks pending row envelope_revoked", async () => {
    pending.add(makeIntent({ intent_id: "INT-A", envelope_id: "INT-A" }));
    revokers.set("schwab", makeRevoker("schwab"));
    const handle = createStrategyHaltHandler({
      logger: createTestLogger(),
      pendingIntents: pending,
      revokers,
      now: () => "2026-05-29T17:30:00Z",
    });
    await handle(strategy("s-1"));
    expect(revokeCalls).toEqual([
      { broker: "schwab", envelope_id: "INT-A", reason: "strategy_halted" },
    ]);
    expect(pending.get("INT-A")?.status).toBe("envelope_revoked");
  });

  it("multiple envelopes across two brokers dispatch to correct revokers", async () => {
    pending.add(makeIntent({ intent_id: "S-1", envelope_id: "S-1", broker: "schwab" }));
    pending.add(makeIntent({ intent_id: "I-1", envelope_id: "I-1", broker: "ibkr" }));
    pending.add(makeIntent({ intent_id: "S-2", envelope_id: "S-2", broker: "schwab" }));
    revokers.set("schwab", makeRevoker("schwab"));
    revokers.set("ibkr", makeRevoker("ibkr"));
    const handle = createStrategyHaltHandler({
      logger: createTestLogger(),
      pendingIntents: pending,
      revokers,
    });
    await handle(strategy("s-1"));
    const brokers = revokeCalls.map((c) => c.broker).sort();
    expect(brokers).toEqual(["ibkr", "schwab", "schwab"]);
    expect(pending.get("S-1")?.status).toBe("envelope_revoked");
    expect(pending.get("I-1")?.status).toBe("envelope_revoked");
    expect(pending.get("S-2")?.status).toBe("envelope_revoked");
  });

  it("unknown broker: skipped + counted as failed (no revoke + pending row left alone)", async () => {
    pending.add(makeIntent({ intent_id: "Z-1", envelope_id: "Z-1", broker: "unknown-broker" }));
    const handle = createStrategyHaltHandler({
      logger: createTestLogger(),
      pendingIntents: pending,
      revokers,
    });
    await handle(strategy("s-1"));
    expect(revokeCalls).toEqual([]);
    expect(pending.get("Z-1")?.status).toBe("pending");
  });

  it("failed revoke: pending row NOT marked envelope_revoked", async () => {
    pending.add(makeIntent({ intent_id: "F-1", envelope_id: "F-1" }));
    revokers.set("schwab", makeRevoker("schwab", "failed"));
    const handle = createStrategyHaltHandler({
      logger: createTestLogger(),
      pendingIntents: pending,
      revokers,
    });
    await handle(strategy("s-1"));
    expect(revokeCalls).toHaveLength(1);
    expect(pending.get("F-1")?.status).toBe("pending");
  });
});
