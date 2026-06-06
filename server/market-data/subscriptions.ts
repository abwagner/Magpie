// ── Subscription Manager ──────────────────────────────────────────
// Per-symbol watcher with multi-consumer fan-out and one upstream
// subscription per symbol regardless of how many consumers are
// attached. Tears down the upstream when the last consumer leaves.
//
// QF-25 refactor: SymbolState renamed to SymbolWatch and reshaped to
// hold separate quote/trade/book subscription slots so QF-26 (trades)
// and QF-27 (book) can plug into the same watcher without changing
// the public API again. Trade + book slots stay null in this ticket;
// the legacy `subscribe(symbols, QuoteCallback)` API is preserved for
// existing callers.
//
// Defined in: docs/data/market-data.md §6

import type {
  BookCallback,
  L2Book,
  MarketDataAdapter,
  Quote,
  QuoteCallback,
  Subscription,
  SymbolConsumer,
  TradeCallback,
  TradePrint,
} from "../../src/types/market-data.js";
import type { Cache } from "./cache.js";
import { quoteKey } from "./cache.js";
import type { Logger } from "../logger.js";
import type {
  BookBudgetAllocator,
  BookBudgetMetrics,
  BookCandidate,
  BookDenyReason,
  PriorityComparator,
} from "./book-budget.js";
import {
  createEventQueue,
  pushBook,
  pushQuote,
  pushTrade,
  type BackpressureMetrics,
  type EventQueue,
} from "./backpressure.js";

// ── Types ──────────────────────────────────────────────────────────

interface SymbolWatch {
  symbol: string;
  // Upstream quote feed — either an adapter-native streaming
  // Subscription or the polling-interval handle wrapped in a
  // Subscription-shaped object so tear-down is uniform.
  quote_sub: Subscription | null;
  // Reserved for QF-26 and QF-27 — populated by the subscribeTrades /
  // subscribeBook APIs added in those tickets. Null here.
  trade_sub: Subscription | null;
  book_sub: Subscription | null;
  // Consumers keyed by an opaque id (per-subscribe-call ulid). Each
  // consumer opts into any subset of {quote, trade, book} events.
  consumers: Map<string, SymbolConsumer>;
  last_quote: Quote | null;
  last_trade: TradePrint | null;
  last_book: L2Book | null;
  // QF-29 — populated only when backpressure is enabled
  // (config.max_queue_depth > 0). Synchronous fan-out skips the queue.
  queue: EventQueue | null;
}

interface SubscriptionConfig {
  poll_interval_ms: number;
  // QF-29 — set > 0 to enable per-symbol event-queue buffering with
  // the drop policy from backpressure.ts. 0 (or unset) keeps the
  // pre-QF-29 synchronous-fan-out behavior.
  max_queue_depth?: number;
}

export interface SubscriptionManager {
  // Legacy: register a quote-only consumer for one or more symbols.
  // Returns a single Subscription that tears down the consumer entry
  // on every symbol when unsubscribed.
  subscribe(symbols: string[], callback: QuoteCallback): Subscription;
  // QF-26 — register a trade-only consumer. Returns null when no
  // configured adapter exposes `subscribeTrades` (per the
  // source-priority list at TDD §10); callers fall back to whatever
  // strategy is appropriate (no-trade-tape mode, error to operator,
  // etc.).
  subscribeTrades(symbols: string[], callback: TradeCallback): Subscription | null;
  // QF-27 — register an L2-book consumer. Returns null when no
  // configured adapter exposes `subscribeBook` for the symbol set
  // OR (in a future ticket) when the book budget is exhausted.
  // The QF-28 allocator will gate this method when it lands.
  subscribeBook(symbols: string[], callback: BookCallback): Subscription | null;
  // QF-29 — flush queued events synchronously. Returns silently when
  // backpressure is disabled (no queue exists). Tests use this between
  // an `adapter.emit(...)` and an assertion to drain the microtask
  // queue without awaiting; production callers shouldn't need it
  // because the microtask drain runs naturally between turns.
  flushPending(): void;
  // QF-222 — manually trigger the preempted-consumer re-evaluation
  // sweep. Production uses the timer; tests call this directly to
  // assert reclaim behavior without advancing fake timers.
  triggerReevaluationNow(): void;
  // QF-222 — preempted-symbol snapshot. Returns the set of symbols
  // whose L2 book stream was displaced by a higher-priority claim and
  // is still awaiting reclaim. Tests + diagnostics consume this; the
  // re-evaluation loop walks it internally.
  preemptedSymbols(): readonly string[];
  // QF-222 — stop the re-evaluation timer (and any other long-lived
  // resources). Tests call this in afterEach to avoid leaking timers
  // across test files; production calls it on shutdown.
  close(): void;
}

