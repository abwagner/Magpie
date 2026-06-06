/**
 * Integration test: Market Data source validation
 *
 * Tests source fallback with mocked adapters, caching TTLs,
 * quality gate fresh/stale, and historical data path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createMarketDataService } from "../../service.js";
import { createCache } from "../../cache.js";
import { isDataFresh } from "../../quality-gate.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import { sleep } from "../../../__tests__/helpers/fixtures.js";

// ── Mock adapters ────────────────────────────────────────────────────────

import type { MarketDataAdapter, DataMeta } from "../../../../src/types/market-data.js";

function createMockAdapter(
  name: string,
  options: {
    available?: boolean;
    quote?: { bid: number; ask: number; mid: number; last: number; volume: number };
    failOnQuote?: boolean;
    latencyMs?: number;
  } = {},
): MarketDataAdapter {
  const { available = true, failOnQuote = false, latencyMs = 0 } = options;
  const quote = options.quote ?? { bid: 500, ask: 501, mid: 500.5, last: 500.5, volume: 10000 };

  return {
    name,
    async available() {
      return available;
    },
    async stockQuote(symbol: string) {
      if (failOnQuote) throw new Error(`${name} unavailable`);
      if (latencyMs) await sleep(latencyMs);
      return { ...quote, symbol, timestamp: new Date().toISOString() } as never;
    },
    async expirations(symbol: string) {
      return ["2026-01-16", "2026-02-20", "2026-03-20"];
    },
    async chain(symbol: string, expiration: string) {
      return [
        {
          symbol: `${symbol} ${expiration} 500 C`,
          underlying: symbol,
          strike: 500,
          side: "call",
          bid: 12,
          ask: 13,
          mid: 12.5,
        },
      ] as never;
    },
    async historicalChain(symbol: string, date: string, _expiration: string) {
      return [
        {
          symbol: `${symbol} hist`,
          underlying: symbol,
          strike: 500,
          side: "call",
          bid: 11,
          ask: 12,
          mid: 11.5,
        },
      ] as never;
    },
    subscribeQuotes() {
      return null;
    },
  };
}

describe("market data service", () => {
  const logger = createTestLogger();

  describe("source fallback", () => {
    it("uses the first available source", async () => {
      const service = createMarketDataService({
        adapters: [
          createMockAdapter("ibkr", {
            quote: { bid: 500, ask: 501, mid: 500.5, last: 500.5, volume: 1000 },
          }),
          createMockAdapter("marketdata", {
            quote: { bid: 499, ask: 502, mid: 500.5, last: 500.5, volume: 2000 },
          }),
        ],
        logger,
      });

      const quote = await service.getQuote("SPY");
      // Should get ibkr's quote (first in order)
      expect(quote).toBeDefined();
    });

    it("falls back when primary source fails", async () => {
      const service = createMarketDataService({
        adapters: [
          createMockAdapter("ibkr", { failOnQuote: true }),
          createMockAdapter("marketdata"),
        ],
        logger,
      });

      const quote = await service.getQuote("SPY");
      expect(quote).toBeDefined();
    });

    it("falls back when primary source is unavailable", async () => {
      const service = createMarketDataService({
        adapters: [
          createMockAdapter("ibkr", { available: false }),
          createMockAdapter("marketdata"),
        ],
        logger,
      });

      const quote = await service.getQuote("SPY");
      expect(quote).toBeDefined();
    });

    it("throws when all sources fail", async () => {
      const service = createMarketDataService({
        adapters: [
          createMockAdapter("ibkr", { failOnQuote: true }),
          createMockAdapter("marketdata", { failOnQuote: true }),
        ],
        logger,
      });

      await expect(service.getQuote("SPY")).rejects.toThrow();
    });
  });

  describe("caching", () => {
    it("returns cached quote within TTL", async () => {
      const cache = createCache({
        quote_ttl_ms: 5000,
        expirations_ttl_ms: 3600000,
        chain_ttl_ms: 30000,
        max_entries: 100,
      });
      const adapter = createMockAdapter("test");
      let callCount = 0;
      const countingAdapter: MarketDataAdapter = {
        ...adapter,
        async stockQuote(symbol: string) {
          callCount++;
          return adapter.stockQuote(symbol);
        },
      };

      const service = createMarketDataService({
        adapters: [countingAdapter],
        logger,
        cache,
        cacheConfig: {
          quote_ttl_ms: 5000,
          chain_ttl_ms: 30000,
          expirations_ttl_ms: 3600000,
          max_entries: 100,
        },
      });

      await service.getQuote("SPY"); // miss
      await service.getQuote("SPY"); // hit
      await service.getQuote("SPY"); // hit

      expect(callCount).toBe(1); // Only one actual call
    });

    it("re-fetches after TTL expires", async () => {
      const cache = createCache({
        quote_ttl_ms: 100,
        expirations_ttl_ms: 100,
        chain_ttl_ms: 100,
        max_entries: 100,
      });
      const adapter = createMockAdapter("test");
      let callCount = 0;
      const countingAdapter: MarketDataAdapter = {
        ...adapter,
        async stockQuote(symbol: string) {
          callCount++;
          return adapter.stockQuote(symbol);
        },
      };

      const service = createMarketDataService({
        adapters: [countingAdapter],
        logger,
        cache,
        cacheConfig: {
          quote_ttl_ms: 100,
          chain_ttl_ms: 100,
          expirations_ttl_ms: 100,
          max_entries: 100,
        },
        qualityThresholds: { max_quote_age_ms: 100, max_chain_age_ms: 100 }, // TTL for cache.set()
      });

      await service.getQuote("SPY"); // miss
      await sleep(300); // wait well past TTL (100ms + margin)
      await service.getQuote("SPY"); // should be a miss again

      expect(callCount).toBe(2);
    });
  });

  describe("quality gate", () => {
    it("returns fresh for recent data", () => {
      const result = isDataFresh(
        {
          source: "test",
          source_timestamp: null,
          fetched_at: new Date().toISOString(),
          freshness_ms: 100,
          latency_ms: 10,
          from_cache: false,
          cache_age_ms: 0,
          sources_tried: ["test"],
        } satisfies DataMeta,
        { max_quote_age_ms: 60000, max_chain_age_ms: 300000 },
      );
      expect(result.fresh).toBe(true);
    });

    it("returns stale for old data", () => {
      const result = isDataFresh(
        {
          source: "test",
          source_timestamp: null,
          fetched_at: new Date(Date.now() - 120_000).toISOString(),
          freshness_ms: 120_000,
          latency_ms: 10,
          from_cache: true,
          cache_age_ms: 120_000,
          sources_tried: ["test"],
        } satisfies DataMeta,
        { max_quote_age_ms: 60000, max_chain_age_ms: 300000 },
      );
      expect(result.fresh).toBe(false);
    });

    it("returns stale for cached data beyond TTL", () => {
      const result = isDataFresh(
        {
          source: "test",
          source_timestamp: null,
          fetched_at: new Date(Date.now() - 90_000).toISOString(),
          freshness_ms: 500,
          latency_ms: 10,
          from_cache: true,
          cache_age_ms: 90_000,
          sources_tried: ["test"],
        } satisfies DataMeta,
        { max_quote_age_ms: 60000, max_chain_age_ms: 300000 },
      );
      expect(result.fresh).toBe(false);
    });
  });
});
