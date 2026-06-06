// ── Source Router ──────────────────────────────────────────────────
// Dynamic routing cache that learns which adapter works for a given
// (symbol, method) pair. After the first successful request, subsequent
// requests skip straight to the known-good adapter.
//
// Transparent to callers — injected into tryInOrder as optional dep.

// ── Types ─────────────────────────────────────────────────────────

interface RouteEntry {
  adapter: string;
  lastSuccess: number; // epoch ms
  failCount: number; // consecutive fails since last success
}

interface SourceRouterOpts {
  /** Evict preferred adapter after this many consecutive failures. Default: 3. */
  maxFailures?: number;
  /** Expire route entries after this many ms of no use. Default: 1 hour. */
  ttlMs?: number;
}

// ── Implementation ────────────────────────────────────────────────

export interface SourceRouter {
  getPreferred(key: string): string | null;
  recordSuccess(key: string, adapter: string): void;
  recordFailure(key: string, adapter: string): void;
  /** Build a route key from method + symbol. */
  routeKey(method: string, symbol: string, extra?: string): string;
  /** Number of cached routes (for diagnostics). */
  size(): number;
  /** All current routes (for diagnostics). */
  entries(): Array<{ key: string; adapter: string; failCount: number; ageMs: number }>;
}

export function createSourceRouter(opts: SourceRouterOpts = {}): SourceRouter {
  const maxFailures = opts.maxFailures ?? 3;
  const ttlMs = opts.ttlMs ?? 3_600_000; // 1 hour
  const cache = new Map<string, RouteEntry>();

  function isExpired(entry: RouteEntry): boolean {
    return Date.now() - entry.lastSuccess > ttlMs;
  }

  return {
    getPreferred(key: string): string | null {
      const entry = cache.get(key);
      if (!entry) return null;
      if (isExpired(entry)) {
        cache.delete(key);
        return null;
      }
      if (entry.failCount >= maxFailures) {
        cache.delete(key);
        return null;
      }
      return entry.adapter;
    },

    recordSuccess(key: string, adapter: string): void {
      cache.set(key, {
        adapter,
        lastSuccess: Date.now(),
        failCount: 0,
      });
    },

    recordFailure(key: string, adapter: string): void {
      const entry = cache.get(key);
      if (entry && entry.adapter === adapter) {
        entry.failCount++;
      }
      // Don't create a new entry on failure — only success creates routes
    },

    routeKey(method: string, symbol: string, extra?: string): string {
      return extra ? `${method}:${symbol}:${extra}` : `${method}:${symbol}`;
    },

    size(): number {
      return cache.size;
    },

    entries(): Array<{ key: string; adapter: string; failCount: number; ageMs: number }> {
      const now = Date.now();
      return [...cache.entries()].map(([key, entry]) => ({
        key,
        adapter: entry.adapter,
        failCount: entry.failCount,
        ageMs: now - entry.lastSuccess,
      }));
    },
  };
}