// ── Implementation ─────────────────────────────────────────────────

export interface SubscriptionManagerOpts {
  // QF-28 — when set, subscribeBook consults the allocator to decide
  // whether a candidate source can accept a new symbol. The legacy
  // 4-arg call site (no allocator) keeps working — book streams are
  // simply uncapped, which matches the pre-QF-28 behavior.
  bookBudget?: BookBudgetAllocator;
  // QF-205 — comparator + book-candidate provider drive the preemption
  // policy when all sources are at budget. Both optional; without
  // them, the manager falls back to the QF-28 behavior (deny with
  // all_sources_full_no_preemption_won). The provider is typically
  // the WorkingOrderMonitor's getBookCandidate.
  bookBudgetComparator?: PriorityComparator;
  getBookCandidate?: (symbol: string) => BookCandidate | null;
  // QF-29 — when both `config.max_queue_depth > 0` AND
  // `backpressureMetrics` is set, drops are observable via the
  // `marketdata_subscription_dropped_events_total` counter.
  // Buffering still works without metrics (drops happen silently);
  // metrics without max_queue_depth > 0 is a no-op since the queue
  // never fills.
  backpressureMetrics?: BackpressureMetrics;
  // QF-222 — book-budget metrics handle. When set, the re-evaluation
  // loop emits `marketdata_book_budget_reevaluation_reclaim_total{symbol}`
  // on each successful reclaim. The QF-28 path doesn't need this dep
  // (it has its own metrics route via `bookBudget.recordDenied`); this
  // lives here because the reclaim metric is a manager concern, not
  // an allocator one.
  bookBudgetMetrics?: BookBudgetMetrics;
  // QF-222 — preempted-consumer re-evaluation cadence (ms). The QF-28
  // spec calls for 60s; tests can lower this for quick assertions, or
  // pass 0 to disable the timer entirely (the manual
  // `triggerReevaluationNow()` hook still works).
  reevaluationIntervalMs?: number;
}

