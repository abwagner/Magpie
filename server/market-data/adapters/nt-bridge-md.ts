// ── NT-bridge Market-Data Adapter ─────────────────────────────────────
// TS-side client for the QF↔Python MD-bridge NATS contract. The Python
// MD bridge (research/magpie-md-bridge/) is the server; this is
// the TS adapter that slots into mdAdapterList alongside the existing
// schwab.ts / ibkr.ts / databento.ts / marketdata.ts adapters.
//
// Wire-format + subject layout: docs/tdd/broker-integration.md §3.
// Sibling of server/order/adapters/nt-bridge.ts (QF-233) — same NATS-RPC
// + pub/sub split, same broker-suffixed subjects.
//
// QF-252 (M13-04).

import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type {
  BookCallback,
  Candle,
  Contract,
  MarketDataAdapter,
  Quote,
  QuoteCallback,
  Subscription,
  TradeCallback,
} from "../../../src/types/market-data.js";
import type { Logger } from "../../logger.js";
import type { AlertRouter } from "../../alerts/router.js";
import { marketdata } from "../../../src/types/subjects.js";

// ── Config ─────────────────────────────────────────────────────────

export interface NtBridgeMdConfig {
  // "schwab" | "ibkr" — the suffix on the NATS subjects.
  broker: string;
  // Per-RPC reply timeouts. Tracks the defaults documented in
  // docs/tdd/broker-integration.md §3.4.
  quoteTimeoutMs?: number;
  expirationsTimeoutMs?: number;
  chainTimeoutMs?: number;
  historicalChainTimeoutMs?: number;
  candlesTimeoutMs?: number;
  // Adapter marks itself unhealthy if no heartbeat in > this. Defaults
  // to 30s per TDD §3.1.
  heartbeatStaleMs?: number;
}

export interface NtBridgeMdAdapter extends MarketDataAdapter {
  // QF-336 — set the alert router after construction (for bridge heartbeat
  // unavailable/recovered alerts). Called from server/index.ts after the
  // alertRouter is created.
  setAlertRouter(router: AlertRouter): void;
  // QF-341 — exact age (ms) since the last heartbeat, or null if none has
  // ever been seen. Replaces the QF-296 health-endpoint stub that returned
  // null unconditionally (TDD §4.2). Reads the same closure `available()`
  // uses, so the liveness number and the routing decision never diverge.
  lastHeartbeatAgeMs(): number | null;
}

const DEFAULT_QUOTE_TIMEOUT_MS = 2_000;
const DEFAULT_EXPIRATIONS_TIMEOUT_MS = 5_000;
const DEFAULT_CHAIN_TIMEOUT_MS = 5_000;
const DEFAULT_HISTORICAL_CHAIN_TIMEOUT_MS = 10_000;
const DEFAULT_CANDLES_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_STALE_MS = 30_000;

// ── Reply envelopes ────────────────────────────────────────────────

type ErrorCode =
  | "not_supported"
  | "upstream_unavailable"
  | "auth_failed"
  | "rate_limited"
  | "internal";

interface ErrorFrame {
  code: ErrorCode;
  message: string;
}

interface QuoteReply {
  quote?: Quote;
  error?: ErrorFrame;
}

interface ExpirationsReply {
  expirations?: string[];
  error?: ErrorFrame;
}

interface ChainReply {
  chain?: Contract[];
  error?: ErrorFrame;
}

interface CandlesReply {
  candles?: Candle[];
  error?: ErrorFrame;
}

interface HeartbeatPayload {
  broker: string;
  ts: string;
  last_upstream_success_ts?: string;
}

// ── Subscription manager (per-stream fan-out) ──────────────────────

type StreamKind = "quotes" | "trades" | "book";

interface FanoutEntry<T> {
  callbacks: Set<T>;
  closer: () => void;
}

// ── Factory ────────────────────────────────────────────────────────

