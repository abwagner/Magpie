import { describe, it, expect } from "vitest";
import { createMarketDataService } from "../../service.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type { MarketDataAdapter } from "../../../../src/types/market-data.js";

function mockAdapter(
  name: string,
  opts: {
    failOnQuote?: boolean;
    quote?: Record<string, unknown>;
  } = {},
): MarketDataAdapter {
  return {
    name,
    async available() {
      return !opts.failOnQuote;
    },
    async stockQuote(symbol: string) {
      if (opts.failOnQuote) throw new Error(`${name} unavailable`);
      return {
        bid: 500,
        ask: 501,
        mid: 500.5,
        last: 500.5,
        volume: 10000,
        symbol,
        ...(opts.quote ?? {}),
      } as never;
    },
    async expirations() {
      return ["2026-06-19"];
    },
    async chain() {
      return [{ strike: 500, side: "call" }] as never;
    },
    async historicalChain() {
      return null;
    },
    subscribeQuotes() {
      return null;
    },
  };
}

describe("market data service", () => {
  const logger = createTestLogger();

  it("uses primary adapter when available", async () => {
    const service = createMarketDataService({
      adapters: [mockAdapter("primary"), mockAdapter("fallback")],
      logger,
    });
    const quote = await service.getQuote("SPY");
    expect(quote).toBeDefined();
    expect(quote._meta?.source).toBe("primary");
  });

  it("falls back when primary fails", async () => {
    const service = createMarketDataService({
      adapters: [mockAdapter("primary", { failOnQuote: true }), mockAdapter("fallback")],
      logger,
    });
    const quote = await service.getQuote("SPY");
    expect(quote._meta?.source).toBe("fallback");
  });

  it("throws when all adapters fail", async () => {
    const service = createMarketDataService({
      adapters: [mockAdapter("a", { failOnQuote: true }), mockAdapter("b", { failOnQuote: true })],
      logger,
    });
    await expect(service.getQuote("SPY")).rejects.toThrow(/All market data sources failed/);
  });

  it("caches quotes within TTL", async () => {
    let callCount = 0;
    const counting: MarketDataAdapter = {
      ...mockAdapter("counter"),
      async stockQuote(symbol: string) {
        callCount++;
        return { bid: 500, ask: 501, mid: 500.5, last: 500.5, volume: 10000, symbol } as never;
      },
    };

    const service = createMarketDataService({
      adapters: [counting],
      logger,
      cacheConfig: {
        quote_ttl_ms: 60000,
        expirations_ttl_ms: 60000,
        chain_ttl_ms: 60000,
        max_entries: 100,
      },
    });

    await service.getQuote("SPY");
    await service.getQuote("SPY");
    expect(callCount).toBe(1); // second call served from cache
  });

  it("getFreshness returns unfresh when no prior fetch", () => {
    const service = createMarketDataService({
      adapters: [mockAdapter("test")],
      logger,
    });
    const check = service.getFreshness("SPY");
    expect(check.fresh).toBe(false);
  });

  it("getFreshness returns fresh after successful fetch", async () => {
    const service = createMarketDataService({
      adapters: [mockAdapter("test")],
      logger,
    });
    await service.getQuote("SPY");
    const check = service.getFreshness("SPY");
    expect(check.fresh).toBe(true);
  });
});
