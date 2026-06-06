// ── Book Budget Allocator ─────────────────────────────────────────────
// Tracks per-source L2 subscription capacity. The subscription manager
// consults this allocator while walking its priority-ordered adapter
// list — sources at budget are skipped, sources with headroom get a
// shot at the symbol.
//
// Defined in: docs/data/market-data.md §10.3
//
// Allocation algorithm (v1 / MVP):
//   1. Subscription manager walks adapters in `stream_priority.book`
//      order.
//   2. For each adapter: skip if `allocator.hasHeadroom(name)` is
//      false; otherwise try `adapter.subscribeBook(...)`. Success
//      → `allocator.claim(symbol, name)`.
//   3. If no adapter accepted, the manager calls
//      `allocator.recordDenied(symbol, reason)` and returns null
//      from subscribeBook.
//
// Preemption (priority policy by working-order age / cumulative
// notional / signal-to-fill latency, per the TDD's §10.3 list) is
// deferred until the working-order monitor (QF-47 / QF-48) exists to
// feed the comparator. `PriorityComparator` is wired so future
// tickets only need to drop in the real implementation; v1 ships
// with `NoopComparator`.

import { Counter, Registry } from "prom-client";

// ── Public types ──────────────────────────────────────────────────────

// QF-205 reconciled the taxonomy with the original QF-28 ticket:
//   * no_source                              — no adapter exposes subscribeBook
//   * all_sources_full_no_preemption_won     — every source at budget AND
//                                              no current claim was
//                                              successfully preempted
//   * preempted                              — displaced consumer
//
// `no_capacity` (the v1 shipped name) is retained as a deprecated alias
// in the type so existing dashboards keep parsing, but new emissions
// use the full name.
export type BookDenyReason =
  | "no_source"
  | "all_sources_full_no_preemption_won"
  | "preempted"
  | "no_capacity";

export interface BookBudgetConfig {
  // Per-source caps. A source absent from the map is uncapped.
  // Example: { schwab: 100, ibkr: 3 } — Schwab gets 100 concurrent L2
  // streams (their published cap); IBKR retail gets 3.
  limits: Readonly<Record<string, number>>;
}

// Per-symbol metadata the priority comparator uses to rank candidates
// for preemption. Working-order monitor (QF-204) fills this in via
// getBookCandidate(symbol). Symbols without any working order yield
// null and aren't considered for preemption.
export interface BookCandidate {
  symbol: string;
  working_age_ms: number;
  working_notional_usd: number;
}

export interface PriorityComparator {
  // Return negative if `a` should preempt `b`; positive if `b` should
  // win; 0 if neither preempts the other.
  compare(a: BookCandidate, b: BookCandidate): number;
}

export const NoopComparator: PriorityComparator = {
  compare(): number {
    return 0;
  },
};

// QF-205 — concrete priority comparator. Tiered per the original QF-28
// allocation algorithm:
//   1. Orders working > 30s outrank orders working <= 30s.
//   2. Within a tier, larger cumulative working notional wins.
//   3. Ties stay 0 (round-robin handled outside).
//
// signal-to-fill latency target (QF-28 tier 3) is intentionally not yet
// used — there's no live data feed for that target. Add it when an
// execution-profile field surfaces it.
const URGENT_AGE_MS = 30_000;

export const WorkingOrderPriorityComparator: PriorityComparator = {
  compare(a, b) {
    const aUrgent = a.working_age_ms > URGENT_AGE_MS;
    const bUrgent = b.working_age_ms > URGENT_AGE_MS;
    if (aUrgent && !bUrgent) return -1;
    if (bUrgent && !aUrgent) return 1;
    if (a.working_notional_usd > b.working_notional_usd) return -1;
    if (b.working_notional_usd > a.working_notional_usd) return 1;
    return 0;
  },
};

// ── Metrics ───────────────────────────────────────────────────────────

