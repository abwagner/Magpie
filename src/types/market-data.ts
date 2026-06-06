// ── Market Data Types ──────────────────────────────────────────────
// Defined in: docs/tdd/market-data.md

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  timestamp: string;
  _meta: DataMeta;
}

export interface Contract {
  symbol: string;
  underlying: string;
  expiration: string;
  side: "call" | "put";
  strike: number;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  underlyingPrice: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  // Optional chain-supplied tick size. When absent, the Execution
  // Layer's snapToTick falls back to per-symbol-class defaults
  //.
  tickSize?: number;
}

export interface TradePrint {
  ts: string;
  price: number;
  size: number;
  side?: "buy" | "sell";
}

// L2 book level. `num_orders` is the order-count at this price (Schwab
// OPTIONS_BOOK exposes it; some venues only aggregate price+size and
// leave it undefined — consumers that care about order-count should
// short-circuit when it's absent).
export interface L2Level {
  price: number;
  size: number;
  num_orders?: number;
}

export interface L2Book {
  ts: string;
  bids: L2Level[];
  asks: L2Level[];
}

export interface Candle {
  date: string; // YYYY-MM-DD for daily, ISO8601 for intraday
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DataMeta {
  source: string;
  source_timestamp: string | null;
  fetched_at: string;
  freshness_ms: number | null;
  latency_ms: number;
  from_cache: boolean;
  cache_age_ms: number;
  sources_tried: string[];
}

export interface FreshnessCheck {
  fresh: boolean;
  reason?: string;
}

export interface FreshnessThresholds {
  max_quote_age_ms: number;
  max_chain_age_ms: number;
  marketOpen?: boolean;
}

export interface MarketDataService {
  getQuote(symbol: string): Promise<Quote>;
  getExpirations(symbol: string): Promise<string[]>;
  getChain(symbol: string, expiration: string): Promise<Contract[]>;
  getHistoricalChain(symbol: string, date: string, expiration: string): Promise<Contract[]>;
  getCandles(
    symbol: string,
    from: string,
    to: string,
    frequency?: "daily" | "minute",
  ): Promise<Candle[]>;
  subscribeQuotes(symbols: string[], callback: QuoteCallback): Subscription;
  getFreshness(symbol: string): FreshnessCheck;
}

export type QuoteCallback = (symbol: string, quote: Quote) => void;
export type TradeCallback = (symbol: string, trade: TradePrint) => void;
export type BookCallback = (symbol: string, book: L2Book) => void;

export interface Subscription {
  unsubscribe(): void;
}

// QF-25 — per-symbol watcher consumer model. One consumer can opt into
// any subset of {quote, trade, book} events for a single symbol; the
// watcher fans events out to all registered consumers and tears down
// the upstream subscriptions when the last consumer unregisters.
//
// The Execution Layer's working-order monitor (TDD §4.1) is the
// canonical consumer; it registers all three callbacks for every
// symbol that has a working order. Strategy code that only wants
// quotes can keep using the legacy `subscribeQuotes` API which wraps
// this consumer model internally.
export interface SymbolConsumer {
  onQuote?: QuoteCallback;
  onTrade?: TradeCallback;
  onBook?: BookCallback;
}

export interface MarketDataAdapter {
  name: string;
  available(): Promise<boolean>;
  stockQuote(symbol: string): Promise<Quote | null>;
  expirations(symbol: string): Promise<string[] | null>;
  chain(symbol: string, expiration: string): Promise<Contract[] | null>;
  historicalChain(symbol: string, date: string, expiration: string): Promise<Contract[] | null>;
  candles?(
    symbol: string,
    from: string,
    to: string,
    frequency?: "daily" | "minute",
  ): Promise<Candle[] | null>;
  subscribeQuotes?(symbols: string[], callback: QuoteCallback): Subscription | null;
  // QF-26 — trade-print streaming. Adapters return null when they
  // can't serve the request (no streaming session, symbol not on the
  // adapter's universe, etc.); the subscription manager moves on to
  // the next adapter in the source-priority list. Side-hint
  // derivation (Lee-Ready / sale-condition flag) lives inside each
  // adapter — the manager just fans out whatever side hint the
  // adapter populates on TradePrint.
  subscribeTrades?(symbols: string[], callback: TradeCallback): Subscription | null;
  // QF-27 — L2 order-book streaming. Same null-when-unsupported
  // contract as subscribeTrades. Book budget enforcement (the
  // allocator that decides which symbols deserve an L2 stream when
  // capacity is tight) lives in QF-28 — adapters here just answer
  // "yes I can stream this symbol" or "no".
  subscribeBook?(symbols: string[], callback: BookCallback): Subscription | null;
}

export interface CacheConfig {
  quote_ttl_ms: number;
  expirations_ttl_ms: number;
  chain_ttl_ms: number;
  max_entries: number;
}
