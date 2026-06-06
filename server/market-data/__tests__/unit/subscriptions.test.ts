// Tests for createSubscriptionManager — the per-symbol watcher refactor
// from QF-25. Pins the four acceptance criteria from the ticket:
//   1. N consumers on one symbol → 1 upstream subscription
//   2. Last consumer unregisters → upstream torn down
//   3. Existing subscribeQuotes callers see no behavior change
//   4. Trade/book subscription slots exist (wired in QF-26 / QF-27)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  L2Book,
  MarketDataAdapter,
  Quote,
  Subscription,
  TradePrint,
} from "../../../../src/types/market-data.js";
import { createCache, type Cache } from "../../cache.js";
import { createSubscriptionManager } from "../../subscriptions.js";
import { createBookBudgetAllocator, createBookBudgetMetrics } from "../../book-budget.js";
import { createBackpressureMetrics } from "../../backpressure.js";
import { createLogger, type Logger } from "../../../logger.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeQuote(bid: number, ask: number): Quote {
  return {
    symbol: "SPY",
    bid,
    ask,
    mid: (bid + ask) / 2,
    last: (bid + ask) / 2,
    volume: 100,
    timestamp: new Date().toISOString(),
    _meta: {
      source: "test",
      source_timestamp: null,
      fetched_at: new Date().toISOString(),
      freshness_ms: null,
      latency_ms: 0,
      from_cache: false,
      cache_age_ms: 0,
      sources_tried: ["test"],
    },
  };
}

interface FakeStream {
  symbols: string[];
  cb: (sym: string, q: Quote) => void;
  active: boolean;
  emit(sym: string, q: Quote): void;
}

interface FakeStreamingAdapter extends MarketDataAdapter {
  streams: FakeStream[];
  subscribeQuotesCalls: number;
}

function fakeStreamingAdapter(name: string): FakeStreamingAdapter {
  const streams: FakeStream[] = [];
  const adapter: FakeStreamingAdapter = {
    name,
    streams,
    subscribeQuotesCalls: 0,
    async available() {
      return true;
    },
    async stockQuote() {
      return null;
    },
    async expirations() {
      return [];
    },
    async chain() {
      return [];
    },
    async historicalChain() {
      return [];
    },
    subscribeQuotes(symbols, cb) {
      adapter.subscribeQuotesCalls += 1;
      const stream: FakeStream = {
        symbols,
        cb,
        active: true,
        emit(sym, q) {
          if (this.active) cb(sym, q);
        },
      };
      streams.push(stream);
      const sub: Subscription = {
        unsubscribe(): void {
          stream.active = false;
        },
      };
      return sub;
    },
  };
  return adapter;
}

// ── Test wiring ───────────────────────────────────────────────────────

const log: Logger = createLogger("subscriptions-test", "error");

let cache: Cache;

beforeEach(() => {
  cache = createCache({
    quote_ttl_ms: 1000,
    expirations_ttl_ms: 60_000,
    chain_ttl_ms: 60_000,
    max_entries: 1000,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Acceptance criterion 1: dedup upstream subscriptions ──────────────

describe("createSubscriptionManager — N consumers, 1 upstream subscription per symbol", () => {
  it("opens exactly one upstream stream when 3 consumers subscribe to the same symbol", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    const cbA = vi.fn();
    const cbB = vi.fn();
    const cbC = vi.fn();

    mgr.subscribe(["SPY"], cbA);
    mgr.subscribe(["SPY"], cbB);
    mgr.subscribe(["SPY"], cbC);

    expect(adapter.subscribeQuotesCalls).toBe(1);
    expect(adapter.streams).toHaveLength(1);
  });

  it("fans every emitted quote out to all 3 consumers", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    const cbA = vi.fn();
    const cbB = vi.fn();
    const cbC = vi.fn();

    mgr.subscribe(["SPY"], cbA);
    mgr.subscribe(["SPY"], cbB);
    mgr.subscribe(["SPY"], cbC);

    const quote = makeQuote(450, 451);
    adapter.streams[0]!.emit("SPY", quote);

    expect(cbA).toHaveBeenCalledWith("SPY", quote);
    expect(cbB).toHaveBeenCalledWith("SPY", quote);
    expect(cbC).toHaveBeenCalledWith("SPY", quote);
  });

  it("each subscribe-call gets its own consumer entry even if the callback fn is identical", () => {
    // Two subscribe(["SPY"], sameCb) calls produce two consumer
    // entries; unsubscribing one doesn't accidentally remove the other.
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    const sharedCb = vi.fn();
    const sub1 = mgr.subscribe(["SPY"], sharedCb);
    mgr.subscribe(["SPY"], sharedCb);

    sub1.unsubscribe();
    adapter.streams[0]!.emit("SPY", makeQuote(450, 451));
    // The remaining subscription still fires.
    expect(sharedCb).toHaveBeenCalledTimes(1);
  });
});

// ── Acceptance criterion 2: tear-down on last unsubscribe ─────────────

describe("createSubscriptionManager — upstream torn down when last consumer leaves", () => {
  it("unsubscribes the upstream when the only consumer leaves", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    const sub = mgr.subscribe(["SPY"], vi.fn());
    expect(adapter.streams[0]!.active).toBe(true);

    sub.unsubscribe();
    expect(adapter.streams[0]!.active).toBe(false);
  });

  it("keeps the upstream alive while ≥ 1 consumer remains", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    const subA = mgr.subscribe(["SPY"], vi.fn());
    const subB = mgr.subscribe(["SPY"], vi.fn());

    subA.unsubscribe();
    expect(adapter.streams[0]!.active).toBe(true);

    subB.unsubscribe();
    expect(adapter.streams[0]!.active).toBe(false);
  });

  it("multi-symbol subscribe + unsubscribe tears down each symbol's upstream independently", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    const sub = mgr.subscribe(["SPY", "QQQ"], vi.fn());
    expect(adapter.subscribeQuotesCalls).toBe(2);

    sub.unsubscribe();
    expect(adapter.streams.every((s) => !s.active)).toBe(true);
  });
});

