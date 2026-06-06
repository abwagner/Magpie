// ── Market Data HTTP API ──────────────────────────────────────────
// Exposes the unified MarketDataService (Schwab → IBKR → MarketData
// fallback chain) over HTTP so external producers can fetch live data
// without picking a source. Signals should always use these endpoints
// instead of calling vendors directly.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MarketDataService, MarketDataAdapter } from "../../src/types/market-data.js";
import { getLastCredits } from "../../src/lib/marketdata-api.js";
import { fetchSchwabPositions, fetchSchwabAccounts } from "../order/adapters/schwab-rest.js";
import type { Logger } from "../logger.js";

// ── Helpers ────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(res: ServerResponse, data: unknown, status: number = 200): void {
  res.writeHead(status, CORS_HEADERS);
  res.end(JSON.stringify(data));
}

function parseParams(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1))) out[k] = v;
  return out;
}

// ── Factory ────────────────────────────────────────────────────────

export interface MarketDataApiDeps {
  service: MarketDataService;
  adapters: MarketDataAdapter[];
  logger: Logger;
  /** QF-55. Optional; when present, /api/data/sources/health is served. */
  metrics?: import("./metrics.js").MetricsRegistry;
}

export function createMarketDataApi(deps: MarketDataApiDeps) {
  const { service, adapters, logger, metrics } = deps;

  return {
    async handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      const results = await Promise.all(
        adapters.map(async (a) => {
          try {
            const ok = await a.available();
            return { name: a.name, available: ok };
          } catch {
            return { name: a.name, available: false };
          }
        }),
      );
      const credits = getLastCredits();
      json(res, { adapters: results, credits });
    },

    async handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (!metrics) {
        json(res, { error: "Metrics registry not configured on this server" }, 503);
        return;
      }
      const { getMarketDataHealth } = await import("./health.js");
      const health = await getMarketDataHealth({ adapters, metrics });
      json(res, health);
    },

    async handleBridges(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (!metrics) {
        json(res, { error: "Metrics registry not configured on this server" }, 503);
        return;
      }
      const { getBridgeStatuses } = await import("./health.js");
      const response = await getBridgeStatuses({ adapters, metrics });
      json(res, response);
    },

    async handleQuote(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const params = parseParams(req.url ?? "");
      if (!params.symbol) {
        json(res, { error: "Missing required param: symbol" }, 400);
        return;
      }
      try {
        const quote = await service.getQuote(params.symbol);
        json(res, quote);
      } catch (e) {
        logger.warn("quote fetch failed", { symbol: params.symbol, error: String(e) });
        json(res, { error: String((e as Error).message ?? e) }, 502);
      }
    },

    async handleExpirations(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const params = parseParams(req.url ?? "");
      if (!params.symbol) {
        json(res, { error: "Missing required param: symbol" }, 400);
        return;
      }
      try {
        const expirations = await service.getExpirations(params.symbol);
        json(res, expirations);
      } catch (e) {
        logger.warn("expirations fetch failed", { symbol: params.symbol, error: String(e) });
        json(res, { error: String((e as Error).message ?? e) }, 502);
      }
    },

    async handleChain(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const params = parseParams(req.url ?? "");
      if (!params.symbol || !params.expiration) {
        json(res, { error: "Missing required params: symbol, expiration" }, 400);
        return;
      }
      try {
        const contracts = await service.getChain(params.symbol, params.expiration);
        json(res, contracts);
      } catch (e) {
        logger.warn("chain fetch failed", {
          symbol: params.symbol,
          expiration: params.expiration,
          error: String(e),
        });
        json(res, { error: String((e as Error).message ?? e) }, 502);
      }
    },

    async handleCandles(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const params = parseParams(req.url ?? "");
      if (!params.symbol || !params.from || !params.to) {
        json(res, { error: "Missing required params: symbol, from, to" }, 400);
        return;
      }
      const frequency = (params.frequency === "minute" ? "minute" : "daily") as "daily" | "minute";
      try {
        const candles = await service.getCandles(params.symbol, params.from, params.to, frequency);
        json(res, candles);
      } catch (e) {
        logger.warn("candles fetch failed", { symbol: params.symbol, error: String(e) });
        json(res, { error: String((e as Error).message ?? e) }, 502);
      }
    },

    async handlePositions(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const params = parseParams(req.url ?? "");
      try {
        const positions = await fetchSchwabPositions(params.account || undefined);
        json(res, positions);
      } catch (e) {
        logger.warn("positions fetch failed", { error: String(e) });
        json(res, { error: String((e as Error).message ?? e) }, 502);
      }
    },

    async handleAccounts(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const accounts = await fetchSchwabAccounts();
        json(res, { accounts });
      } catch (e) {
        logger.warn("accounts fetch failed", { error: String(e) });
        json(res, { error: String((e as Error).message ?? e) }, 502);
      }
    },
  };
}
