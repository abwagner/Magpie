// ── Databento Live Market Data Adapter ────────────────────────────
// Consumes live ticks from a Python sidecar via NATS. Databento has no
// Node SDK, so the architecture is:
//   [databento_live.py sidecar] --NATS--> [this adapter] --> consumers
//
// Sidecar publishes:
//   marketdata.live.databento.<SYMBOL>      // one record per message
//   marketdata.live.databento.heartbeat     // every 30s when alive
//
// available() returns true iff we've seen a heartbeat in the last
// HEARTBEAT_STALE_MS window. Without a heartbeat, the service falls
// through to the next adapter (IBKR, MarketData.app).
//
// Defined in: docs/UNIVERSES.md (live whitelist)

import type { NatsConnection, Subscription as NatsSubscription } from "nats";
import { StringCodec } from "nats";
import type {
  MarketDataAdapter,
  Quote,
  Contract,
  QuoteCallback,
  Subscription,
} from "../../../src/types/market-data.js";
import { isFutures } from "../../../src/lib/symbols.js";

// ── Constants ──────────────────────────────────────────────────────

const SUBJECT_PREFIX = "marketdata.live.databento";
const HEARTBEAT_STALE_MS = 60_000; // 2× the sidecar interval
const QUOTE_STALE_MS = 30_000; // tolerable per-symbol staleness

// ── Types ──────────────────────────────────────────────────────────

interface DatabentoConfig {
  nc?: NatsConnection;
  subject_prefix?: string;
}

interface CachedQuote {
  bid: number;
  ask: number;
  last: number;
  volume: number;
  ts_ms: number;
}

interface SidecarPayload {
  ts: string | null;
  dataset: string;
  schema: string;
  symbol: string;
  record_type: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  bid_px?: number;
  ask_px?: number;
  bid_sz?: number;
  ask_sz?: number;
  price?: number;
  size?: number;
  side?: string;
}

// ── Symbol mapping ─────────────────────────────────────────────────

// `/ES` (UI form) ↔ `ES.c.0` (Databento continuous front-month).
// The adapter accepts both; the cache always keys on the Databento form
// so the NATS subject and the cache lookup line up.
export function toDatabentoSymbol(input: string): string {
  if (input.endsWith(".c.0")) return input;
  if (isFutures(input)) {
    const root = input.replace(/^[./]+/, "").toUpperCase();
    return `${root}.c.0`;
  }
  // Equities: use as-is (Databento uses raw_symbol for those).
  return input.toUpperCase();
}

// ── Factory ────────────────────────────────────────────────────────

export function createAdapter(config: DatabentoConfig = {}): MarketDataAdapter {
  const subjectPrefix = config.subject_prefix ?? SUBJECT_PREFIX;
  const sc = StringCodec();

  const quoteCache = new Map<string, CachedQuote>();
  const callbacksBySymbol = new Map<string, Set<QuoteCallback>>();
  let lastHeartbeatMs = 0;
  let natsSubAll: NatsSubscription | null = null;

  function ingest(symbol: string, payload: SidecarPayload): void {
    const now = Date.now();
    const cached = quoteCache.get(symbol) ?? { bid: 0, ask: 0, last: 0, volume: 0, ts_ms: 0 };

    if (payload.bid_px !== undefined) cached.bid = payload.bid_px;
    if (payload.ask_px !== undefined) cached.ask = payload.ask_px;
    if (payload.price !== undefined) cached.last = payload.price; // trades
    if (payload.close !== undefined) cached.last = payload.close; // ohlcv
    if (payload.volume !== undefined) cached.volume = payload.volume;
    cached.ts_ms = now;

    quoteCache.set(symbol, cached);

    const callbacks = callbacksBySymbol.get(symbol);
    if (callbacks?.size) {
      const quote: Quote = {
        symbol,
        bid: cached.bid,
        ask: cached.ask,
        mid: cached.bid && cached.ask ? (cached.bid + cached.ask) / 2 : cached.last,
        last: cached.last,
        volume: cached.volume,
        timestamp: new Date(now).toISOString(),
        _meta: buildMeta(),
      };
      for (const cb of callbacks) {
        try {
          cb(symbol, quote);
        } catch {
          /* consumer error — don't poison the stream */
        }
      }
    }
  }

  function buildMeta(): Quote["_meta"] {
    const now = new Date().toISOString();
    return {
      source: "databento",
      source_timestamp: null,
      fetched_at: now,
      freshness_ms: null,
      latency_ms: 0,
      from_cache: true,
      cache_age_ms: 0,
      sources_tried: ["databento"],
    };
  }

  async function startNatsSubscription(): Promise<void> {
    if (!config.nc || natsSubAll) return;
    natsSubAll = config.nc.subscribe(`${subjectPrefix}.>`);
    (async () => {
      for await (const msg of natsSubAll!) {
        const lastToken = msg.subject.split(".").pop()!;
        if (lastToken === "heartbeat") {
          lastHeartbeatMs = Date.now();
          continue;
        }
        try {
          const payload = JSON.parse(sc.decode(msg.data)) as SidecarPayload;
          ingest(payload.symbol, payload);
        } catch {
          // Malformed payload — skip.
        }
      }
    })().catch(() => {
      natsSubAll = null;
    });
  }

  // Kick off the subscription immediately; if NATS isn't ready it'll be a no-op.
  void startNatsSubscription();

  return {
    name: "databento",

    async available(): Promise<boolean> {
      if (!config.nc || config.nc.isClosed()) return false;
      if (lastHeartbeatMs === 0) return false;
      return Date.now() - lastHeartbeatMs < HEARTBEAT_STALE_MS;
    },

    async stockQuote(symbol: string): Promise<Quote | null> {
      const dbSym = toDatabentoSymbol(symbol);
      const cached = quoteCache.get(dbSym);
      if (!cached) return null;
      const ageMs = Date.now() - cached.ts_ms;
      if (ageMs > QUOTE_STALE_MS) return null;
      return {
        symbol,
        bid: cached.bid,
        ask: cached.ask,
        mid: cached.bid && cached.ask ? (cached.bid + cached.ask) / 2 : cached.last,
        last: cached.last,
        volume: cached.volume,
        timestamp: new Date(cached.ts_ms).toISOString(),
        _meta: { ...buildMeta(), cache_age_ms: ageMs },
      };
    },

    async expirations(_symbol: string): Promise<string[] | null> {
      // Live data here is for futures front-month quotes/trades, not options.
      return null;
    },

    async chain(_symbol: string, _expiration: string): Promise<Contract[] | null> {
      return null;
    },

    async historicalChain(
      _symbol: string,
      _date: string,
      _expiration: string,
    ): Promise<Contract[] | null> {
      // Historical pulls go through pipelines/databento_fetch.py and land
      // in Parquet — not served via this live adapter.
      return null;
    },

    subscribeQuotes(symbols: string[], callback: QuoteCallback): Subscription | null {
      const mappedSymbols = symbols.map(toDatabentoSymbol);
      for (const sym of mappedSymbols) {
        const set = callbacksBySymbol.get(sym) ?? new Set();
        set.add(callback);
        callbacksBySymbol.set(sym, set);
      }
      return {
        unsubscribe: () => {
          for (const sym of mappedSymbols) {
            const set = callbacksBySymbol.get(sym);
            set?.delete(callback);
            if (set && set.size === 0) callbacksBySymbol.delete(sym);
          }
        },
      };
    },
  };
}