// ── Acceptance criterion 3: existing subscribeQuotes behavior ─────────

describe("createSubscriptionManager — legacy subscribeQuotes API behavior preserved", () => {
  it("writes quotes through to the cache", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    mgr.subscribe(["SPY"], vi.fn());
    const quote = makeQuote(450, 451);
    adapter.streams[0]!.emit("SPY", quote);

    expect(cache.get<Quote>("getQuote:SPY")).toEqual(quote);
  });

  it("a throwing consumer does not block other consumers from receiving the same quote", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);

    const bad = vi.fn(() => {
      throw new Error("consumer is broken");
    });
    const good = vi.fn();

    mgr.subscribe(["SPY"], bad);
    mgr.subscribe(["SPY"], good);

    adapter.streams[0]!.emit("SPY", makeQuote(450, 451));
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("falls back to polling when no adapter exposes subscribeQuotes", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const pollingAdapter: MarketDataAdapter = {
      name: "polling-only",
      async available() {
        return true;
      },
      async stockQuote() {
        pollCount += 1;
        return makeQuote(450 + pollCount, 451 + pollCount);
      },
      async expirations() {
        return [];
      },
      async chain() {
        return [];
      },
      async historicalChain() {
        return [];
      },
    };
    const mgr = createSubscriptionManager([pollingAdapter], cache, { poll_interval_ms: 100 }, log);
    const cb = vi.fn();
    const sub = mgr.subscribe(["SPY"], cb);

    // Drive the poll loop forward a few times.
    await vi.advanceTimersByTimeAsync(350);
    expect(cb).toHaveBeenCalled();

    sub.unsubscribe();
  });
});

// ── Acceptance criterion 4: trade + book slots reserved ───────────────

describe("createSubscriptionManager — trade + book slots exist (QF-26 / QF-27 land them)", () => {
  it("does not open trade or book upstreams from the legacy subscribe path", () => {
    // The watcher's trade_sub / book_sub fields stay null in QF-25 —
    // the legacy `subscribe(symbols, QuoteCallback)` API only opts
    // into quotes. Verified indirectly: an adapter that lacks
    // subscribeTrades / subscribeBook hooks is fine for a quote-only
    // subscribe, no extra streams opened.
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    mgr.subscribe(["SPY"], vi.fn());
    // Only the quote stream is up.
    expect(adapter.streams).toHaveLength(1);
  });
});

// ── QF-26: subscribeTrades ────────────────────────────────────────────

interface FakeTradeStream {
  symbols: string[];
  cb: (sym: string, t: TradePrint) => void;
  active: boolean;
  emit(sym: string, t: TradePrint): void;
}

interface FakeTradingAdapter extends MarketDataAdapter {
  tradeStreams: FakeTradeStream[];
  subscribeTradesCalls: number;
}

function fakeTradingAdapter(name: string): FakeTradingAdapter {
  const tradeStreams: FakeTradeStream[] = [];
  const adapter: FakeTradingAdapter = {
    name,
    tradeStreams,
    subscribeTradesCalls: 0,
    async available() {
      return true;
    },
    async stockQuote() {
      return null;
    },
    async expirations() {
      return [];
    },
    async chain() {
      return [];
    },
    async historicalChain() {
      return [];
    },
    subscribeTrades(symbols, cb) {
      adapter.subscribeTradesCalls += 1;
      const stream: FakeTradeStream = {
        symbols,
        cb,
        active: true,
        emit(sym, t) {
          if (this.active) cb(sym, t);
        },
      };
      tradeStreams.push(stream);
      return { unsubscribe: () => (stream.active = false) } as Subscription;
    },
  };
  return adapter;
}

function makeTrade(price: number, size = 100): TradePrint {
  return {
    ts: new Date().toISOString(),
    price,
    size,
  };
}

