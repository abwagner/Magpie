// ── Source Selection / Fallback ────────────────────────────────────
// Tries adapters in priority order, returns first success.
// Defined in: docs/tdd/market-data.md, topic 2

import type { MarketDataAdapter } from "../../src/types/market-data.js";
import type { Logger } from "../logger.js";
import type { SourceRouter } from "./source-router.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SourceResult<T> {
  ok: true;
  data: T;
  source: string;
  latency_ms: number;
}

export interface SourceFailure {
  ok: false;
  sources_tried: Array<{ source: string; reason: string; latency_ms: number }>;
}

type SourceResponse<T> = SourceResult<T> | SourceFailure;

// ── tryInOrder ─────────────────────────────────────────────────────

export async function tryInOrder<T>(
  adapters: MarketDataAdapter[],
  method: (adapter: MarketDataAdapter) => Promise<T | null>,
  logger: Logger,
  timeoutMs: number = 10000,
  router?: SourceRouter,
  routeKey?: string,
): Promise<SourceResponse<T>> {
  const sourcesTried: Array<{ source: string; reason: string; latency_ms: number }> = [];

  // Build ordered adapter list: preferred adapter first (if known), then rest
  let ordered = adapters;
  if (router && routeKey) {
    const preferred = router.getPreferred(routeKey);
    if (preferred) {
      const preferredAdapter = adapters.find((a) => a.name === preferred);
      if (preferredAdapter) {
        ordered = [preferredAdapter, ...adapters.filter((a) => a.name !== preferred)];
        logger.debug("Source router: preferred adapter", { routeKey, preferred });
      }
    }
  }

  for (const adapter of ordered) {
    const start = Date.now();
    try {
      const available = await adapter.available();
      if (!available) {
        sourcesTried.push({
          source: adapter.name,
          reason: "unavailable",
          latency_ms: Date.now() - start,
        });
        if (router && routeKey) router.recordFailure(routeKey, adapter.name);
        continue;
      }

      const result = await Promise.race([
        method(adapter),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);

      const latency = Date.now() - start;

      if (result === null) {
        sourcesTried.push({ source: adapter.name, reason: "returned null", latency_ms: latency });
        if (router && routeKey) router.recordFailure(routeKey, adapter.name);
        continue;
      }

      if (router && routeKey) router.recordSuccess(routeKey, adapter.name);
      return { ok: true, data: result, source: adapter.name, latency_ms: latency };
    } catch (err) {
      const latency = Date.now() - start;
      const reason = err instanceof Error ? err.message : String(err);
      sourcesTried.push({ source: adapter.name, reason, latency_ms: latency });
      if (router && routeKey) router.recordFailure(routeKey, adapter.name);
      logger.warn("Market data source failed", {
        source: adapter.name,
        reason,
        latency_ms: latency,
      });
    }
  }

  return { ok: false, sources_tried: sourcesTried };
}
