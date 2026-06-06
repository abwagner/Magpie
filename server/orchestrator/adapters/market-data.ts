// ── Market Data Adapter ────────────────────────────────────────────
// Wraps the existing MarketDataService (ibkr → schwab → marketdata.app
// fallback chain) into the orchestrator's DataAdapter interface.
//
// Handles: quotes, option chains, and futures curves.
// The existing service manages auth, caching, rate limits, and fallback.

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import type { MarketDataService, Quote, Contract } from "../../../src/types/market-data.js";

export function createMarketDataAdapter(
  service: MarketDataService,
  adapterId: string = "marketdata",
): DataAdapter {
  return {
    id: adapterId,
    capabilities: { batch: true, streaming: false, maxConcurrent: 50 },

    supportsRequest(args: Record<string, unknown>): boolean {
      const type = args.type as string | undefined;
      return type === "quote" || type === "chain" || type === "candles";
    },

    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];

      // Process concurrently within the adapter's concurrency limit
      const tasks = requests.map(async (req): Promise<DataResult> => {
        const type = req.args.type as string | undefined;

        try {
          switch (type) {
            case "quote": {
              const symbol = req.args.symbol as string;
              const quote = await service.getQuote(symbol);
              return {
                request: req,
                ok: true,
                dataThrough: quote.timestamp,
                data: quote,
              };
            }

            case "chain": {
              const symbol = req.args.symbol as string;
              const dteMin = (req.args.dte_min as number) ?? 0;
              const strikesAround = (req.args.strikes_around_atm as number) ?? 50;

              // Get nearest qualifying expiration
              const expirations = await service.getExpirations(symbol);
              const today = new Date();
              const qualifying = expirations.filter((exp) => {
                const dte = Math.floor((new Date(exp).getTime() - today.getTime()) / 86_400_000);
                return dte >= dteMin;
              });

              if (qualifying.length === 0) {
                return { request: req, ok: false, error: "No qualifying expirations" };
              }

              const expiration = qualifying[0]!;
              const contracts = await service.getChain(symbol, expiration);

              // Filter to N strikes around ATM
              const underlying = contracts[0]?.underlyingPrice;
              let filtered = contracts;
              if (underlying != null && strikesAround < 50) {
                const strikes = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);
                const atmIdx = strikes.findIndex((s) => s >= underlying);
                const lo = Math.max(0, atmIdx - strikesAround);
                const hi = Math.min(strikes.length, atmIdx + strikesAround);
                const keepStrikes = new Set(strikes.slice(lo, hi));
                filtered = contracts.filter((c) => keepStrikes.has(c.strike));
              }

              return {
                request: req,
                ok: true,
                dataThrough: new Date().toISOString(),
                data: { expiration, contracts: filtered },
              };
            }

            case "candles": {
              const sym = req.args.symbol as string;
              const from = (req.args.from as string) ?? "2019-01-01";
              const to = (req.args.to as string) ?? new Date().toISOString().slice(0, 10);
              const freq = (req.args.frequency as "daily" | "minute") ?? "daily";

              const candles = await service.getCandles(sym, from, to, freq);
              const lastDate = candles.length > 0 ? candles[candles.length - 1]!.date : undefined;

              return {
                request: req,
                ok: true,
                dataThrough: lastDate,
                data: candles,
              };
            }

            default:
              return { request: req, ok: false, error: `Unknown request type: ${type}` };
          }
        } catch (e) {
          return { request: req, ok: false, error: String(e) };
        }
      });

      return Promise.all(tasks);
    },
  };
}

/**
 * Create separate adapter IDs that all delegate to the same MarketDataService.
 * This allows manifests to reference source: "ibkr" or source: "marketdata"
 * and the service handles fallback internally.
 */
export function createMarketDataAdapters(service: MarketDataService): DataAdapter[] {
  // All share the same underlying service — the fallback chain is internal
  return [
    createMarketDataAdapter(service, "ibkr"),
    createMarketDataAdapter(service, "schwab"),
    createMarketDataAdapter(service, "marketdata"),
  ];
}