export function createNtBridgeMdAdapter(
  nc: NatsConnection,
  config: NtBridgeMdConfig,
  logger: Logger,
): NtBridgeMdAdapter {
  const broker = config.broker;
  const quoteTimeoutMs = config.quoteTimeoutMs ?? DEFAULT_QUOTE_TIMEOUT_MS;
  const expirationsTimeoutMs = config.expirationsTimeoutMs ?? DEFAULT_EXPIRATIONS_TIMEOUT_MS;
  const chainTimeoutMs = config.chainTimeoutMs ?? DEFAULT_CHAIN_TIMEOUT_MS;
  const historicalChainTimeoutMs =
    config.historicalChainTimeoutMs ?? DEFAULT_HISTORICAL_CHAIN_TIMEOUT_MS;
  const candlesTimeoutMs = config.candlesTimeoutMs ?? DEFAULT_CANDLES_TIMEOUT_MS;
  const heartbeatStaleMs = config.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;

  const sc = StringCodec();
  let lastHeartbeatMs = 0;
  let bridgeWasAvailable = false;
  let alertRouter: AlertRouter | undefined;

  // Per-(stream, symbol) fan-out registries. Multiple consumers can
  // subscribe to the same symbol; we hold one upstream NATS sub per
  // (stream, symbol) and tear it down only when the last consumer
  // unregisters (idempotent unsubscribe per TDD §4).
  const quoteFanouts = new Map<string, FanoutEntry<QuoteCallback>>();
  const tradeFanouts = new Map<string, FanoutEntry<TradeCallback>>();
  const bookFanouts = new Map<string, FanoutEntry<BookCallback>>();

  // ── Heartbeat ──
  const heartbeatSub = nc.subscribe(marketdata.heartbeat(broker));
  void (async () => {
    for await (const msg of heartbeatSub) {
      try {
        const hb = JSON.parse(sc.decode(msg.data)) as HeartbeatPayload;
        const now = Date.now();
        lastHeartbeatMs = now;
        logger.debug("nt-bridge-md: heartbeat", {
          broker,
          last_upstream_success_ts: hb.last_upstream_success_ts,
        });
        // Fire bridge.recovered alert on transition from unavailable → available
        if (!bridgeWasAvailable && alertRouter) {
          bridgeWasAvailable = true;
          void alertRouter
            .record({
              type: `bridge.recovered.${broker}`,
              level: "info",
              message: `Bridge ${broker} recovered — heartbeat received`,
              payload: {
                broker,
              },
            })
            .catch((err) => {
              logger.warn("nt-bridge-md: bridge recovered alert failed", {
                error: String(err),
                broker,
              });
            });
        }
      } catch (err) {
        logger.warn("nt-bridge-md: malformed heartbeat payload", {
          broker,
          error: String(err),
        });
      }
    }
  })();

  // ── Heartbeat stale monitor ──
  // Check periodically if the bridge has become unavailable (no heartbeat
  // within heartbeatStaleMs). Fire bridge.unavailable alert on transition.
  void (async () => {
    while (!nc.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Check every 5 seconds
      if (lastHeartbeatMs === 0) continue; // Skip until first heartbeat
      const now = Date.now();
      const isNowAvailable = now - lastHeartbeatMs <= heartbeatStaleMs;
      if (bridgeWasAvailable && !isNowAvailable) {
        bridgeWasAvailable = false;
        if (alertRouter) {
          void alertRouter
            .record({
              type: `bridge.unavailable.${broker}`,
              level: "warning",
              message: `Bridge ${broker} unavailable — no heartbeat for ${heartbeatStaleMs}ms`,
              payload: {
                broker,
                heartbeat_stale_ms: heartbeatStaleMs,
                last_heartbeat_age_ms: now - lastHeartbeatMs,
              },
            })
            .catch((err) => {
              logger.warn("nt-bridge-md: bridge unavailable alert failed", {
                error: String(err),
                broker,
              });
            });
        }
      }
    }
  })();

  // ── RPC helper ──
  async function requestJson<T>(subject: string, payload: unknown, timeoutMs: number): Promise<T> {
    const msg = await nc.request(subject, sc.encode(JSON.stringify(payload)), {
      timeout: timeoutMs,
    });
    return JSON.parse(sc.decode(msg.data)) as T;
  }

  // Returns null on timeout or error frame — service layer's tryInOrder
  // moves on to the next adapter. Hard errors throw upstream; we keep
  // null reserved for "this adapter can't serve right now."
  async function safeRequest<T>(
    method: string,
    subject: string,
    payload: unknown,
    timeoutMs: number,
    extractPayload: (reply: T) => unknown,
    extractError: (reply: T) => ErrorFrame | undefined,
  ): Promise<unknown | null> {
    try {
      const reply = await requestJson<T>(subject, payload, timeoutMs);
      const err = extractError(reply);
      if (err) {
        logger.debug("nt-bridge-md: rpc returned error frame", {
          broker,
          method,
          code: err.code,
          message: err.message,
        });
        return null;
      }
      const result = extractPayload(reply);
      return result === undefined ? null : result;
    } catch (err) {
      logger.warn("nt-bridge-md: rpc failed", {
        broker,
        method,
        error: String(err),
      });
      return null;
    }
  }

  // ── Streaming fan-out builder ──
  function makeStreamSubject(stream: StreamKind, symbol: string): string {
    return marketdata.stream(stream, broker, symbol);
  }

  function ensureQuoteFanout(symbol: string): FanoutEntry<QuoteCallback> {
    let entry = quoteFanouts.get(symbol);
    if (entry) return entry;
    const sub = nc.subscribe(makeStreamSubject("quotes", symbol));
    const callbacks = new Set<QuoteCallback>();
    void (async () => {
      for await (const msg of sub) {
        try {
          const quote = JSON.parse(sc.decode(msg.data)) as Quote;
          for (const cb of callbacks) cb(symbol, quote);
        } catch (err) {
          logger.warn("nt-bridge-md: malformed quote payload", {
            broker,
            symbol,
            error: String(err),
          });
        }
      }
    })();
    entry = {
      callbacks,
      closer: () => sub.unsubscribe(),
    };
    quoteFanouts.set(symbol, entry);
    return entry;
  }

  function ensureTradeFanout(symbol: string): FanoutEntry<TradeCallback> {
    let entry = tradeFanouts.get(symbol);
    if (entry) return entry;
    const sub = nc.subscribe(makeStreamSubject("trades", symbol));
    const callbacks = new Set<TradeCallback>();
    void (async () => {
      for await (const msg of sub) {
        try {
          const trade = JSON.parse(sc.decode(msg.data));
          for (const cb of callbacks) cb(symbol, trade);
        } catch (err) {
          logger.warn("nt-bridge-md: malformed trade payload", {
            broker,
            symbol,
            error: String(err),
          });
        }
      }
    })();
    entry = {
      callbacks,
      closer: () => sub.unsubscribe(),
    };
    tradeFanouts.set(symbol, entry);
    return entry;
  }

  function ensureBookFanout(symbol: string): FanoutEntry<BookCallback> {
    let entry = bookFanouts.get(symbol);
    if (entry) return entry;
    const sub = nc.subscribe(makeStreamSubject("book", symbol));
    const callbacks = new Set<BookCallback>();
    void (async () => {
      for await (const msg of sub) {
        try {
          const book = JSON.parse(sc.decode(msg.data));
          for (const cb of callbacks) cb(symbol, book);
        } catch (err) {
          logger.warn("nt-bridge-md: malformed book payload", {
            broker,
            symbol,
            error: String(err),
          });
        }
      }
    })();
    entry = {
      callbacks,
      closer: () => sub.unsubscribe(),
    };
    bookFanouts.set(symbol, entry);
    return entry;
  }

  // Generic subscription helper. Registers `callback` against each
  // requested symbol's fan-out; returns a single Subscription that
  // unregisters all of them idempotently. Tears down the upstream NATS
  // sub when the last callback for a symbol unregisters.
  function makeStreamSubscription<TCb>(
    symbols: readonly string[],
    ensure: (symbol: string) => FanoutEntry<TCb>,
    map: Map<string, FanoutEntry<TCb>>,
    callback: TCb,
  ): Subscription {
    const registered: string[] = [];
    for (const symbol of symbols) {
      const entry = ensure(symbol);
      entry.callbacks.add(callback);
      registered.push(symbol);
    }
    let active = true;
    return {
      unsubscribe(): void {
        if (!active) return;
        active = false;
        for (const symbol of registered) {
          const entry = map.get(symbol);
          if (!entry) continue;
          entry.callbacks.delete(callback);
          if (entry.callbacks.size === 0) {
            entry.closer();
            map.delete(symbol);
          }
        }
      },
    };
  }

  // ── Adapter implementation ──
  return {
    name: `nt-bridge/${broker}`,

    async available(): Promise<boolean> {
      if (nc.isClosed()) return false;
      // Healthy iff we've seen a heartbeat in the last `heartbeatStaleMs`.
      // First-boot grace: if we've never seen a heartbeat, treat as
      // unavailable so the service layer falls through to a legacy
      // adapter rather than blocking on RPC timeouts.
      if (lastHeartbeatMs === 0) return false;
      return Date.now() - lastHeartbeatMs <= heartbeatStaleMs;
    },

    async stockQuote(symbol: string): Promise<Quote | null> {
      const result = await safeRequest<QuoteReply>(
        "quote",
        marketdata.rpc.quote(broker),
        { symbol },
        quoteTimeoutMs,
        (r) => r.quote,
        (r) => r.error,
      );
      return result as Quote | null;
    },

    async expirations(symbol: string): Promise<string[] | null> {
      const result = await safeRequest<ExpirationsReply>(
        "expirations",
        marketdata.rpc.expirations(broker),
        { symbol },
        expirationsTimeoutMs,
        (r) => r.expirations,
        (r) => r.error,
      );
      return result as string[] | null;
    },

    async chain(symbol: string, expiration: string): Promise<Contract[] | null> {
      const result = await safeRequest<ChainReply>(
        "chain",
        marketdata.rpc.chain(broker),
        { symbol, expiration },
        chainTimeoutMs,
        (r) => r.chain,
        (r) => r.error,
      );
      return result as Contract[] | null;
    },

    async historicalChain(
      symbol: string,
      date: string,
      expiration: string,
    ): Promise<Contract[] | null> {
      const result = await safeRequest<ChainReply>(
        "historical_chain",
        marketdata.rpc.historicalChain(broker),
        { symbol, date, expiration },
        historicalChainTimeoutMs,
        (r) => r.chain,
        (r) => r.error,
      );
      return result as Contract[] | null;
    },

    async candles(
      symbol: string,
      from: string,
      to: string,
      frequency?: "daily" | "minute",
    ): Promise<Candle[] | null> {
      const payload: { symbol: string; from: string; to: string; frequency?: string } = {
        symbol,
        from,
        to,
      };
      if (frequency) payload.frequency = frequency;
      const result = await safeRequest<CandlesReply>(
        "candles",
        marketdata.rpc.candles(broker),
        payload,
        candlesTimeoutMs,
        (r) => r.candles,
        (r) => r.error,
      );
      return result as Candle[] | null;
    },

    subscribeQuotes(symbols: string[], callback: QuoteCallback): Subscription | null {
      if (symbols.length === 0) return null;
      return makeStreamSubscription(symbols, ensureQuoteFanout, quoteFanouts, callback);
    },

    subscribeTrades(symbols: string[], callback: TradeCallback): Subscription | null {
      if (symbols.length === 0) return null;
      return makeStreamSubscription(symbols, ensureTradeFanout, tradeFanouts, callback);
    },

    subscribeBook(symbols: string[], callback: BookCallback): Subscription | null {
      if (symbols.length === 0) return null;
      return makeStreamSubscription(symbols, ensureBookFanout, bookFanouts, callback);
    },

    setAlertRouter(router: AlertRouter): void {
      alertRouter = router;
    },

    lastHeartbeatAgeMs(): number | null {
      if (lastHeartbeatMs === 0) return null;
      return Date.now() - lastHeartbeatMs;
    },
  };
}