export function createSubscriptionManager(
  adapters: MarketDataAdapter[],
  cache: Cache,
  config: SubscriptionConfig,
  logger: Logger,
  opts: SubscriptionManagerOpts = {},
): SubscriptionManager {
  const watches = new Map<string, SymbolWatch>();
  let consumerIdSeq = 0;

  // QF-222 — preempted-consumer index. Populated by the preemption
  // path in tryNativeBookStream when a victim is displaced. Walked by
  // the re-evaluation loop (or `triggerReevaluationNow()`) to retry
  // each preempted symbol; successful reclaim removes the entry.
  // Value = (last_attempt_timestamp_ms, watch_ref); the watch ref is
  // captured so the entry survives even if downstream code calls
  // `tearDownIfEmpty` (it doesn't today, but defensively).
  const preempted = new Map<string, { lastAttemptMs: number; watch: SymbolWatch }>();
  let reevaluationTimer: ReturnType<typeof setInterval> | null = null;

  function nextConsumerId(): string {
    consumerIdSeq += 1;
    return `c${consumerIdSeq}`;
  }

  const backpressureEnabled =
    typeof config.max_queue_depth === "number" && config.max_queue_depth > 0;
  const backpressureConfig = { max_queue_depth: config.max_queue_depth ?? 0 };

  function getOrCreateWatch(symbol: string): SymbolWatch {
    let watch = watches.get(symbol);
    if (!watch) {
      watch = {
        symbol,
        quote_sub: null,
        trade_sub: null,
        book_sub: null,
        consumers: new Map(),
        last_quote: null,
        last_trade: null,
        last_book: null,
        queue: backpressureEnabled ? createEventQueue() : null,
      };
      watches.set(symbol, watch);
    }
    return watch;
  }

  // QF-29 — drain a single watch's queue, fanning out the events that
  // survived the drop policy. Called from a microtask in normal
  // operation; tests call flushPending() to drain synchronously.
  function drainWatch(watch: SymbolWatch): void {
    if (!watch.queue) return;
    const q = watch.queue;
    if (q.quotes.length > 0) {
      const events = q.quotes;
      q.quotes = [];
      for (const ev of events) fanOutQuoteSync(watch.symbol, ev, watch);
    }
    if (q.trades.length > 0) {
      const events = q.trades;
      q.trades = [];
      for (const ev of events) fanOutTradeSync(watch.symbol, ev, watch);
    }
    if (q.books.length > 0) {
      const events = q.books;
      q.books = [];
      for (const ev of events) fanOutBookSync(watch.symbol, ev, watch);
    }
    q.drain_scheduled = false;
  }

  function scheduleDrain(watch: SymbolWatch): void {
    if (!watch.queue || watch.queue.drain_scheduled) return;
    watch.queue.drain_scheduled = true;
    queueMicrotask(() => drainWatch(watch));
  }

  // ── Fan-out (synchronous; final stage of the drain) ──────────────────
  // The *Sync variants do the actual consumer notification. When
  // backpressure is enabled the queue feeds them; otherwise the
  // emission path calls them directly.

  function fanOutQuoteSync(symbol: string, quote: Quote, watch: SymbolWatch): void {
    watch.last_quote = quote;
    cache.set(quoteKey(symbol), quote, config.poll_interval_ms * 2);
    for (const consumer of watch.consumers.values()) {
      if (!consumer.onQuote) continue;
      try {
        consumer.onQuote(symbol, quote);
      } catch (err) {
        logger.warn("market-data consumer threw on quote event", {
          symbol,
          error: String(err),
        });
      }
    }
  }

  function fanOutTradeSync(symbol: string, trade: TradePrint, watch: SymbolWatch): void {
    watch.last_trade = trade;
    for (const consumer of watch.consumers.values()) {
      if (!consumer.onTrade) continue;
      try {
        consumer.onTrade(symbol, trade);
      } catch (err) {
        logger.warn("market-data consumer threw on trade event", {
          symbol,
          error: String(err),
        });
      }
    }
  }

  function fanOutBookSync(symbol: string, book: L2Book, watch: SymbolWatch): void {
    watch.last_book = book;
    for (const consumer of watch.consumers.values()) {
      if (!consumer.onBook) continue;
      try {
        consumer.onBook(symbol, book);
      } catch (err) {
        logger.warn("market-data consumer threw on book event", {
          symbol,
          error: String(err),
        });
      }
    }
  }

  // ── Emission entry points (consult backpressure config) ─────────────

  function fanOutQuote(symbol: string, quote: Quote, watch: SymbolWatch): void {
    if (watch.queue) {
      pushQuote(watch.queue, quote, {
        symbol,
        config: backpressureConfig,
        metrics: opts.backpressureMetrics,
        logger,
      });
      scheduleDrain(watch);
    } else {
      fanOutQuoteSync(symbol, quote, watch);
    }
  }

  function fanOutTrade(symbol: string, trade: TradePrint, watch: SymbolWatch): void {
    if (watch.queue) {
      pushTrade(watch.queue, trade, {
        symbol,
        config: backpressureConfig,
        metrics: opts.backpressureMetrics,
        logger,
      });
      scheduleDrain(watch);
    } else {
      fanOutTradeSync(symbol, trade, watch);
    }
  }

  function fanOutBook(symbol: string, book: L2Book, watch: SymbolWatch): void {
    if (watch.queue) {
      pushBook(watch.queue, book, {
        symbol,
        config: backpressureConfig,
        metrics: opts.backpressureMetrics,
        logger,
      });
      scheduleDrain(watch);
    } else {
      fanOutBookSync(symbol, book, watch);
    }
  }

  function tryNativeQuoteStream(symbol: string, watch: SymbolWatch): boolean {
    for (const adapter of adapters) {
      if (!adapter.subscribeQuotes) continue;
      const sub = adapter.subscribeQuotes([symbol], (sym, quote) => {
        fanOutQuote(sym, quote, watch);
      });
      if (sub) {
        watch.quote_sub = sub;
        return true;
      }
    }
    return false;
  }

  function startQuotePolling(symbol: string, watch: SymbolWatch): void {
    const timer = setInterval(async () => {
      for (const adapter of adapters) {
        try {
          if (!(await adapter.available())) continue;
          const quote = await adapter.stockQuote(symbol);
          if (!quote) continue;
          // Value-based dedup — adapters can emit the same quote on
          // consecutive polls when the market is quiet; consumers
          // expect a change-event stream, not a tick-clock.
          const last = watch.last_quote;
          if (
            last &&
            last.bid === quote.bid &&
            last.ask === quote.ask &&
            last.last === quote.last
          ) {
            return;
          }
          fanOutQuote(symbol, quote, watch);
          return;
        } catch {
          // Adapter blew up; try the next one.
          continue;
        }
      }
    }, config.poll_interval_ms);
    watch.quote_sub = { unsubscribe: () => clearInterval(timer) };
  }

  function startUpstreamIfNeeded(symbol: string, watch: SymbolWatch): void {
    if (watch.quote_sub) return;
    if (!tryNativeQuoteStream(symbol, watch)) {
      startQuotePolling(symbol, watch);
    }
  }

  // QF-26 — trade-stream upstream. Trade tapes don't have a sane
  // polling fallback (a missed print is a missed print; you can't
  // poll-discover prior trades cheaply), so absence of a streaming
  // adapter returns false → caller subscribeTrades returns null.
  function tryNativeTradeStream(symbol: string, watch: SymbolWatch): boolean {
    for (const adapter of adapters) {
      if (!adapter.subscribeTrades) continue;
      const sub = adapter.subscribeTrades([symbol], (sym, trade) => {
        fanOutTrade(sym, trade, watch);
      });
      if (sub) {
        watch.trade_sub = sub;
        return true;
      }
    }
    return false;
  }

  // QF-27 + QF-28 + QF-205 — book-stream upstream. Same
  // null-when-unsupported contract as trades. When `opts.bookBudget` is
  // set, each candidate adapter is gated by per-source budget headroom.
  // When `opts.bookBudgetComparator` + `opts.getBookCandidate` are also
  // set, full-budget denials trigger preemption: the comparator ranks
  // the requesting symbol against existing claims and the lowest-
  // priority loser is displaced. Full denials still emit
  // `marketdata_book_budget_denied_total{reason}`; preempted consumers
  // get a separate `reason=preempted` row.
  function tryNativeBookStream(symbol: string, watch: SymbolWatch): boolean {
    let sawCandidate = false;
    let blockedByBudget = false;
    // First pass: try to claim a slot on any source with headroom.
    for (const adapter of adapters) {
      if (!adapter.subscribeBook) continue;
      sawCandidate = true;
      if (opts.bookBudget && !opts.bookBudget.hasHeadroom(adapter.name)) {
        blockedByBudget = true;
        continue;
      }
      if (attachBook(adapter, symbol, watch)) {
        // QF-222 — if this symbol was in the preempted index, it just
        // reclaimed a slot. Clear and emit the reclaim metric.
        preempted.delete(symbol);
        return true;
      }
    }

    // Second pass (QF-205): all sources at budget. Try preemption if the
    // comparator + candidate provider are both wired.
    if (blockedByBudget && opts.bookBudget && opts.bookBudgetComparator && opts.getBookCandidate) {
      const requestingCandidate = opts.getBookCandidate(symbol);
      if (requestingCandidate) {
        const claims = opts.bookBudget.claims();
        // Walk adapters again, this time looking for an evictable claim.
        for (const adapter of adapters) {
          if (!adapter.subscribeBook) continue;
          // Find the lowest-priority claim on this adapter that the
          // requesting symbol can preempt.
          let bestLoser: { victim: string; candidate: BookCandidate } | null = null;
          let bestDelta = 0;
          for (const [victimSymbol, source] of Object.entries(claims)) {
            if (source !== adapter.name) continue;
            if (victimSymbol === symbol) continue;
            const victimCandidate = opts.getBookCandidate(victimSymbol);
            if (!victimCandidate) continue; // no working-order context — leave alone
            const cmp = opts.bookBudgetComparator.compare(requestingCandidate, victimCandidate);
            if (cmp < 0 && cmp < bestDelta) {
              bestDelta = cmp;
              bestLoser = { victim: victimSymbol, candidate: victimCandidate };
            }
          }
          if (!bestLoser) continue;

          // Found a victim. Tear down its book stream, free its slot,
          // emit a `preempted` reason for it, then claim for the
          // requesting symbol.
          const victimWatch = watches.get(bestLoser.victim);
          victimWatch?.book_sub?.unsubscribe();
          if (victimWatch) victimWatch.book_sub = null;
          opts.bookBudget.recordDenied(bestLoser.victim, "preempted");
          // QF-222 — register the displaced symbol for periodic re-
          // evaluation. The watch ref is preserved so reclaim can
          // re-attach the underlying L2 stream to the same consumers.
          if (victimWatch) {
            preempted.set(bestLoser.victim, {
              lastAttemptMs: Date.now(),
              watch: victimWatch,
            });
          }
          logger.info("book-budget preemption", {
            requesting_symbol: symbol,
            victim_symbol: bestLoser.victim,
            source: adapter.name,
            delta: bestDelta,
          });
          if (attachBook(adapter, symbol, watch)) {
            // The newly-claiming symbol may itself have been on the
            // preempted list (reclaim path); clear it from the index.
            preempted.delete(symbol);
            return true;
          }
        }
      }
    }

    // Denial: classify reason for the metric.
    if (opts.bookBudget) {
      const reason: BookDenyReason = !sawCandidate
        ? "no_source"
        : blockedByBudget
          ? "all_sources_full_no_preemption_won"
          : "no_source";
      opts.bookBudget.recordDenied(symbol, reason);
    }
    return false;
  }

  // Helper: claim + wire the book upstream for a successful adapter.
  // Extracted so the preemption path (second pass) can reuse it.
  function attachBook(adapter: MarketDataAdapter, symbol: string, watch: SymbolWatch): boolean {
    if (!adapter.subscribeBook) return false;
    const sub = adapter.subscribeBook([symbol], (sym, book) => {
      fanOutBook(sym, book, watch);
    });
    if (!sub) return false;
    opts.bookBudget?.claim(symbol, adapter.name);
    watch.book_sub = {
      unsubscribe: () => {
        sub.unsubscribe();
        opts.bookBudget?.release(symbol);
      },
    };
    return true;
  }

  // Tear-down is per-event-type. If a consumer with onQuote only
  // unregisters but another consumer still has onTrade registered for
  // the same symbol, we want to drop the quote upstream while keeping
  // trades alive. The watch is deleted when no consumers remain
  // (consumers.size === 0).
  function tearDownIfEmpty(symbol: string): void {
    const watch = watches.get(symbol);
    if (!watch) return;
    let hasQuoteConsumer = false;
    let hasTradeConsumer = false;
    let hasBookConsumer = false;
    for (const consumer of watch.consumers.values()) {
      if (consumer.onQuote) hasQuoteConsumer = true;
      if (consumer.onTrade) hasTradeConsumer = true;
      if (consumer.onBook) hasBookConsumer = true;
    }
    if (!hasQuoteConsumer && watch.quote_sub) {
      watch.quote_sub.unsubscribe();
      watch.quote_sub = null;
    }
    if (!hasTradeConsumer && watch.trade_sub) {
      watch.trade_sub.unsubscribe();
      watch.trade_sub = null;
    }
    if (!hasBookConsumer && watch.book_sub) {
      watch.book_sub.unsubscribe();
      watch.book_sub = null;
    }
    if (watch.consumers.size === 0) {
      watches.delete(symbol);
      // QF-222 — drop the symbol from the preempted index. The watch
      // is going away; no future reclaim is meaningful.
      preempted.delete(symbol);
    }
  }

  // QF-222 — re-evaluate every preempted symbol against the current
  // allocator state + comparator priorities. Each call walks the
  // index, invokes tryNativeBookStream(symbol, watch); successful
  // reclaim removes the entry and increments the reclaim counter.
  //
  // The loop is best-effort: failures inside tryNativeBookStream
  // (which already handles its own metric updates) leave the symbol
  // in the index for the next tick.
  function reevaluatePreemptedSymbols(): void {
    if (preempted.size === 0) return;
    const symbols = Array.from(preempted.keys());
    for (const symbol of symbols) {
      const entry = preempted.get(symbol);
      if (!entry) continue;
      // Defensive — if the symbol still has no book consumers (all
      // working orders terminated since it was preempted), evict.
      const watch = watches.get(symbol);
      if (!watch) {
        preempted.delete(symbol);
        continue;
      }
      let hasBookConsumer = false;
      for (const consumer of watch.consumers.values()) {
        if (consumer.onBook) {
          hasBookConsumer = true;
          break;
        }
      }
      if (!hasBookConsumer) {
        preempted.delete(symbol);
        continue;
      }
      entry.lastAttemptMs = Date.now();
      const ok = tryNativeBookStream(symbol, watch);
      // Reclaim succeeded iff (a) tryNativeBookStream returned true AND
      // (b) the symbol is no longer in the preempted index. The size
      // check alone isn't sufficient — a successful reclaim via
      // preemption-back of a different victim ADDS that victim to the
      // index, leaving the total count unchanged.
      if (ok && !preempted.has(symbol)) {
        opts.bookBudgetMetrics?.bookBudgetReevaluationReclaimTotal.labels({ symbol }).inc();
        logger.info("book-budget reclaimed via re-evaluation", { symbol });
      }
    }
  }

  // Kick off the timer when both an interval AND a budget are set.
  // Without a budget the preemption path never populates the index so
  // the timer would be a no-op.
  const reevaluationIntervalMs = opts.reevaluationIntervalMs ?? 60_000;
  if (reevaluationIntervalMs > 0 && opts.bookBudget) {
    reevaluationTimer = setInterval(() => {
      try {
        reevaluatePreemptedSymbols();
      } catch (err) {
        logger.error("book-budget re-evaluation tick threw", { error: String(err) });
      }
    }, reevaluationIntervalMs);
    // Don't keep the process alive solely for this timer.
    if (typeof reevaluationTimer.unref === "function") reevaluationTimer.unref();
  }

  return {
    subscribe(symbols: string[], callback: QuoteCallback): Subscription {
      // One consumer entry per (subscribe-call, symbol) pairing so
      // each call's unsubscribe() removes exactly its own registrations,
      // even when the same callback function is passed twice.
      const registrations: Array<{ symbol: string; consumerId: string }> = [];
      for (const symbol of symbols) {
        const watch = getOrCreateWatch(symbol);
        const consumerId = nextConsumerId();
        watch.consumers.set(consumerId, { onQuote: callback });
        registrations.push({ symbol, consumerId });
        startUpstreamIfNeeded(symbol, watch);
      }
      return {
        unsubscribe(): void {
          for (const { symbol, consumerId } of registrations) {
            const watch = watches.get(symbol);
            if (!watch) continue;
            watch.consumers.delete(consumerId);
            tearDownIfEmpty(symbol);
          }
        },
      };
    },

    subscribeTrades(symbols: string[], callback: TradeCallback): Subscription | null {
      return subscribeEventStream(
        symbols,
        (consumer) => ({ onTrade: callback, ...consumer }),
        tryNativeTradeStream,
        (watch) => watch.trade_sub !== null,
      );
    },

    subscribeBook(symbols: string[], callback: BookCallback): Subscription | null {
      return subscribeEventStream(
        symbols,
        (consumer) => ({ onBook: callback, ...consumer }),
        tryNativeBookStream,
        (watch) => watch.book_sub !== null,
      );
    },

    flushPending(): void {
      // No-op when backpressure is disabled.
      if (!backpressureEnabled) return;
      for (const watch of watches.values()) {
        drainWatch(watch);
      }
    },

    triggerReevaluationNow(): void {
      reevaluatePreemptedSymbols();
    },

    preemptedSymbols(): readonly string[] {
      return Array.from(preempted.keys());
    },

    close(): void {
      if (reevaluationTimer !== null) {
        clearInterval(reevaluationTimer);
        reevaluationTimer = null;
      }
    },
  };

  // Shared open/probe/commit pattern for the non-quote streams. Walks
  // every requested symbol first to see if at least one adapter can
  // serve the event type for ALL symbols. If any symbol can't be
  // served, returns null so callers can route around the missing
  // capability cleanly (rather than getting a Subscription that fires
  // for some symbols and silently fails on others).
  function subscribeEventStream(
    symbols: string[],
    makeConsumer: (existing: SymbolConsumer) => SymbolConsumer,
    tryOpen: (symbol: string, watch: SymbolWatch) => boolean,
    alreadyOpen: (watch: SymbolWatch) => boolean,
  ): Subscription | null {
    const opens: Array<{ symbol: string; watch: SymbolWatch }> = [];
    for (const symbol of symbols) {
      const watch = getOrCreateWatch(symbol);
      if (!alreadyOpen(watch)) {
        if (!tryOpen(symbol, watch)) {
          // Clean up empty watches we created during probing so the
          // failure path leaves no state behind.
          tearDownIfEmpty(symbol);
          for (const o of opens) tearDownIfEmpty(o.symbol);
          return null;
        }
      }
      opens.push({ symbol, watch });
    }
    const registrations: Array<{ symbol: string; consumerId: string }> = [];
    for (const { symbol, watch } of opens) {
      const consumerId = nextConsumerId();
      watch.consumers.set(consumerId, makeConsumer({}));
      registrations.push({ symbol, consumerId });
    }
    return {
      unsubscribe(): void {
        for (const { symbol, consumerId } of registrations) {
          const watch = watches.get(symbol);
          if (!watch) continue;
          watch.consumers.delete(consumerId);
          tearDownIfEmpty(symbol);
        }
      },
    };
  }
}