export interface BookBudgetMetrics {
  registry: Registry;
  // marketdata_book_budget_denied_total{symbol, reason}
  // The Execution Layer's §9 metric table lists this metric for
  // completeness; it lives here because the market-data layer owns it.
  bookBudgetDeniedTotal: Counter<"symbol" | "reason">;
  // QF-222 — marketdata_book_budget_reevaluation_reclaim_total{symbol}
  // Increments when a previously-preempted consumer successfully
  // reclaims an L2 slot via the 60s re-evaluation loop. Useful to
  // validate the loop is doing anything; should stay near zero unless
  // working-order priority churn is high.
  bookBudgetReevaluationReclaimTotal: Counter<"symbol">;
}

export function createBookBudgetMetrics(registry?: Registry): BookBudgetMetrics {
  const reg = registry ?? new Registry();
  const bookBudgetDeniedTotal = new Counter({
    name: "marketdata_book_budget_denied_total",
    help: "L2 book request denied due to source unavailability, budget exhaustion, or preemption.",
    labelNames: ["symbol", "reason"] as const,
    registers: [reg],
  });
  const bookBudgetReevaluationReclaimTotal = new Counter({
    name: "marketdata_book_budget_reevaluation_reclaim_total",
    help: "Previously-preempted L2 subscription successfully reclaimed via the re-evaluation loop.",
    labelNames: ["symbol"] as const,
    registers: [reg],
  });
  return { registry: reg, bookBudgetDeniedTotal, bookBudgetReevaluationReclaimTotal };
}

// ── Allocator ─────────────────────────────────────────────────────────

export interface BookBudgetAllocator {
  // True if `source` is under its limit (or uncapped). Sync — the
  // subscription manager calls this in the inner loop while walking
  // adapters, no awaits.
  hasHeadroom(source: string): boolean;
  // Account for a new allocation. Idempotent: re-calling with the
  // same (symbol, source) is a no-op (allows the subscription
  // manager's dedup path to re-claim without double-counting).
  claim(symbol: string, source: string): void;
  // Drop the slot a previous claim() reserved. Idempotent.
  release(symbol: string): void;
  // Increment the deny metric for `symbol` with `reason`. Called by
  // the subscription manager on full denial (no adapter accepted).
  recordDenied(symbol: string, reason: BookDenyReason): void;
  // Read-only snapshot of per-source usage. Tests + future /metrics.
  usage(): Readonly<Record<string, number>>;
  // QF-205 — snapshot of (symbol → source) for current claims. The
  // subscription manager uses this to enumerate preemption candidates
  // for a source that's at budget.
  claims(): Readonly<Record<string, string>>;
}

export interface BookBudgetAllocatorOpts {
  config: BookBudgetConfig;
  metrics: BookBudgetMetrics;
  comparator?: PriorityComparator;
}

export function createBookBudgetAllocator(opts: BookBudgetAllocatorOpts): BookBudgetAllocator {
  const used = new Map<string, number>();
  const symbolToSource = new Map<string, string>();

  function inc(source: string): void {
    used.set(source, (used.get(source) ?? 0) + 1);
  }
  function dec(source: string): void {
    const cur = used.get(source) ?? 0;
    if (cur > 0) used.set(source, cur - 1);
  }

  return {
    hasHeadroom(source: string): boolean {
      const limit = opts.config.limits[source];
      if (limit === undefined) return true; // uncapped
      const cur = used.get(source) ?? 0;
      return cur < limit;
    },

    claim(symbol: string, source: string): void {
      const existing = symbolToSource.get(symbol);
      if (existing === source) return; // idempotent
      if (existing !== undefined) {
        // Symbol previously bound to a different source; release the
        // old slot before claiming the new one. This is the
        // preemption-handoff path (caller has decided the swap is
        // worth it; allocator just bookkeeps).
        dec(existing);
      }
      symbolToSource.set(symbol, source);
      inc(source);
    },

    release(symbol: string): void {
      const source = symbolToSource.get(symbol);
      if (source === undefined) return; // idempotent
      symbolToSource.delete(symbol);
      dec(source);
    },

    recordDenied(symbol: string, reason: BookDenyReason): void {
      opts.metrics.bookBudgetDeniedTotal.inc({ symbol, reason });
    },

    usage(): Readonly<Record<string, number>> {
      return Object.fromEntries(used);
    },

    claims(): Readonly<Record<string, string>> {
      return Object.fromEntries(symbolToSource);
    },
  };
}
