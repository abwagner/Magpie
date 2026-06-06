// ── Data Quality Gate ──────────────────────────────────────────────
// Pure function: checks whether market data is fresh enough to act on.
// Each consumer enforces independently — no centralized service.
// Defined in: docs/tdd/market-data.md, topic 5

import type { DataMeta, FreshnessCheck, FreshnessThresholds } from "../../src/types/market-data.js";

export function isDataFresh(
  meta: DataMeta,
  thresholds: FreshnessThresholds,
  dataType: "quote" | "chain" = "quote",
): FreshnessCheck {
  // When market is closed, freshness is irrelevant
  if (thresholds.marketOpen === false) {
    return { fresh: true };
  }

  const maxAge = dataType === "quote" ? thresholds.max_quote_age_ms : thresholds.max_chain_age_ms;

  // Total age = time since source produced the data
  let totalAgeMs: number;

  if (meta.from_cache && meta.freshness_ms !== null) {
    // Cached data: source freshness + cache age
    totalAgeMs = meta.freshness_ms + meta.cache_age_ms;
  } else if (meta.freshness_ms !== null) {
    totalAgeMs = meta.freshness_ms;
  } else {
    // No source timestamp available — use latency as a proxy
    totalAgeMs = meta.latency_ms;
  }

  if (totalAgeMs > maxAge) {
    return {
      fresh: false,
      reason: `Data age ${totalAgeMs}ms exceeds threshold ${maxAge}ms (source: ${meta.source}, cached: ${meta.from_cache})`,
    };
  }

  return { fresh: true };
}
