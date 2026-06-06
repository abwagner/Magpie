// ── Market-data backpressure ──────────────────────────────────────────
// Per-symbol-watcher event queues + drop policy on bursty streams.
//
// Spec: docs/data/market-data.md §10.4
//
// Policy by event kind:
//   quote → drop oldest when queue > max_queue_depth
//           (latest quote is the only one that matters)
//   trade → NEVER drop; log a warning + continue
//           (each print is a potential fill trigger / audit data point)
//   book  → coalesce; drop pending books for the same symbol when a
//           newer one arrives
//           (latest L2 snapshot is sufficient)
//
// The manager invokes one of `pushQuote / pushTrade / pushBook` per
// incoming event; the policy-aware push applies the drop rules,
// increments the per-symbol drop metric, and schedules an async drain
// via `queueMicrotask`. `flushPending()` lets tests drain
// synchronously between an emit and an assertion.

import { Counter, Registry } from "prom-client";
import type { L2Book, Quote, TradePrint } from "../../src/types/market-data.js";
import type { Logger } from "../logger.js";

// ── Metrics ───────────────────────────────────────────────────────────

export interface BackpressureMetrics {
  registry: Registry;
  // marketdata_subscription_dropped_events_total{symbol, kind}
  // kind ∈ {"quote", "book"} are operational. kind="trade" never fires
  // (we don't drop trades by policy); it stays in the label set for
  // schema stability but should always be 0.
  droppedEventsTotal: Counter<"symbol" | "kind">;
}

export function createBackpressureMetrics(registry?: Registry): BackpressureMetrics {
  const reg = registry ?? new Registry();
  const droppedEventsTotal = new Counter({
    name: "marketdata_subscription_dropped_events_total",
    help: "Per-symbol-watcher event drops under the backpressure policy. kind=trade alerts.",
    labelNames: ["symbol", "kind"] as const,
    registers: [reg],
  });
  return { registry: reg, droppedEventsTotal };
}

// ── Queue ─────────────────────────────────────────────────────────────

// Per-symbol queue holding the events that are buffered between
// upstream emit and consumer fan-out.
export interface EventQueue {
  quotes: Quote[];
  trades: TradePrint[];
  books: L2Book[];
  drain_scheduled: boolean;
}

export function createEventQueue(): EventQueue {
  return {
    quotes: [],
    trades: [],
    books: [],
    drain_scheduled: false,
  };
}

// ── Push (with drop policy) ───────────────────────────────────────────

export interface BackpressureConfig {
  // Hard cap on queue depth per event kind. When 0 the queue is
  // effectively disabled — callers should bypass the queue entirely
  // and fan out synchronously (manager-level decision; the helpers
  // here assume depth ≥ 1 when invoked).
  max_queue_depth: number;
}

export interface PushDeps {
  symbol: string;
  config: BackpressureConfig;
  metrics?: BackpressureMetrics;
  logger?: Logger;
}

export function pushQuote(queue: EventQueue, quote: Quote, deps: PushDeps): void {
  queue.quotes.push(quote);
  // Drop oldest while over depth. In practice this only runs once per
  // push (the head we just appended is the new tail; the head we drop
  // is the prior front of the queue), but the while-loop tolerates
  // upstream bursts that race past the next drain.
  while (queue.quotes.length > deps.config.max_queue_depth) {
    queue.quotes.shift();
    deps.metrics?.droppedEventsTotal.inc({ symbol: deps.symbol, kind: "quote" });
  }
}

export function pushTrade(queue: EventQueue, trade: TradePrint, deps: PushDeps): void {
  queue.trades.push(trade);
  // Never drop. Warn when over depth so the operator sees that a
  // consumer is too slow for the trade rate — a real problem because
  // every print is potentially fill data the strategy needs.
  if (queue.trades.length > deps.config.max_queue_depth) {
    deps.logger?.warn("trade queue exceeded max_queue_depth — keeping all (audit data)", {
      symbol: deps.symbol,
      depth: queue.trades.length,
      max: deps.config.max_queue_depth,
    });
  }
}

export function pushBook(queue: EventQueue, book: L2Book, deps: PushDeps): void {
  // Coalesce: any pending book is stale once we get a newer one.
  // Count every coalesced book as a drop so the metric reflects
  // "this consumer can't keep up with the L2 update rate."
  if (queue.books.length > 0) {
    const dropped = queue.books.length;
    queue.books.length = 0;
    deps.metrics?.droppedEventsTotal.inc({ symbol: deps.symbol, kind: "book" }, dropped);
  }
  queue.books.push(book);
}
