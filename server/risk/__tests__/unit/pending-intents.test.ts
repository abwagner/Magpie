// QF-316 — pending_intents store unit tests.
//
// Covers:
//   - add() then getActive()
//   - markPartialFill() reduces remaining_qty
//   - partial fill that exhausts qty auto-transitions to filled
//   - mark{Filled,Cancelled,Rejected,EnvelopeRevoked} terminal states
//   - terminal rows drop out of getActive()
//   - sweep() drops terminal rows after the retention window
//   - sweep() leaves pending rows alone
//   - getActiveForStrategy / getActiveForPortfolio filtering

import { describe, it, expect } from "vitest";
import { createPendingIntentsStore, type PendingIntent } from "../../pending-intents.js";

function makeIntent(overrides: Partial<PendingIntent> = {}): PendingIntent {
  return {
    intent_id: "INT-A",
    strategy_id: "s-1",
    portfolio_id: "main",
    broker: "schwab",
    symbol: "SPY",
    side: "buy",
    qty: 10,
    remaining_qty: 10,
    estimated_notional: 5000,
    estimated_delta: 5,
    asof: "2026-05-29T17:00:00Z",
    status: "pending",
    envelope_id: "INT-A",
    ...overrides,
  };
}

describe("pending-intents store (QF-316)", () => {
  it("add + getActive returns enrolled pending entries", () => {
    const store = createPendingIntentsStore();
    store.add(makeIntent({ intent_id: "INT-1" }));
    store.add(makeIntent({ intent_id: "INT-2", strategy_id: "s-2" }));
    expect(store.getActive()).toHaveLength(2);
  });

  it("markPartialFill reduces remaining_qty without changing total qty", () => {
    const store = createPendingIntentsStore();
    store.add(makeIntent({ intent_id: "INT-PF", qty: 10, remaining_qty: 10 }));
    store.markPartialFill("INT-PF", 3, "2026-05-29T17:01:00Z");
    const i = store.get("INT-PF");
    expect(i?.remaining_qty).toBe(7);
    expect(i?.qty).toBe(10);
    expect(i?.status).toBe("pending");
  });

  it("partial fill that exhausts remaining auto-transitions to filled", () => {
    const store = createPendingIntentsStore();
    store.add(makeIntent({ intent_id: "INT-AF", qty: 5, remaining_qty: 5 }));
    store.markPartialFill("INT-AF", 5, "2026-05-29T17:01:00Z");
    expect(store.get("INT-AF")?.status).toBe("filled");
    expect(store.getActive()).toEqual([]);
  });

  it.each([
    ["markFilled", "filled"],
    ["markCancelled", "cancelled"],
    ["markRejected", "rejected"],
    ["markEnvelopeRevoked", "envelope_revoked"],
  ] as const)("%s transitions status to %s", (method, expectedStatus) => {
    const store = createPendingIntentsStore();
    store.add(makeIntent({ intent_id: "INT-T" }));
    (store as unknown as Record<string, (id: string, now: string) => void>)[method]!(
      "INT-T",
      "2026-05-29T17:00:00Z",
    );
    expect(store.get("INT-T")?.status).toBe(expectedStatus);
    expect(store.getActive()).toEqual([]);
  });

  it("sweep drops terminal rows past the retention window; pending rows stay", () => {
    const store = createPendingIntentsStore({ retentionMs: 60_000 });
    store.add(makeIntent({ intent_id: "INT-OLD" }));
    store.add(makeIntent({ intent_id: "INT-NEW" }));
    store.add(makeIntent({ intent_id: "INT-LIVE" }));
    store.markFilled("INT-OLD", "2026-05-29T17:00:00Z");
    store.markFilled("INT-NEW", "2026-05-29T17:02:30Z");
    // INT-LIVE stays pending; never enters retention window.
    const dropped = store.sweep("2026-05-29T17:02:00Z");
    expect(dropped).toBe(1); // INT-OLD (terminal 120s before; retention=60s)
    expect(store.size()).toBe(2);
    expect(store.has("INT-OLD")).toBe(false);
    expect(store.has("INT-NEW")).toBe(true);
    expect(store.has("INT-LIVE")).toBe(true);
  });

  it("getActiveForStrategy / getActiveForPortfolio filter correctly", () => {
    const store = createPendingIntentsStore();
    store.add(makeIntent({ intent_id: "A", strategy_id: "s-1", portfolio_id: "p-1" }));
    store.add(makeIntent({ intent_id: "B", strategy_id: "s-1", portfolio_id: "p-2" }));
    store.add(makeIntent({ intent_id: "C", strategy_id: "s-2", portfolio_id: "p-1" }));
    expect(
      store
        .getActiveForStrategy("s-1")
        .map((i) => i.intent_id)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(
      store
        .getActiveForPortfolio("p-1")
        .map((i) => i.intent_id)
        .sort(),
    ).toEqual(["A", "C"]);
  });
});
