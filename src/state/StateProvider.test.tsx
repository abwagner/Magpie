import { describe, expect, it } from "vitest";
import {
  applyMessage,
  applyAlertToOutstanding,
  applyExitRuleTrip,
  type ExitRuleTrip,
  type OutstandingQuoteAlert,
} from "./StateProvider.js";
import type { PositionExitRuleMsg, SystemState, WsMessage } from "../types/ws.js";

const SNAP: SystemState = {
  type: "snapshot",
  system: { halted: false, app_env: "dev", trading_mode: "paper" },
  portfolios: { main: { cash: 100 } as never },
  orders: { recent: [] },
};

describe("applyMessage", () => {
  it("snapshot replaces state", () => {
    const next = applyMessage({ ...SNAP, system: { halted: true } }, SNAP);
    expect(next?.system.halted).toBe(false);
  });

  it("portfolio_update merges into existing portfolio", () => {
    const msg: WsMessage = {
      type: "portfolio_update",
      portfolio: "main",
      data: { cash: 250 } as never,
    };
    const next = applyMessage(SNAP, msg);
    const main = next?.portfolios?.main as { cash: number };
    expect(main.cash).toBe(250);
  });

  it("system_halt flips halted with reason", () => {
    const msg: WsMessage = {
      type: "system_halt",
      halted: true,
      reason: "kill switch",
    };
    const next = applyMessage(SNAP, msg);
    expect(next?.system.halted).toBe(true);
    expect(next?.system.halt_reason).toBe("kill switch");
  });

  it("non-snapshot messages return null when prev is null", () => {
    const msg: WsMessage = {
      type: "portfolio_update",
      portfolio: "main",
      data: {} as never,
    };
    expect(applyMessage(null, msg)).toBeNull();
  });

  it("order_update prepends to orders.recent and caps length", () => {
    const seed: SystemState = {
      ...SNAP,
      orders: {
        recent: Array.from({ length: 50 }, (_, i) => ({ id: `o${i}` }) as never),
      },
    };
    const msg: WsMessage = {
      type: "order_update",
      data: { id: "new" } as never,
    };
    const next = applyMessage(seed, msg);
    const recent = next?.orders?.recent ?? [];
    expect(recent.length).toBe(50);
    const first = recent[0] as { id: string } | undefined;
    expect(first?.id).toBe("new");
  });
});

