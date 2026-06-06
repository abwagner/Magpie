// Tests for the QF-29 per-symbol-watcher backpressure helpers.
// Direct unit tests on the push* functions; the integration tests
// (queue + drain + flushPending) live in subscriptions.test.ts.

import { describe, it, expect, vi } from "vitest";
import {
  createBackpressureMetrics,
  createEventQueue,
  pushBook,
  pushQuote,
  pushTrade,
} from "../../backpressure.js";
import { createLogger } from "../../../logger.js";
import type { L2Book, Quote, TradePrint } from "../../../../src/types/market-data.js";

interface MetricValue {
  value?: number;
  labels?: Record<string, string>;
}
interface MetricJson {
  name: string;
  values?: MetricValue[];
}

async function getDropCount(
  metrics: ReturnType<typeof createBackpressureMetrics>,
  symbol?: string,
  kind?: string,
): Promise<number> {
  const all = (await metrics.registry.getMetricsAsJSON()) as MetricJson[];
  const entry = all.find((x) => x.name === "marketdata_subscription_dropped_events_total");
  if (!entry?.values) return 0;
  return entry.values
    .filter((v) => (symbol ? v.labels?.symbol === symbol : true))
    .filter((v) => (kind ? v.labels?.kind === kind : true))
    .reduce((acc, v) => acc + (v.value ?? 0), 0);
}

function makeQuote(bid: number, ask: number): Quote {
  return {
    symbol: "SPY",
    bid,
    ask,
    mid: (bid + ask) / 2,
    last: (bid + ask) / 2,
    volume: 0,
    timestamp: "2026-05-18T16:00:00.000Z",
    _meta: {
      source: "test",
      source_timestamp: null,
      fetched_at: "2026-05-18T16:00:00.000Z",
      freshness_ms: null,
      latency_ms: 0,
      from_cache: false,
      cache_age_ms: 0,
      sources_tried: ["test"],
    },
  };
}

function makeTrade(price: number): TradePrint {
  return { ts: "2026-05-18T16:00:00.000Z", price, size: 1 };
}

function makeBook(level: number): L2Book {
  return {
    ts: "2026-05-18T16:00:00.000Z",
    bids: [{ price: level, size: 1 }],
    asks: [{ price: level + 0.01, size: 1 }],
  };
}

const log = createLogger("backpressure-test", "error");

// ── Quote: drop oldest ────────────────────────────────────────────────

describe("pushQuote — drop oldest when queue exceeds max_queue_depth", () => {
  it("keeps quotes under the depth limit", () => {
    const queue = createEventQueue();
    const metrics = createBackpressureMetrics();
    for (let i = 0; i < 3; i++) {
      pushQuote(queue, makeQuote(450 + i, 451 + i), {
        symbol: "SPY",
        config: { max_queue_depth: 5 },
        metrics,
      });
    }
    expect(queue.quotes).toHaveLength(3);
  });

  it("drops the oldest when the queue is full", async () => {
    const queue = createEventQueue();
    const metrics = createBackpressureMetrics();
    for (let i = 0; i < 7; i++) {
      pushQuote(queue, makeQuote(450 + i, 451 + i), {
        symbol: "SPY",
        config: { max_queue_depth: 3 },
        metrics,
      });
    }
    // Depth=3 cap, pushed 7 → 4 drops.
    expect(queue.quotes).toHaveLength(3);
    expect(await getDropCount(metrics, "SPY", "quote")).toBe(4);
    // The retained quotes are the most recent ones (indices 4, 5, 6).
    expect(queue.quotes[0]!.bid).toBe(454);
    expect(queue.quotes[2]!.bid).toBe(456);
  });
});

// ── Trade: never drop ─────────────────────────────────────────────────

describe("pushTrade — never drop", () => {
  it("retains every trade regardless of depth", async () => {
    const queue = createEventQueue();
    const metrics = createBackpressureMetrics();
    for (let i = 0; i < 100; i++) {
      pushTrade(queue, makeTrade(450 + i), {
        symbol: "SPY",
        config: { max_queue_depth: 5 },
        metrics,
      });
    }
    expect(queue.trades).toHaveLength(100);
    expect(await getDropCount(metrics, "SPY", "trade")).toBe(0);
  });

  it("warns when the trade queue exceeds depth (operator visibility)", () => {
    const queue = createEventQueue();
    const warnSpy = vi.fn();
    const fakeLogger = {
      ...log,
      warn: warnSpy,
    } as unknown as ReturnType<typeof createLogger>;
    for (let i = 0; i < 7; i++) {
      pushTrade(queue, makeTrade(450 + i), {
        symbol: "SPY",
        config: { max_queue_depth: 3 },
        logger: fakeLogger,
      });
    }
    // 4 of those 7 exceeded the depth → 4 warn calls.
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });
});

// ── Book: coalesce ────────────────────────────────────────────────────

describe("pushBook — coalesce (drop pending older books)", () => {
  it("replaces any pending book with the newest one", async () => {
    const queue = createEventQueue();
    const metrics = createBackpressureMetrics();
    for (let i = 0; i < 5; i++) {
      pushBook(queue, makeBook(450 + i), {
        symbol: "SPY",
        config: { max_queue_depth: 50 },
        metrics,
      });
    }
    // Queue always holds at most the latest book.
    expect(queue.books).toHaveLength(1);
    expect(queue.books[0]!.bids[0]!.price).toBe(454);
    // 4 prior books were dropped during coalescing.
    expect(await getDropCount(metrics, "SPY", "book")).toBe(4);
  });
});