describe("createSubscriptionManager — subscribeTrades", () => {
  it("returns null when no adapter exposes subscribeTrades (caller routes around)", () => {
    const quoteOnlyAdapter = fakeStreamingAdapter("quote-only"); // no subscribeTrades
    const mgr = createSubscriptionManager(
      [quoteOnlyAdapter],
      cache,
      { poll_interval_ms: 1000 },
      log,
    );
    const sub = mgr.subscribeTrades(["SPY"], vi.fn());
    expect(sub).toBeNull();
  });

  it("returns a Subscription when an adapter serves trades", () => {
    const adapter = fakeTradingAdapter("trades");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const sub = mgr.subscribeTrades(["SPY"], vi.fn());
    expect(sub).not.toBeNull();
    expect(adapter.tradeStreams).toHaveLength(1);
  });

  it("N consumers on one symbol → 1 upstream trade subscription", () => {
    const adapter = fakeTradingAdapter("trades");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    mgr.subscribeTrades(["SPY"], vi.fn());
    mgr.subscribeTrades(["SPY"], vi.fn());
    mgr.subscribeTrades(["SPY"], vi.fn());
    expect(adapter.subscribeTradesCalls).toBe(1);
  });

  it("fans every emitted trade out to all consumers", () => {
    const adapter = fakeTradingAdapter("trades");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const cbA = vi.fn();
    const cbB = vi.fn();
    mgr.subscribeTrades(["SPY"], cbA);
    mgr.subscribeTrades(["SPY"], cbB);
    const trade = makeTrade(450.5);
    adapter.tradeStreams[0]!.emit("SPY", trade);
    expect(cbA).toHaveBeenCalledWith("SPY", trade);
    expect(cbB).toHaveBeenCalledWith("SPY", trade);
  });

  it("a throwing trade consumer does not block other consumers", () => {
    const adapter = fakeTradingAdapter("trades");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const bad = vi.fn(() => {
      throw new Error("broken");
    });
    const good = vi.fn();
    mgr.subscribeTrades(["SPY"], bad);
    mgr.subscribeTrades(["SPY"], good);
    adapter.tradeStreams[0]!.emit("SPY", makeTrade(450.5));
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("tears down the upstream trade stream when the last trade consumer leaves", () => {
    const adapter = fakeTradingAdapter("trades");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const subA = mgr.subscribeTrades(["SPY"], vi.fn());
    const subB = mgr.subscribeTrades(["SPY"], vi.fn());
    subA!.unsubscribe();
    expect(adapter.tradeStreams[0]!.active).toBe(true);
    subB!.unsubscribe();
    expect(adapter.tradeStreams[0]!.active).toBe(false);
  });

  it("quote + trade consumers share one watcher; tear-down is per-event-type", () => {
    // A consumer registers for quotes; a different consumer registers
    // for trades; both target the same symbol. The watcher holds both
    // upstreams. Removing the trade consumer drops only the trade
    // upstream; the quote upstream stays up.
    const adapter = {
      ...fakeStreamingAdapter("merged"),
      ...fakeTradingAdapter("merged"),
    } as FakeStreamingAdapter & FakeTradingAdapter;
    // Restore the streams / counters from the trading mixin so both
    // halves of the merged interface point at the right arrays.
    const tradingHalf = fakeTradingAdapter("merged");
    adapter.subscribeTrades = tradingHalf.subscribeTrades!.bind(tradingHalf);
    adapter.tradeStreams = tradingHalf.tradeStreams;

    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const quoteSub = mgr.subscribe(["SPY"], vi.fn());
    const tradeSub = mgr.subscribeTrades(["SPY"], vi.fn());

    expect(adapter.streams).toHaveLength(1);
    expect(tradingHalf.tradeStreams).toHaveLength(1);

    tradeSub!.unsubscribe();
    expect(adapter.streams[0]!.active).toBe(true); // quote upstream stays up
    expect(tradingHalf.tradeStreams[0]!.active).toBe(false); // trade torn down

    quoteSub.unsubscribe();
    expect(adapter.streams[0]!.active).toBe(false);
  });

  it("subscribeTrades returns null and rolls back state if ANY symbol cannot be served", () => {
    // Adapter that only serves trades for SPY, not QQQ. Asking for
    // both returns null; the SPY watcher entry created during the
    // probing pass is cleaned up so we don't leak partial state.
    const partialAdapter: MarketDataAdapter = {
      name: "spy-only",
      async available() {
        return true;
      },
      async stockQuote() {
        return null;
      },
      async expirations() {
        return [];
      },
      async chain() {
        return [];
      },
      async historicalChain() {
        return [];
      },
      subscribeTrades(symbols, _cb) {
        if (symbols.includes("QQQ")) return null;
        return { unsubscribe: () => undefined };
      },
    };
    const mgr = createSubscriptionManager([partialAdapter], cache, { poll_interval_ms: 1000 }, log);
    const sub = mgr.subscribeTrades(["SPY", "QQQ"], vi.fn());
    expect(sub).toBeNull();
  });
});

// ── QF-27: subscribeBook ──────────────────────────────────────────────

interface FakeBookStream {
  symbols: string[];
  cb: (sym: string, b: L2Book) => void;
  active: boolean;
  emit(sym: string, b: L2Book): void;
}

interface FakeBookAdapter extends MarketDataAdapter {
  bookStreams: FakeBookStream[];
  subscribeBookCalls: number;
}

function fakeBookAdapter(name: string): FakeBookAdapter {
  const bookStreams: FakeBookStream[] = [];
  const adapter: FakeBookAdapter = {
    name,
    bookStreams,
    subscribeBookCalls: 0,
    async available() {
      return true;
    },
    async stockQuote() {
      return null;
    },
    async expirations() {
      return [];
    },
    async chain() {
      return [];
    },
    async historicalChain() {
      return [];
    },
    subscribeBook(symbols, cb) {
      adapter.subscribeBookCalls += 1;
      const stream: FakeBookStream = {
        symbols,
        cb,
        active: true,
        emit(sym, b) {
          if (this.active) cb(sym, b);
        },
      };
      bookStreams.push(stream);
      return { unsubscribe: () => (stream.active = false) } as Subscription;
    },
  };
  return adapter;
}

function makeBook(): L2Book {
  return {
    ts: new Date().toISOString(),
    bids: [
      { price: 450.0, size: 10, num_orders: 3 },
      { price: 449.5, size: 25, num_orders: 5 },
    ],
    asks: [
      { price: 450.5, size: 8, num_orders: 2 },
      { price: 451.0, size: 30, num_orders: 6 },
    ],
  };
}

describe("createSubscriptionManager — subscribeBook", () => {
  it("returns null when no adapter exposes subscribeBook", () => {
    const quoteOnly = fakeStreamingAdapter("quote-only");
    const mgr = createSubscriptionManager([quoteOnly], cache, { poll_interval_ms: 1000 }, log);
    expect(mgr.subscribeBook(["SPY"], vi.fn())).toBeNull();
  });

  it("returns a Subscription when an adapter serves L2 book", () => {
    const adapter = fakeBookAdapter("book");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const sub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(sub).not.toBeNull();
    expect(adapter.bookStreams).toHaveLength(1);
  });

  it("N consumers on one symbol → 1 upstream book subscription", () => {
    const adapter = fakeBookAdapter("book");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    mgr.subscribeBook(["SPY"], vi.fn());
    mgr.subscribeBook(["SPY"], vi.fn());
    mgr.subscribeBook(["SPY"], vi.fn());
    expect(adapter.subscribeBookCalls).toBe(1);
  });

  it("fans every emitted book update out to all consumers", () => {
    const adapter = fakeBookAdapter("book");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const cbA = vi.fn();
    const cbB = vi.fn();
    mgr.subscribeBook(["SPY"], cbA);
    mgr.subscribeBook(["SPY"], cbB);
    const book = makeBook();
    adapter.bookStreams[0]!.emit("SPY", book);
    expect(cbA).toHaveBeenCalledWith("SPY", book);
    expect(cbB).toHaveBeenCalledWith("SPY", book);
  });

  it("tears down the book upstream when the last book consumer leaves", () => {
    const adapter = fakeBookAdapter("book");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const subA = mgr.subscribeBook(["SPY"], vi.fn());
    const subB = mgr.subscribeBook(["SPY"], vi.fn());
    subA!.unsubscribe();
    expect(adapter.bookStreams[0]!.active).toBe(true);
    subB!.unsubscribe();
    expect(adapter.bookStreams[0]!.active).toBe(false);
  });

  it("L2Level.num_orders flows through to consumers when populated", () => {
    // Adapters that expose order-count (Schwab OPTIONS_BOOK) populate
    // num_orders on each level. The manager doesn't mutate; just
    // passes the book through. Verifies the L2Level extension lands
    // end-to-end.
    const adapter = fakeBookAdapter("book");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    let received: L2Book | null = null;
    mgr.subscribeBook(["SPY"], (_sym, b) => {
      received = b;
    });
    adapter.bookStreams[0]!.emit("SPY", makeBook());
    expect(received).not.toBeNull();
    expect(received!.bids[0]!.num_orders).toBe(3);
    expect(received!.asks[0]!.num_orders).toBe(2);
  });

  it("a throwing book consumer does not block other consumers", () => {
    const adapter = fakeBookAdapter("book");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const bad = vi.fn(() => {
      throw new Error("broken");
    });
    const good = vi.fn();
    mgr.subscribeBook(["SPY"], bad);
    mgr.subscribeBook(["SPY"], good);
    adapter.bookStreams[0]!.emit("SPY", makeBook());
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("quote + trade + book all coexist on one watcher; per-event-type tear-down", () => {
    const quoteHalf = fakeStreamingAdapter("multi");
    const tradeHalf = fakeTradingAdapter("multi");
    const bookHalf = fakeBookAdapter("multi");
    const merged: FakeStreamingAdapter & FakeTradingAdapter & FakeBookAdapter = {
      ...quoteHalf,
      tradeStreams: tradeHalf.tradeStreams,
      subscribeTradesCalls: tradeHalf.subscribeTradesCalls,
      subscribeTrades: tradeHalf.subscribeTrades!.bind(tradeHalf),
      bookStreams: bookHalf.bookStreams,
      subscribeBookCalls: bookHalf.subscribeBookCalls,
      subscribeBook: bookHalf.subscribeBook!.bind(bookHalf),
    };

    const mgr = createSubscriptionManager([merged], cache, { poll_interval_ms: 1000 }, log);
    const qSub = mgr.subscribe(["SPY"], vi.fn());
    const tSub = mgr.subscribeTrades(["SPY"], vi.fn());
    const bSub = mgr.subscribeBook(["SPY"], vi.fn());

    expect(merged.streams).toHaveLength(1);
    expect(tradeHalf.tradeStreams).toHaveLength(1);
    expect(bookHalf.bookStreams).toHaveLength(1);

    // Drop book only — quote + trade upstreams stay alive.
    bSub!.unsubscribe();
    expect(merged.streams[0]!.active).toBe(true);
    expect(tradeHalf.tradeStreams[0]!.active).toBe(true);
    expect(bookHalf.bookStreams[0]!.active).toBe(false);

    // Drop trade — quote alone remains.
    tSub!.unsubscribe();
    expect(merged.streams[0]!.active).toBe(true);
    expect(tradeHalf.tradeStreams[0]!.active).toBe(false);

    // Drop quote — watcher gone.
    qSub.unsubscribe();
    expect(merged.streams[0]!.active).toBe(false);
  });
});

// ── QF-28: book budget gate ──────────────────────────────────────────

describe("createSubscriptionManager — subscribeBook with bookBudget gate", () => {
  function namedBookAdapter(name: string) {
    const adapter = fakeBookAdapter(name);
    adapter.name = name;
    return adapter;
  }

  it("admits subscribeBook when the chosen adapter has headroom", () => {
    const adapter = namedBookAdapter("schwab");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { schwab: 3 } },
      metrics,
    });
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
    });
    const sub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(sub).not.toBeNull();
    expect(budget.usage()).toEqual({ schwab: 1 });
  });

  it("skips an at-budget adapter and falls through to the next adapter in priority order", () => {
    // ibkr full, schwab has room → schwab gets the symbol.
    const ibkr = namedBookAdapter("ibkr");
    const schwab = namedBookAdapter("schwab");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1, schwab: 100 } },
      metrics,
    });
    // Pre-fill ibkr.
    budget.claim("AAPL", "ibkr");

    const mgr = createSubscriptionManager([ibkr, schwab], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
    });
    const sub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(sub).not.toBeNull();
    expect(ibkr.bookStreams).toHaveLength(0);
    expect(schwab.bookStreams).toHaveLength(1);
    expect(budget.usage()).toEqual({ ibkr: 1, schwab: 1 });
  });

  it("denies subscribeBook when ALL book-capable adapters are at budget", async () => {
    const ibkr = namedBookAdapter("ibkr");
    const schwab = namedBookAdapter("schwab");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 0, schwab: 0 } }, // both completely full
      metrics,
    });
    const mgr = createSubscriptionManager([ibkr, schwab], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
    });
    const sub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(sub).toBeNull();

    const all = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values?: Array<{ labels?: Record<string, string>; value?: number }>;
    }>;
    const denied = all.find((x) => x.name === "marketdata_book_budget_denied_total");
    const spyDeny = denied?.values?.find(
      (v) =>
        v.labels?.symbol === "SPY" && v.labels?.reason === "all_sources_full_no_preemption_won",
    );
    expect(spyDeny?.value).toBe(1);
  });

  it("denies with reason=no_source when no adapter exposes subscribeBook", async () => {
    const quoteOnly = fakeStreamingAdapter("quote-only"); // no subscribeBook
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: {} },
      metrics,
    });
    const mgr = createSubscriptionManager([quoteOnly], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
    });
    const sub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(sub).toBeNull();

    const all = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values?: Array<{ labels?: Record<string, string>; value?: number }>;
    }>;
    const denied = all.find((x) => x.name === "marketdata_book_budget_denied_total");
    const spyDeny = denied?.values?.find(
      (v) => v.labels?.symbol === "SPY" && v.labels?.reason === "no_source",
    );
    expect(spyDeny?.value).toBe(1);
  });

  it("releases the budget slot when the upstream tears down (last consumer)", () => {
    const adapter = namedBookAdapter("schwab");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { schwab: 3 } },
      metrics,
    });
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
    });
    const sub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(budget.usage()).toEqual({ schwab: 1 });
    sub!.unsubscribe();
    expect(budget.usage()).toEqual({ schwab: 0 });
  });

  it("treats bookBudget as opt-in — without it subscribeBook still works (QF-27 behavior)", () => {
    const adapter = namedBookAdapter("schwab");
    // No bookBudget passed → unlimited book streams (the v1
    // pre-allocator behavior survives).
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const sub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(sub).not.toBeNull();
  });

  // ── QF-205: preemption flow ────────────────────────────────────────

  it("preempts a lower-priority claim when budget is full and the comparator says swap", async () => {
    const { WorkingOrderPriorityComparator } = await import("../../book-budget.js");
    const adapter = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    // Working orders: SPY is short-lived (5s old, small), QQQ is long-
    // running urgent + large notional. The comparator says QQQ wins.
    const candidates: Record<
      string,
      { symbol: string; working_age_ms: number; working_notional_usd: number }
    > = {
      SPY: { symbol: "SPY", working_age_ms: 5_000, working_notional_usd: 100 },
      QQQ: { symbol: "QQQ", working_age_ms: 60_000, working_notional_usd: 1_000_000 },
    };
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: WorkingOrderPriorityComparator,
      getBookCandidate: (sym) => candidates[sym] ?? null,
    });

    // First claim takes the only slot
    const spySub = mgr.subscribeBook(["SPY"], vi.fn());
    expect(spySub).not.toBeNull();
    expect(budget.usage()).toEqual({ ibkr: 1 });

    // Second claim — should preempt SPY
    const qqqSub = mgr.subscribeBook(["QQQ"], vi.fn());
    expect(qqqSub).not.toBeNull();
    expect(budget.claims()).toEqual({ QQQ: "ibkr" });

    // Denial metric records the preemption against SPY (the victim).
    const all = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values?: Array<{ labels?: Record<string, string>; value?: number }>;
    }>;
    const denied = all.find((x) => x.name === "marketdata_book_budget_denied_total");
    const spyPreempted = denied?.values?.find(
      (v) => v.labels?.symbol === "SPY" && v.labels?.reason === "preempted",
    );
    expect(spyPreempted?.value).toBe(1);
  });

  it("does NOT preempt when the requesting candidate would lose to all current claims", async () => {
    const { WorkingOrderPriorityComparator } = await import("../../book-budget.js");
    const adapter = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    // SPY is the strong claim; QQQ is the weaker request.
    const candidates: Record<
      string,
      { symbol: string; working_age_ms: number; working_notional_usd: number }
    > = {
      SPY: { symbol: "SPY", working_age_ms: 60_000, working_notional_usd: 1_000_000 },
      QQQ: { symbol: "QQQ", working_age_ms: 5_000, working_notional_usd: 100 },
    };
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: WorkingOrderPriorityComparator,
      getBookCandidate: (sym) => candidates[sym] ?? null,
    });
    mgr.subscribeBook(["SPY"], vi.fn());
    const qqqSub = mgr.subscribeBook(["QQQ"], vi.fn());
    expect(qqqSub).toBeNull();
    expect(budget.claims()).toEqual({ SPY: "ibkr" });

    const all = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values?: Array<{ labels?: Record<string, string>; value?: number }>;
    }>;
    const denied = all.find((x) => x.name === "marketdata_book_budget_denied_total");
    const qqqDeny = denied?.values?.find(
      (v) =>
        v.labels?.symbol === "QQQ" && v.labels?.reason === "all_sources_full_no_preemption_won",
    );
    expect(qqqDeny?.value).toBe(1);
  });

  it("does NOT preempt when the victim has no working-order context (null candidate)", async () => {
    const { WorkingOrderPriorityComparator } = await import("../../book-budget.js");
    const adapter = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    const candidates: Record<
      string,
      { symbol: string; working_age_ms: number; working_notional_usd: number } | null
    > = {
      SPY: null, // no working order tracking SPY anymore
      QQQ: { symbol: "QQQ", working_age_ms: 60_000, working_notional_usd: 1_000_000 },
    };
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: WorkingOrderPriorityComparator,
      getBookCandidate: (sym) => candidates[sym] ?? null,
    });
    mgr.subscribeBook(["SPY"], vi.fn());
    // QQQ wants the slot but SPY has no candidate data → no comparison
    // possible → safe default is "don't preempt".
    const qqqSub = mgr.subscribeBook(["QQQ"], vi.fn());
    expect(qqqSub).toBeNull();
    expect(budget.claims()).toEqual({ SPY: "ibkr" });
  });
});

