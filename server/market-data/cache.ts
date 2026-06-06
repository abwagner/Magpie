// ── Market Data Cache ──────────────────────────────────────────────
// In-memory TTL + LRU cache for market data responses.
// Defined in: docs/tdd/market-data.md, topic 3

import type { CacheConfig } from "../../src/types/market-data.js";

// ── Types ──────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expires_at: number;
  inserted_at: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
}

export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  invalidate(key: string): void;
  stats(): CacheStats;
  clear(): void;
}

// ── Implementation ─────────────────────────────────────────────────

export function createCache(config: CacheConfig): Cache {
  const store = new Map<string, CacheEntry<unknown>>();
  let hits = 0;
  let misses = 0;

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expires_at <= now) {
        store.delete(key);
      }
    }
  }

  function evictLRU(): void {
    // Remove oldest entry by insertion time
    if (store.size <= config.max_entries) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of store) {
      if (entry.inserted_at < oldestTime) {
        oldestTime = entry.inserted_at;
        oldestKey = key;
      }
    }

    if (oldestKey) store.delete(oldestKey);
  }

  return {
    get<T>(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) {
        misses++;
        return undefined;
      }
      if (entry.expires_at <= Date.now()) {
        store.delete(key);
        misses++;
        return undefined;
      }
      // Update insertion time for LRU
      entry.inserted_at = Date.now();
      hits++;
      return entry.value as T;
    },

    set<T>(key: string, value: T, ttlMs: number): void {
      const now = Date.now();
      store.set(key, {
        value,
        expires_at: now + ttlMs,
        inserted_at: now,
      });

      // Evict if over capacity
      if (store.size > config.max_entries) {
        evictExpired();
        evictLRU();
      }
    },

    invalidate(key: string): void {
      store.delete(key);
    },

    stats(): CacheStats {
      return { hits, misses, entries: store.size };
    },

    clear(): void {
      store.clear();
      hits = 0;
      misses = 0;
    },
  };
}

// ── Cache key helpers ──────────────────────────────────────────────
//
// Optional `source` namespacing (M13-07): during the M13 dual-track
// observation window two adapters (legacy + nt-bridge) may serve the
// same underlying broker for comparison. Callers that want per-source
// cache slots pass `source` explicitly; callers that don't (the existing
// service-level lookup) keep the legacy unscoped key for back-compat.
// Per docs/tdd/broker-integration.md §5.

export function quoteKey(symbol: string, source?: string): string {
  return source ? `getQuote:${source}:${symbol}` : `getQuote:${symbol}`;
}

export function chainKey(symbol: string, expiration: string, source?: string): string {
  return source ? `getChain:${source}:${symbol}:${expiration}` : `getChain:${symbol}:${expiration}`;
}

export function expirationsKey(symbol: string, source?: string): string {
  return source ? `getExpirations:${source}:${symbol}` : `getExpirations:${symbol}`;
}

export function candlesKey(
  symbol: string,
  from: string,
  to: string,
  frequency: string,
  source?: string,
): string {
  return source
    ? `getCandles:${source}:${symbol}:${from}:${to}:${frequency}`
    : `getCandles:${symbol}:${from}:${to}:${frequency}`;
}
