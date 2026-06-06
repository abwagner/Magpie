// ── MarketData.app Adapter ─────────────────────────────────────────
// Refactored from data-sources.js + marketdata-api.js server-side calls.
// Defined in: docs/tdd/market-data.md, topic 3

import type {
  MarketDataAdapter,
  Quote,
  Contract,
  Candle,
  QuoteCallback,
  Subscription,
} from "../../../src/types/market-data.js";
import {
  rawStockQuote,
  rawExpirations,
  rawChain,
  rawHistoricalChain,
} from "../../../src/lib/marketdata-api.js";
import { isFutures } from "../../../src/lib/symbols.js";

// ── Types ──────────────────────────────────────────────────────────

interface MarketDataAppConfig {
  timeout_ms?: number;
}

// ── Factory ────────────────────────────────────────────────────────

export function createAdapter(config: MarketDataAppConfig = {}): MarketDataAdapter {
  function getToken(): string {
    return process.env.MD_TOKEN ?? "";
  }

  return {
    name: "marketdata",

    async available(): Promise<boolean> {
      return !!getToken();
    },

    async stockQuote(symbol: string): Promise<Quote | null> {
      const token = getToken();
      if (!token) return null;
      if (isFutures(symbol)) return null; // MarketData.app has no futures endpoint

      const raw = await rawStockQuote(symbol, token);
      return {
        symbol,
        bid: raw.bid ?? 0,
        ask: raw.ask ?? 0,
        mid: raw.mid ?? 0,
        last: raw.last ?? 0,
        volume: raw.volume ?? 0,
        timestamp: new Date().toISOString(),
        _meta: {
          source: "marketdata",
          source_timestamp: null,
          fetched_at: new Date().toISOString(),
          freshness_ms: null,
          latency_ms: 0,
          from_cache: false,
          cache_age_ms: 0,
          sources_tried: ["marketdata"],
        },
      };
    },

    async expirations(symbol: string): Promise<string[] | null> {
      const token = getToken();
      if (!token || isFutures(symbol)) return null;
      return rawExpirations(symbol, token);
    },

    async chain(symbol: string, expiration: string): Promise<Contract[] | null> {
      const token = getToken();
      if (!token || isFutures(symbol)) return null;
      return rawChain(symbol, expiration, token) as Promise<Contract[]>;
    },

    async historicalChain(
      symbol: string,
      date: string,
      expiration: string,
    ): Promise<Contract[] | null> {
      const token = getToken();
      if (!token || isFutures(symbol)) return null;
      return rawHistoricalChain(symbol, date, expiration, token) as Promise<Contract[]>;
    },

    async candles(
      symbol: string,
      from: string,
      to: string,
      frequency: "daily" | "minute" = "daily",
    ): Promise<Candle[] | null> {
      const token = getToken();
      if (!token) return null;

      try {
        const resolution = frequency === "minute" ? "1" : "D";
        const fromTs = Math.floor(new Date(from).getTime() / 1000);
        const toTs = Math.floor(new Date(to).getTime() / 1000);

        const res = await fetch(
          `https://api.marketdata.app/v1/stocks/candles/${resolution}/${symbol}?from=${fromTs}&to=${toTs}`,
          { headers: { Authorization: `Token ${token}` } },
        );

        if (!res.ok) return null;

        const data = (await res.json()) as {
          s: string;
          o: number[];
          h: number[];
          l: number[];
          c: number[];
          v: number[];
          t: number[];
        };

        if (data.s !== "ok" || !data.t?.length) return null;

        return data.t.map((ts, i) => ({
          date:
            frequency === "daily"
              ? new Date(ts * 1000).toISOString().slice(0, 10)
              : new Date(ts * 1000).toISOString(),
          open: data.o[i] ?? 0,
          high: data.h[i] ?? 0,
          low: data.l[i] ?? 0,
          close: data.c[i] ?? 0,
          volume: data.v[i] ?? 0,
        }));
      } catch {
        return null;
      }
    },

    subscribeQuotes(_symbols: string[], _callback: QuoteCallback): Subscription | null {
      // MarketData.app does not support streaming
      return null;
    },
  };
}