// QF-228 — outstanding quote-alerts reducer.
describe("applyAlertToOutstanding", () => {
  const empty = new Map<string, OutstandingQuoteAlert>();

  function quoteUnavailable(
    symbol: string,
    extra: Record<string, unknown> = {},
  ): {
    type: "alert";
    data: { type: string; ts?: string; payload?: Record<string, unknown> };
  } {
    return {
      type: "alert",
      data: {
        type: "quote_unavailable",
        ts: "2026-05-20T12:00:00Z",
        payload: { symbol, reason: "stale", adapter: "schwab", portfolio: "main", ...extra },
      },
    };
  }

  function quoteRecovered(symbol: string): {
    type: "alert";
    data: { type: string; ts?: string; payload?: Record<string, unknown> };
  } {
    return {
      type: "alert",
      data: { type: "quote_recovered", payload: { symbol } },
    };
  }

  it("adds a quote_unavailable entry keyed by symbol", () => {
    const next = applyAlertToOutstanding(empty, quoteUnavailable("OPT:SPY:2026-06-19:C:500"));
    expect(next.size).toBe(1);
    const entry = next.get("OPT:SPY:2026-06-19:C:500");
    expect(entry?.reason).toBe("stale");
    expect(entry?.adapter).toBe("schwab");
    expect(entry?.portfolio).toBe("main");
  });

  it("collapses repeated quote_unavailable for the same symbol", () => {
    const after1 = applyAlertToOutstanding(empty, quoteUnavailable("X"));
    const after2 = applyAlertToOutstanding(after1, quoteUnavailable("X", { reason: "inverted" }));
    expect(after2.size).toBe(1);
    expect(after2.get("X")?.reason).toBe("inverted");
  });

  it("keeps separate entries for different symbols", () => {
    const after1 = applyAlertToOutstanding(empty, quoteUnavailable("X"));
    const after2 = applyAlertToOutstanding(after1, quoteUnavailable("Y"));
    expect(after2.size).toBe(2);
  });

  it("quote_recovered clears the matching entry", () => {
    const after1 = applyAlertToOutstanding(empty, quoteUnavailable("X"));
    const after2 = applyAlertToOutstanding(after1, quoteRecovered("X"));
    expect(after2.size).toBe(0);
  });

  it("quote_recovered for an unknown symbol is a no-op (returns same map)", () => {
    const after1 = applyAlertToOutstanding(empty, quoteUnavailable("X"));
    const after2 = applyAlertToOutstanding(after1, quoteRecovered("Y"));
    expect(after2).toBe(after1);
  });

  it("ignores alerts other than quote_unavailable / quote_recovered", () => {
    const noisy = {
      type: "alert" as const,
      data: {
        type: "kill_switch_armed",
        payload: { symbol: "X" },
      },
    };
    const next = applyAlertToOutstanding(empty, noisy);
    expect(next).toBe(empty);
  });

  it("ignores alerts missing a symbol payload field", () => {
    const noSymbol = {
      type: "alert" as const,
      data: { type: "quote_unavailable", payload: { reason: "stale" } },
    };
    const next = applyAlertToOutstanding(empty, noSymbol);
    expect(next).toBe(empty);
  });
});

// QF-322 — exit-rule trip reducer.
describe("applyExitRuleTrip", () => {
  const clock = () => "2026-05-20T12:00:00Z";

  function trip(over: Partial<PositionExitRuleMsg["data"]> = {}): PositionExitRuleMsg {
    return {
      type: "position_exit_rule",
      data: {
        position_id: "pos-1",
        rule: "stop_loss",
        closing_intent_id: "intent-1",
        strategy_id: "straddle-spy",
        ...over,
      },
    };
  }

  it("prepends a stamped trip onto the ring", () => {
    const next = applyExitRuleTrip([], trip(), clock);
    expect(next).toHaveLength(1);
    expect(next[0]?.position_id).toBe("pos-1");
    expect(next[0]?.ts).toBe("2026-05-20T12:00:00Z");
  });

  it("keeps most-recent-first ordering across trips", () => {
    const after1 = applyExitRuleTrip([], trip({ position_id: "pos-1" }), clock);
    const after2 = applyExitRuleTrip(
      after1,
      trip({ position_id: "pos-2", closing_intent_id: "intent-2" }),
      clock,
    );
    expect(after2.map((t) => t.position_id)).toEqual(["pos-2", "pos-1"]);
  });

  it("dedupes a re-broadcast of the same close (intent + position)", () => {
    const after1 = applyExitRuleTrip([], trip(), clock);
    const after2 = applyExitRuleTrip(after1, trip(), clock);
    expect(after2).toBe(after1);
  });

  it("keeps distinct legs of one intent as separate trips", () => {
    const after1 = applyExitRuleTrip([], trip({ position_id: "leg-a" }), clock);
    const after2 = applyExitRuleTrip(after1, trip({ position_id: "leg-b" }), clock);
    expect(after2).toHaveLength(2);
  });

  it("caps the ring at 50 entries", () => {
    let ring: ExitRuleTrip[] = [];
    for (let i = 0; i < 60; i++) {
      ring = applyExitRuleTrip(ring, trip({ closing_intent_id: `intent-${i}` }), clock);
    }
    expect(ring).toHaveLength(50);
    // Newest first → the last-applied intent leads.
    expect(ring[0]?.closing_intent_id).toBe("intent-59");
  });
});
