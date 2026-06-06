// Tests for the QF-28 book budget allocator. Covers per-source
// headroom accounting, claim/release idempotency, and the
// marketdata_book_budget_denied_total metric label correctness.
// Integration with `subscribeBook` is tested in subscriptions.test.ts.

import { describe, it, expect } from "vitest";
import {
  createBookBudgetAllocator,
  createBookBudgetMetrics,
  NoopComparator,
} from "../../book-budget.js";

interface MetricValue {
  value?: number;
  labels?: Record<string, string>;
}

interface MetricJson {
  name: string;
  values?: MetricValue[];
}

async function getDeniedCount(
  metrics: ReturnType<typeof createBookBudgetMetrics>,
  symbol?: string,
  reason?: string,
): Promise<number> {
  const all = (await metrics.registry.getMetricsAsJSON()) as MetricJson[];
  const entry = all.find((x) => x.name === "marketdata_book_budget_denied_total");
  if (!entry?.values) return 0;
  return entry.values
    .filter((v) => (symbol ? v.labels?.symbol === symbol : true))
    .filter((v) => (reason ? v.labels?.reason === reason : true))
    .reduce((acc, v) => acc + (v.value ?? 0), 0);
}

describe("createBookBudgetAllocator — headroom accounting", () => {
  it("reports headroom for sources below their limit", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 100, ibkr: 3 } },
      metrics,
    });
    expect(alloc.hasHeadroom("schwab")).toBe(true);
    expect(alloc.hasHeadroom("ibkr")).toBe(true);
  });

  it("reports no headroom once a source hits its limit", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { ibkr: 2 } },
      metrics,
    });
    alloc.claim("SPY", "ibkr");
    expect(alloc.hasHeadroom("ibkr")).toBe(true);
    alloc.claim("QQQ", "ibkr");
    expect(alloc.hasHeadroom("ibkr")).toBe(false);
  });

  it("treats sources missing from the limits map as uncapped", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    // schwab isn't in the limits map → always has headroom.
    for (let i = 0; i < 1000; i++) {
      alloc.claim(`SYM${i}`, "schwab");
    }
    expect(alloc.hasHeadroom("schwab")).toBe(true);
  });
});

describe("createBookBudgetAllocator — claim / release", () => {
  it("usage() reflects per-source claim counts", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 100, ibkr: 3 } },
      metrics,
    });
    alloc.claim("SPY", "schwab");
    alloc.claim("QQQ", "schwab");
    alloc.claim("AAPL", "ibkr");
    expect(alloc.usage()).toEqual({ schwab: 2, ibkr: 1 });
  });

  it("release() drops the per-source count back down", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 100 } },
      metrics,
    });
    alloc.claim("SPY", "schwab");
    alloc.claim("QQQ", "schwab");
    alloc.release("SPY");
    expect(alloc.usage()).toEqual({ schwab: 1 });
  });

  it("claim is idempotent when (symbol, source) is unchanged", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 5 } },
      metrics,
    });
    alloc.claim("SPY", "schwab");
    alloc.claim("SPY", "schwab");
    alloc.claim("SPY", "schwab");
    expect(alloc.usage()).toEqual({ schwab: 1 });
  });

  it("claim swaps source-attribution for a symbol (preemption handoff)", () => {
    // When a symbol's allocation moves from one source to another
    // (preemption), the old slot must be released. Tests the
    // bookkeeping; preemption decision itself is QF-47/48.
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 100, ibkr: 3 } },
      metrics,
    });
    alloc.claim("SPY", "ibkr");
    expect(alloc.usage()).toEqual({ ibkr: 1 });
    alloc.claim("SPY", "schwab");
    expect(alloc.usage()).toEqual({ ibkr: 0, schwab: 1 });
  });

  it("release is idempotent on a never-claimed symbol", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: {} },
      metrics,
    });
    expect(() => alloc.release("NEVER_CLAIMED")).not.toThrow();
    expect(alloc.usage()).toEqual({});
  });
});

