import { describe, it, expect } from "vitest";
import { isDataFresh } from "../../quality-gate.js";
import type { DataMeta, FreshnessThresholds } from "../../../../src/types/market-data.js";

function makeMeta(overrides: Partial<DataMeta> = {}): DataMeta {
  return {
    source: "marketdata",
    source_timestamp: null,
    fetched_at: new Date().toISOString(),
    freshness_ms: 500,
    latency_ms: 500,
    from_cache: false,
    cache_age_ms: 0,
    sources_tried: ["marketdata"],
    ...overrides,
  };
}

const thresholds: FreshnessThresholds = {
  max_quote_age_ms: 60000,
  max_chain_age_ms: 300000,
};

describe("quality-gate", () => {
  it("returns fresh for fresh data", () => {
    const result = isDataFresh(makeMeta({ freshness_ms: 500 }), thresholds);
    expect(result.fresh).toBe(true);
  });

  it("returns stale when data exceeds threshold", () => {
    const result = isDataFresh(makeMeta({ freshness_ms: 61000 }), thresholds);
    expect(result.fresh).toBe(false);
    expect(result.reason).toContain("exceeds threshold");
  });

  it("considers cache age for cached data", () => {
    const result = isDataFresh(
      makeMeta({ from_cache: true, freshness_ms: 30000, cache_age_ms: 35000 }),
      thresholds,
    );
    // Total age: 30000 + 35000 = 65000 > 60000
    expect(result.fresh).toBe(false);
  });

  it("uses chain threshold for chain data type", () => {
    const result = isDataFresh(makeMeta({ freshness_ms: 100000 }), thresholds, "chain");
    // 100000 < 300000
    expect(result.fresh).toBe(true);
  });

  it("always returns fresh when market is closed", () => {
    const result = isDataFresh(makeMeta({ freshness_ms: 999999 }), {
      ...thresholds,
      marketOpen: false,
    });
    expect(result.fresh).toBe(true);
  });

  it("uses latency as proxy when freshness_ms is null", () => {
    const result = isDataFresh(makeMeta({ freshness_ms: null, latency_ms: 500 }), thresholds);
    expect(result.fresh).toBe(true);
  });
});
