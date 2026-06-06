// ── Market Data Service ────────────────────────────────────────────
// Unified market data interface with caching, fallback, and metadata.
// Defined in: docs/tdd/market-data.md, topic 1

import type {
  Quote,
  Contract,
  Candle,
  DataMeta,
  MarketDataAdapter,
  MarketDataService,
  QuoteCallback,
  Subscription,
  FreshnessCheck,
  CacheConfig,
} from "../../src/types/market-data.js";
import {
  type Cache,
  createCache,
  quoteKey,
  chainKey,
  expirationsKey,
  candlesKey,
} from "./cache.js";
import { tryInOrder } from "./sources.js";
import { isDataFresh } from "./quality-gate.js";
import { createSourceRouter } from "./source-router.js";
import { type MetricsRegistry, wrapAdapterWithMetrics } from "./metrics.js";
import type { Logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface MarketDataServiceDeps {
  adapters: MarketDataAdapter[];
  logger: Logger;
  cache?: Cache;
  cacheConfig?: CacheConfig;
  qualityThresholds?: {
    max_quote_age_ms: number;
    max_chain_age_ms: number;
  };
  /**
   * Optional metrics registry (QF-55). When provided, each adapter call
   * gets wrapped so latency / error / fallback data is recorded for
   * `/api/data/sources/health`. The caller owns the registry so the
   * same instance can be passed to the API layer's health endpoint.
   */
  metrics?: MetricsRegistry;
}

// ── Factory ────────────────────────────────────────────────────────

export function createMarketDataService(deps: MarketDataServiceDeps): MarketDataService {
  const logger = deps.logger;
  const cache =
    deps.cache ??
    createCache(
      deps.cacheConfig ?? {
        quote_ttl_ms: 5000,
        expirations_ttl_ms: 3600000,
        chain_ttl_ms: 30000,
        max_entries: 10000,
      },
    );
  // Wrap each adapter so the metrics registry sees every call. Wrapping
  // here (rather than at adapter construction) keeps the metrics
  // concern out of the adapter implementations and out of tryInOrder.
  const adapters = deps.metrics
    ? deps.adapters.map((a) => wrapAdapterWithMetrics(a, deps.metrics!))
    : deps.adapters;
  const router = createSourceRouter();
  const thresholds = deps.qualityThresholds ?? {
    max_quote_age_ms: 60000,
    max_chain_age_ms: 300000,
  };

  // Track freshness per symbol
  const freshnessMap = new Map<string, DataMeta>();

  function buildMeta(
    source: string,
    latencyMs: number,
    sourcesTried: string[],
    fromCache: boolean = false,
    cacheAgeMs: number = 0,
  ): DataMeta {
    const now = new Date().toISOString();
    return {
      source,
      source_timestamp: null,
      fetched_at: now,
      freshness_ms: latencyMs,
      latency_ms: latencyMs,
      from_cache: fromCache,
      cache_age_ms: cacheAgeMs,
      sources_tried: sourcesTried,
    };
  }

  async function getQuote(symbol: string): Promise<Quote> {
    const cacheK = quoteKey(symbol);
    const cached = cache.get<Quote>(cacheK);
    if (cached) return cached;

    const result = await tryInOrder<Quote>(adapters, (a) => a.stockQuote(symbol), logger);

    if (!result.ok) {
      throw new Error(
        `All market data sources failed for quote ${symbol}: ${JSON.stringify(result.sources_tried)}`,
      );
    }

    const meta = buildMeta(result.source, result.latency_ms, [result.source]);
    const quote: Quote = { ...result.data, _meta: meta };
    freshnessMap.set(symbol, meta);
    cache.set(cacheK, quote, thresholds.max_quote_age_ms);
    return quote;
  }

  async function getExpirations(symbol: string): Promise<string[]> {
    const cacheK = expirationsKey(symbol);
    const cached = cache.get<string[]>(cacheK);
    if (cached) return cached;

    const result = await tryInOrder<string[]>(adapters, (a) => a.expirations(symbol), logger);

    if (!result.ok) {
      throw new Error(`All sources failed for expirations ${symbol}`);
    }

    cache.set(cacheK, result.data, 3600000);
    return result.data;
  }

  async function getChain(symbol: string, expiration: string): Promise<Contract[]> {
    const cacheK = chainKey(symbol, expiration);
    const cached = cache.get<Contract[]>(cacheK);
    if (cached) return cached;

    const result = await tryInOrder<Contract[]>(
      adapters,
      (a) => a.chain(symbol, expiration),
      logger,
    );

    if (!result.ok) {
      throw new Error(`All sources failed for chain ${symbol}/${expiration}`);
    }

    cache.set(cacheK, result.data, thresholds.max_chain_age_ms);
    return result.data;
  }

  async function getHistoricalChain(
    symbol: string,
    date: string,
    expiration: string,
  ): Promise<Contract[]> {
    const result = await tryInOrder<Contract[]>(
      adapters,
      (a) => a.historicalChain(symbol, date, expiration),
      logger,
    );

    if (!result.ok) {
      throw new Error(`All sources failed for historical chain ${symbol}/${date}/${expiration}`);
    }

    return result.data;
  }

  function subscribeQuotes(symbols: string[], callback: QuoteCallback): Subscription {
    // Try to find an adapter that supports streaming
    const intervals: ReturnType<typeof setInterval>[] = [];

    for (const sym of symbols) {
      // Polling fallback
      const interval = setInterval(async () => {
        try {
          const quote = await getQuote(sym);
          callback(sym, quote);
        } catch {
          // Swallow — logged by tryInOrder
        }
      }, 5000);
      intervals.push(interval);
    }

    return {
      unsubscribe: () => {
        for (const iv of intervals) clearInterval(iv);
      },
    };
  }

  async function getCandles(
    symbol: string,
    from: string,
    to: string,
    frequency: "daily" | "minute" = "daily",
  ): Promise<Candle[]> {
    const cacheK = candlesKey(symbol, from, to, frequency);
    const cached = cache.get(cacheK) as Candle[] | undefined;
    if (cached) return cached;

    // Only try adapters that implement candles
    const candleAdapters = adapters.filter((a) => typeof a.candles === "function");
    const rk = router.routeKey("candles", symbol);

    const result = await tryInOrder<Candle[]>(
      candleAdapters,
      (a) => a.candles!(symbol, from, to, frequency),
      logger,
      10000,
      router,
      rk,
    );

    if (!result.ok) {
      throw new Error(`All sources failed for candles ${symbol} ${from}→${to}`);
    }

    const ttl = frequency === "daily" ? 3_600_000 : 30_000;
    cache.set(cacheK, result.data, ttl);
    return result.data;
  }

  function getFreshness(symbol: string): FreshnessCheck {
    const meta = freshnessMap.get(symbol);
    if (!meta) {
      return { fresh: false, reason: "No data fetched yet" };
    }
    return isDataFresh(meta, { ...thresholds, marketOpen: undefined });
  }

  return {
    getQuote,
    getExpirations,
    getChain,
    getHistoricalChain,
    getCandles,
    subscribeQuotes,
    getFreshness,
  };
}
