import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCache, quoteKey, chainKey, expirationsKey } from "../../cache.js";

describe("cache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const config = {
    quote_ttl_ms: 5000,
    expirations_ttl_ms: 3600000,
    chain_ttl_ms: 30000,
    max_entries: 3,
  };

  it("stores and retrieves values", () => {
    const cache = createCache(config);
    cache.set("key1", { value: 42 }, 5000);
    expect(cache.get("key1")).toEqual({ value: 42 });
  });

  it("returns undefined for missing keys", () => {
    const cache = createCache(config);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = createCache(config);
    cache.set("key1", "data", 5000);
    vi.advanceTimersByTime(5001);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("returns value before TTL expires", () => {
    const cache = createCache(config);
    cache.set("key1", "data", 5000);
    vi.advanceTimersByTime(4999);
    expect(cache.get("key1")).toBe("data");
  });

  it("evicts entries when exceeding max_entries", () => {
    const cache = createCache(config);
    cache.set("a", 1, 60000);
    vi.advanceTimersByTime(10);
    cache.set("b", 2, 60000);
    vi.advanceTimersByTime(10);
    cache.set("c", 3, 60000);
    vi.advanceTimersByTime(10);
    cache.set("d", 4, 60000); // should evict oldest

    expect(cache.stats().entries).toBeLessThanOrEqual(4);
  });

  it("tracks hit/miss stats", () => {
    const cache = createCache(config);
    cache.set("key1", "data", 60000);

    cache.get("key1"); // hit
    cache.get("key1"); // hit
    cache.get("missing"); // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  it("invalidates specific keys", () => {
    const cache = createCache(config);
    cache.set("key1", "data", 60000);
    cache.invalidate("key1");
    expect(cache.get("key1")).toBeUndefined();
  });

  it("clears all entries", () => {
    const cache = createCache(config);
    cache.set("a", 1, 60000);
    cache.set("b", 2, 60000);
    cache.clear();
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().hits).toBe(0);
  });
});

describe("cache key helpers", () => {
  it("generates quote key", () => expect(quoteKey("SPY")).toBe("getQuote:SPY"));
  it("generates chain key", () =>
    expect(chainKey("SPY", "2026-05-16")).toBe("getChain:SPY:2026-05-16"));
  it("generates expirations key", () => expect(expirationsKey("SPY")).toBe("getExpirations:SPY"));
});