describe("createBookBudgetAllocator — denial metric", () => {
  it("recordDenied increments the metric with the right symbol + reason labels", async () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 1 } },
      metrics,
    });
    alloc.recordDenied("SPY", "no_capacity");
    alloc.recordDenied("QQQ", "no_source");
    alloc.recordDenied("SPY", "no_capacity");

    expect(await getDeniedCount(metrics, "SPY", "no_capacity")).toBe(2);
    expect(await getDeniedCount(metrics, "QQQ", "no_source")).toBe(1);
    expect(await getDeniedCount(metrics)).toBe(3);
  });
});

describe("NoopComparator", () => {
  it("never preempts (returns 0 for any candidate pair)", () => {
    // QF-28 ships with NoopComparator — preemption is QF-47/48. Pin
    // the contract: as long as Noop is the default, the allocator
    // never evicts.
    const a = { symbol: "SPY", working_age_ms: 60000, working_notional_usd: 1_000_000 };
    const b = { symbol: "QQQ", working_age_ms: 1000, working_notional_usd: 100 };
    expect(NoopComparator.compare(a, b)).toBe(0);
    expect(NoopComparator.compare(b, a)).toBe(0);
  });
});

// ── QF-205 — WorkingOrderPriorityComparator ───────────────────────────

import { WorkingOrderPriorityComparator } from "../../book-budget.js";

describe("WorkingOrderPriorityComparator (QF-205)", () => {
  const URGENT = 60_000;
  const FRESH = 5_000;

  it("urgent (>30s) preempts fresh (<=30s) regardless of notional", () => {
    const urgent = { symbol: "A", working_age_ms: URGENT, working_notional_usd: 100 };
    const freshLarge = { symbol: "B", working_age_ms: FRESH, working_notional_usd: 1_000_000 };
    expect(WorkingOrderPriorityComparator.compare(urgent, freshLarge)).toBeLessThan(0);
    expect(WorkingOrderPriorityComparator.compare(freshLarge, urgent)).toBeGreaterThan(0);
  });

  it("within the same tier, larger notional wins", () => {
    const small = { symbol: "A", working_age_ms: URGENT, working_notional_usd: 100 };
    const large = { symbol: "B", working_age_ms: URGENT, working_notional_usd: 1_000_000 };
    expect(WorkingOrderPriorityComparator.compare(large, small)).toBeLessThan(0);
    expect(WorkingOrderPriorityComparator.compare(small, large)).toBeGreaterThan(0);
  });

  it("equal age tier + equal notional returns 0 (round-robin handled outside)", () => {
    const a = { symbol: "A", working_age_ms: FRESH, working_notional_usd: 500 };
    const b = { symbol: "B", working_age_ms: FRESH, working_notional_usd: 500 };
    expect(WorkingOrderPriorityComparator.compare(a, b)).toBe(0);
  });

  it("works across the urgent threshold boundary at exactly 30s", () => {
    const exactly30s = { symbol: "A", working_age_ms: 30_000, working_notional_usd: 100 };
    const justOver = { symbol: "B", working_age_ms: 30_001, working_notional_usd: 100 };
    // 30s is NOT urgent (we test > 30000), 30001ms IS urgent.
    expect(WorkingOrderPriorityComparator.compare(justOver, exactly30s)).toBeLessThan(0);
  });
});

describe("createBookBudgetAllocator.claims() snapshot (QF-205)", () => {
  it("returns a snapshot of currently-claimed (symbol, source) pairs", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 100, ibkr: 3 } },
      metrics,
    });
    alloc.claim("SPY", "schwab");
    alloc.claim("QQQ", "ibkr");
    expect(alloc.claims()).toEqual({ SPY: "schwab", QQQ: "ibkr" });
  });

  it("reflects preemption-handoff after a source swap", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: { schwab: 100, ibkr: 3 } },
      metrics,
    });
    alloc.claim("SPY", "schwab");
    alloc.claim("SPY", "ibkr"); // swap
    expect(alloc.claims()).toEqual({ SPY: "ibkr" });
    expect(alloc.usage()).toEqual({ schwab: 0, ibkr: 1 });
  });

  it("release removes the (symbol, source) entry from claims()", () => {
    const metrics = createBookBudgetMetrics();
    const alloc = createBookBudgetAllocator({
      config: { limits: {} },
      metrics,
    });
    alloc.claim("SPY", "schwab");
    alloc.release("SPY");
    expect(alloc.claims()).toEqual({});
  });
});
