// QF-221 — smoke test for the production book-budget wiring pattern.
//
// The actual server/index.js boot composition isn't unit-testable
// (intertwined module state), so this test exercises the same shape in
// isolation: construct the allocator + subscription manager with a
// late-bound `getBookCandidate` closure, verify that the closure can be
// swapped in after the fact (mirrors the bootstrap-then-monitor order),
// and that the allocator's `usage()` / `claims()` snapshots reflect
// subscription state.

import { describe, it, expect } from "vitest";
import {
  createBookBudgetAllocator,
  createBookBudgetMetrics,
  WorkingOrderPriorityComparator,
  type BookCandidate,
} from "../../book-budget.js";
import { createSubscriptionManager } from "../../subscriptions.js";
import { createLogger } from "../../../logger.js";
import type { MarketDataAdapter, L2Book, Subscription } from "../../../../src/types/market-data.js";

const log = createLogger("book-budget-wiring-test", "error");

function fakeBookAdapter(name: string): MarketDataAdapter {
  return {
    name,
    async available() {
      return true;
    },
    async stockQuote() {
      return null;
    },
    async expirations() {
      return [];
    },
    async chain() {
      return [];
    },
    async historicalChain() {
      return [];
    },
    subscribeBook(_symbols: string[], _cb: (s: string, b: L2Book) => void): Subscription | null {
      return { unsubscribe(): void {} };
    },
  };
}

function emptyCache() {
  return {
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
    clear: () => undefined,
  };
}

describe("QF-221 book-budget wiring pattern", () => {
  it("allocator + subscription manager construct with the late-bound getBookCandidate closure", () => {
    const metrics = createBookBudgetMetrics();
    const allocator = createBookBudgetAllocator({
      config: { limits: { ibkr: 3 } },
      metrics,
      comparator: WorkingOrderPriorityComparator,
    });
    let bookCandidateImpl: (symbol: string) => BookCandidate | null = () => null;
    const mgr = createSubscriptionManager(
      [fakeBookAdapter("ibkr")],
      emptyCache() as never,
      { poll_interval_ms: 1000 },
      log,
      {
        bookBudget: allocator,
        bookBudgetComparator: WorkingOrderPriorityComparator,
        getBookCandidate: (s) => bookCandidateImpl(s),
      },
    );
    expect(typeof mgr.subscribeBook).toBe("function");
    // Allocator usage starts empty.
    expect(allocator.usage()).toEqual({});

    // First claim — under budget.
    const sub = mgr.subscribeBook(["SPY"], () => {});
    expect(sub).not.toBeNull();
    expect(allocator.usage().ibkr).toBe(1);

    // Now swap in a real getBookCandidate (the bootstrap-then-monitor
    // order in server/index.js). The closure call surface is stable.
    bookCandidateImpl = (s) => ({
      symbol: s,
      working_age_ms: 60_000,
      working_notional_usd: 1_000_000,
    });
    // A subsequent subscribe still works.
    const sub2 = mgr.subscribeBook(["AAPL"], () => {});
    expect(sub2).not.toBeNull();
    expect(allocator.usage().ibkr).toBe(2);

    sub?.unsubscribe();
    sub2?.unsubscribe();
  });

  it("an empty book_budget config means the allocator is uncapped (no denials)", () => {
    const metrics = createBookBudgetMetrics();
    const allocator = createBookBudgetAllocator({
      config: { limits: {} },
      metrics,
    });
    // No adapter would name a source absent from the limits map; the
    // allocator treats them as uncapped. Verify by checking that
    // hasHeadroom returns true for any source.
    expect(allocator.hasHeadroom("anything")).toBe(true);
    expect(allocator.hasHeadroom("ibkr")).toBe(true);
  });

  it("uses the book_budget map from config.market-data.json as the source-of-truth shape", () => {
    // Mirrors config/market-data.json's actual shape: a flat map of
    // adapter-name → integer cap.
    const metrics = createBookBudgetMetrics();
    const allocator = createBookBudgetAllocator({
      config: { limits: { schwab: 100, ibkr: 3 } },
      metrics,
    });
    expect(allocator.hasHeadroom("schwab")).toBe(true);
    expect(allocator.hasHeadroom("ibkr")).toBe(true);
    // Claim 3 ibkr slots — saturates.
    allocator.claim("A", "ibkr");
    allocator.claim("B", "ibkr");
    allocator.claim("C", "ibkr");
    expect(allocator.hasHeadroom("ibkr")).toBe(false);
    // Schwab still has plenty.
    expect(allocator.hasHeadroom("schwab")).toBe(true);
  });
});