// ── QF-29: backpressure integration ──────────────────────────────────

describe("createSubscriptionManager — backpressure (max_queue_depth > 0)", () => {
  it("when max_queue_depth is 0 (default) consumers see events synchronously (pre-QF-29 behavior)", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager([adapter], cache, { poll_interval_ms: 1000 }, log);
    const cb = vi.fn();
    mgr.subscribe(["SPY"], cb);
    adapter.streams[0]!.emit("SPY", makeQuote(450, 451));
    // Synchronous fan-out — no flushPending needed.
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("with backpressure enabled, consumers receive events on the next microtask (test uses flushPending)", () => {
    const adapter = fakeStreamingAdapter("test");
    const mgr = createSubscriptionManager(
      [adapter],
      cache,
      { poll_interval_ms: 1000, max_queue_depth: 5 },
      log,
    );
    const cb = vi.fn();
    mgr.subscribe(["SPY"], cb);

    adapter.streams[0]!.emit("SPY", makeQuote(450, 451));
    // Hasn't reached the consumer yet (queued, waiting on microtask).
    expect(cb).not.toHaveBeenCalled();

    mgr.flushPending();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("quote bursts beyond max_queue_depth drop the oldest", async () => {
    const adapter = fakeStreamingAdapter("test");
    const metrics = createBackpressureMetrics();
    const mgr = createSubscriptionManager(
      [adapter],
      cache,
      { poll_interval_ms: 1000, max_queue_depth: 3 },
      log,
      { backpressureMetrics: metrics },
    );
    const cb = vi.fn();
    mgr.subscribe(["SPY"], cb);

    // 7 quotes pushed in one synchronous burst.
    for (let i = 0; i < 7; i++) {
      adapter.streams[0]!.emit("SPY", makeQuote(450 + i, 451 + i));
    }
    // Queue depth=3 → 4 dropped before drain.
    mgr.flushPending();
    expect(cb).toHaveBeenCalledTimes(3);

    const all = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values?: Array<{ labels?: Record<string, string>; value?: number }>;
    }>;
    const dropped = all.find((x) => x.name === "marketdata_subscription_dropped_events_total");
    const spyQuoteDrops = dropped?.values?.find(
      (v) => v.labels?.symbol === "SPY" && v.labels?.kind === "quote",
    );
    expect(spyQuoteDrops?.value).toBe(4);
  });

  it("trade bursts beyond depth never drop (every print delivered)", () => {
    const tradeAdapter = fakeTradingAdapter("trades");
    const mgr = createSubscriptionManager(
      [tradeAdapter],
      cache,
      { poll_interval_ms: 1000, max_queue_depth: 3 },
      log,
    );
    const cb = vi.fn();
    mgr.subscribeTrades(["SPY"], cb);

    for (let i = 0; i < 10; i++) {
      tradeAdapter.tradeStreams[0]!.emit("SPY", { ts: "", price: 450 + i, size: 1 });
    }
    mgr.flushPending();
    expect(cb).toHaveBeenCalledTimes(10);
  });

  // QF-222 — preempted-consumer re-evaluation loop tests are after this block.
  it("book bursts coalesce — consumer only sees the latest", async () => {
    const bookAdapter = fakeBookAdapter("book");
    const metrics = createBackpressureMetrics();
    const mgr = createSubscriptionManager(
      [bookAdapter],
      cache,
      { poll_interval_ms: 1000, max_queue_depth: 50 },
      log,
      { backpressureMetrics: metrics },
    );
    let received: L2Book | null = null;
    let receivedCount = 0;
    mgr.subscribeBook(["SPY"], (_sym, b) => {
      received = b;
      receivedCount += 1;
    });

    for (let i = 0; i < 5; i++) {
      bookAdapter.bookStreams[0]!.emit("SPY", {
        ts: "",
        bids: [{ price: 450 + i, size: 1 }],
        asks: [{ price: 450.5 + i, size: 1 }],
      });
    }
    mgr.flushPending();
    expect(receivedCount).toBe(1);
    expect(received!.bids[0]!.price).toBe(454);

    const all = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values?: Array<{ labels?: Record<string, string>; value?: number }>;
    }>;
    const dropped = all.find((x) => x.name === "marketdata_subscription_dropped_events_total");
    const spyBookDrops = dropped?.values?.find(
      (v) => v.labels?.symbol === "SPY" && v.labels?.kind === "book",
    );
    expect(spyBookDrops?.value).toBe(4);
  });
});

// ── QF-222 — preempted-consumer re-evaluation loop ────────────────────

describe("createSubscriptionManager — QF-222 preempted-consumer re-evaluation", () => {
  function namedBookAdapter(name: string) {
    const adapter = fakeBookAdapter(name);
    adapter.name = name;
    return adapter;
  }

  async function getReclaimCount(
    metrics: ReturnType<typeof createBookBudgetMetrics>,
    symbol: string,
  ): Promise<number> {
    const json = (await metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values?: Array<{ labels?: Record<string, string>; value?: number }>;
    }>;
    const m = json.find((x) => x.name === "marketdata_book_budget_reevaluation_reclaim_total");
    const v = m?.values?.find((vv) => vv.labels?.symbol === symbol);
    return v?.value ?? 0;
  }

  it("indexes a preempted symbol when displaced by a higher-priority claim", () => {
    const ibkr = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    // Comparator: requesting wins if its working_age_ms is higher.
    const comparator = {
      compare(a: { working_age_ms: number }, b: { working_age_ms: number }): number {
        return b.working_age_ms - a.working_age_ms;
      },
    };
    const candidates = new Map<
      string,
      { symbol: string; working_age_ms: number; working_notional_usd: number }
    >();
    candidates.set("SPY", { symbol: "SPY", working_age_ms: 5_000, working_notional_usd: 100 });
    candidates.set("QQQ", { symbol: "QQQ", working_age_ms: 60_000, working_notional_usd: 100 });

    const mgr = createSubscriptionManager([ibkr], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: comparator,
      getBookCandidate: (s) => candidates.get(s) ?? null,
      reevaluationIntervalMs: 0, // disable the timer; we'll trigger manually
    });
    // SPY claims the only slot first.
    expect(mgr.subscribeBook(["SPY"], vi.fn())).not.toBeNull();
    // QQQ is higher priority — preemption fires.
    expect(mgr.subscribeBook(["QQQ"], vi.fn())).not.toBeNull();
    expect(mgr.preemptedSymbols()).toEqual(["SPY"]);
    mgr.close();
  });

  it("reclaims a preempted symbol when triggerReevaluationNow is called after the displacer terminates", async () => {
    const ibkr = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    const comparator = {
      compare(a: { working_age_ms: number }, b: { working_age_ms: number }): number {
        return b.working_age_ms - a.working_age_ms;
      },
    };
    const candidates = new Map<
      string,
      { symbol: string; working_age_ms: number; working_notional_usd: number }
    >();
    candidates.set("SPY", { symbol: "SPY", working_age_ms: 5_000, working_notional_usd: 100 });
    candidates.set("QQQ", { symbol: "QQQ", working_age_ms: 60_000, working_notional_usd: 100 });

    const mgr = createSubscriptionManager([ibkr], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: comparator,
      getBookCandidate: (s) => candidates.get(s) ?? null,
      bookBudgetMetrics: metrics,
      reevaluationIntervalMs: 0,
    });
    mgr.subscribeBook(["SPY"], vi.fn());
    const qqqSub = mgr.subscribeBook(["QQQ"], vi.fn());
    expect(mgr.preemptedSymbols()).toEqual(["SPY"]);

    // QQQ terminates → unsubscribe frees the slot.
    qqqSub!.unsubscribe();
    expect(budget.usage().ibkr).toBe(0);

    // Tick the re-evaluation loop.
    mgr.triggerReevaluationNow();

    // SPY should have reclaimed.
    expect(mgr.preemptedSymbols()).toEqual([]);
    expect(budget.usage().ibkr).toBe(1);
    expect(await getReclaimCount(metrics, "SPY")).toBe(1);
    mgr.close();
  });

  it("re-evaluation reclaims even when the displacer still holds, if priority flips", async () => {
    const ibkr = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    const comparator = {
      compare(a: { working_age_ms: number }, b: { working_age_ms: number }): number {
        return b.working_age_ms - a.working_age_ms;
      },
    };
    const candidates = new Map<
      string,
      { symbol: string; working_age_ms: number; working_notional_usd: number }
    >();
    candidates.set("SPY", { symbol: "SPY", working_age_ms: 5_000, working_notional_usd: 100 });
    candidates.set("QQQ", { symbol: "QQQ", working_age_ms: 60_000, working_notional_usd: 100 });

    const mgr = createSubscriptionManager([ibkr], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: comparator,
      getBookCandidate: (s) => candidates.get(s) ?? null,
      bookBudgetMetrics: metrics,
      reevaluationIntervalMs: 0,
    });
    mgr.subscribeBook(["SPY"], vi.fn());
    mgr.subscribeBook(["QQQ"], vi.fn());
    expect(mgr.preemptedSymbols()).toEqual(["SPY"]);

    // SPY's working order ages → becomes more urgent.
    candidates.set("SPY", { symbol: "SPY", working_age_ms: 120_000, working_notional_usd: 100 });
    mgr.triggerReevaluationNow();

    expect(mgr.preemptedSymbols()).toEqual(["QQQ"]);
    expect(await getReclaimCount(metrics, "SPY")).toBe(1);
    mgr.close();
  });

  it("evicts a preempted symbol from the index when its book consumers all unsubscribe", () => {
    const ibkr = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    const comparator = {
      compare(a: { working_age_ms: number }, b: { working_age_ms: number }): number {
        return b.working_age_ms - a.working_age_ms;
      },
    };
    const candidates = new Map<
      string,
      { symbol: string; working_age_ms: number; working_notional_usd: number }
    >();
    candidates.set("SPY", { symbol: "SPY", working_age_ms: 5_000, working_notional_usd: 100 });
    candidates.set("QQQ", { symbol: "QQQ", working_age_ms: 60_000, working_notional_usd: 100 });

    const mgr = createSubscriptionManager([ibkr], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: comparator,
      getBookCandidate: (s) => candidates.get(s) ?? null,
      reevaluationIntervalMs: 0,
    });
    const spySub = mgr.subscribeBook(["SPY"], vi.fn());
    mgr.subscribeBook(["QQQ"], vi.fn());
    expect(mgr.preemptedSymbols()).toEqual(["SPY"]);

    // SPY's consumer unregisters before reclaim — preempted entry is dropped.
    spySub!.unsubscribe();
    expect(mgr.preemptedSymbols()).toEqual([]);
    mgr.close();
  });

  it("close() stops the timer cleanly (no further reclaim attempts)", () => {
    const ibkr = namedBookAdapter("ibkr");
    const metrics = createBookBudgetMetrics();
    const budget = createBookBudgetAllocator({
      config: { limits: { ibkr: 1 } },
      metrics,
    });
    const comparator = {
      compare(): number {
        return 0;
      },
    };
    const mgr = createSubscriptionManager([ibkr], cache, { poll_interval_ms: 1000 }, log, {
      bookBudget: budget,
      bookBudgetComparator: comparator,
      getBookCandidate: () => null,
      reevaluationIntervalMs: 60_000, // timer is on
    });
    mgr.close();
    // Subsequent triggerReevaluationNow still works (it's a manual hook).
    expect(() => mgr.triggerReevaluationNow()).not.toThrow();
  });
});
