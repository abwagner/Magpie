// ── Market-Data Adapter Metrics ────────────────────────────────────
//
// In-memory metrics collector for `/api/data/sources/health` (QF-55).
// Tracks per-adapter call count, error count, latency percentiles
// (sliding window), last error, and source-router fallback events.
// All data is process-local; nothing is persisted. The wrapper
// `wrapAdapterWithMetrics` is the only integration point — services
// wrap adapters at factory time and `tryInOrder` doesn't need to
// know metrics exist.

import type { MarketDataAdapter } from "../../src/types/market-data.js";

// Sliding window size for latency percentiles. ~1k samples is plenty
// for stable p50/p99 at typical request rates and stays cheap to sort.
const LATENCY_WINDOW = 1000;
// Cap on fallback-event ring so a flapping source doesn't grow memory.
const FALLBACK_RING = 64;

interface AdapterStats {
  calls: number;
  errors: number;
  latencies: number[]; // ring buffer
  lastCallAt?: number;
  lastSuccessAt?: number;
  lastError?: { ts: number; method: string; message: string };
}

export interface AdapterHealthSummary {
  source: string;
  calls: number;
  errors: number;
  /** errors / calls; 0 when no calls. */
  error_rate: number;
  /** Latency p50 in ms over the recent window, null when no samples. */
  p50_ms: number | null;
  /** Latency p99 in ms over the recent window, null when no samples. */
  p99_ms: number | null;
  /** ISO-8601; most recent call attempt (success or failure). */
  last_call_at?: string;
  /** ISO-8601; most recent successful call. */
  last_success_at?: string;
  /** Most recent failure with method + reason. */
  last_error?: { ts: string; method: string; message: string };
}

export interface FallbackEvent {
  ts: string;
  /** Adapter that failed. */
  from: string;
  /** Adapter the source-router fell back to. */
  to: string;
  /** Method that triggered the fallback. */
  method: string;
}

export interface MetricsRegistry {
  record(source: string, method: string, latencyMs: number, ok: boolean, errorMsg?: string): void;
  recordFallback(from: string, to: string, method: string): void;
  snapshot(): AdapterHealthSummary[];
  recentFallbacks(): FallbackEvent[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[rank] ?? null;
}

export function createMetricsRegistry(): MetricsRegistry {
  const byAdapter = new Map<string, AdapterStats>();
  const fallbacks: FallbackEvent[] = [];

  function get(source: string): AdapterStats {
    let s = byAdapter.get(source);
    if (!s) {
      s = { calls: 0, errors: 0, latencies: [] };
      byAdapter.set(source, s);
    }
    return s;
  }

  return {
    record(source, method, latencyMs, ok, errorMsg) {
      const s = get(source);
      const now = Date.now();
      s.calls += 1;
      s.lastCallAt = now;
      // Ring-buffer latencies so memory stays bounded.
      if (s.latencies.length >= LATENCY_WINDOW) s.latencies.shift();
      s.latencies.push(latencyMs);
      if (ok) {
        s.lastSuccessAt = now;
      } else {
        s.errors += 1;
        s.lastError = { ts: now, method, message: errorMsg ?? "unknown error" };
      }
    },

    recordFallback(from, to, method) {
      if (fallbacks.length >= FALLBACK_RING) fallbacks.shift();
      fallbacks.push({ ts: new Date().toISOString(), from, to, method });
    },

    snapshot() {
      return [...byAdapter.entries()].map(([source, s]): AdapterHealthSummary => {
        const sorted = [...s.latencies].sort((a, b) => a - b);
        return {
          source,
          calls: s.calls,
          errors: s.errors,
          error_rate: s.calls === 0 ? 0 : s.errors / s.calls,
          p50_ms: percentile(sorted, 50),
          p99_ms: percentile(sorted, 99),
          last_call_at: s.lastCallAt ? new Date(s.lastCallAt).toISOString() : undefined,
          last_success_at: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : undefined,
          last_error: s.lastError
            ? {
                ts: new Date(s.lastError.ts).toISOString(),
                method: s.lastError.method,
                message: s.lastError.message,
              }
            : undefined,
        };
      });
    },

    recentFallbacks() {
      // Return newest-first so the UI shows recent activity at the top.
      return [...fallbacks].reverse();
    },
  };
}

// ── Adapter wrapper ───────────────────────────────────────────────
//
// Intercepts every adapter method call to record latency + outcome.
// `tryInOrder` continues to call adapters through this wrapper without
// caring that metrics are being collected; that keeps the metrics
// concern out of the source-selection logic.

type AsyncFn = (...args: unknown[]) => Promise<unknown>;

const INSTRUMENTED_METHODS = [
  "available",
  "stockQuote",
  "expirations",
  "chain",
  "historicalChain",
  "candles",
] as const;

export function wrapAdapterWithMetrics(
  adapter: MarketDataAdapter,
  registry: MetricsRegistry,
): MarketDataAdapter {
  const wrapped: Record<string, unknown> = { ...adapter };
  for (const method of INSTRUMENTED_METHODS) {
    const original = (adapter as unknown as Record<string, unknown>)[method];
    if (typeof original !== "function") continue;
    const fn = original.bind(adapter) as AsyncFn;
    wrapped[method] = async (...args: unknown[]) => {
      const start = Date.now();
      try {
        const result = await fn(...args);
        const latency = Date.now() - start;
        // `available()` returning false is a real signal worth recording
        // as a failure for error-rate math; everything else returning
        // null is treated as a soft no-data outcome (still recorded as
        // ok=true because the adapter didn't throw — matches how
        // tryInOrder distinguishes "returned null" from "threw").
        if (method === "available" && result === false) {
          registry.record(adapter.name, method, latency, false, "not available");
        } else {
          registry.record(adapter.name, method, latency, true);
        }
        return result;
      } catch (err) {
        const latency = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        registry.record(adapter.name, method, latency, false, message);
        throw err;
      }
    };
  }
  return wrapped as unknown as MarketDataAdapter;
}
