// ── Market Data HTTP API ──────────────────────────────────────────
// Exposes the unified MarketDataService (Schwab → IBKR → MarketData
// fallback chain) over HTTP so external producers can fetch live data
// without picking a source. Signals should always use these endpoints
// instead of calling vendors directly.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MarketDataService, MarketDataAdapter } from "../../src/types/market-data.js";
import type { BrokerAdapter } from "../../src/types/order.js";
import { getLastCredits } from "../../src/lib/marketdata-api.js";
import { fetchSchwabPositions, fetchSchwabAccounts } from "../order/adapters/schwab-rest.js";
import { parseSchwabPositionRows } from "../order/positions/parse-schwab-positions.js";
import { enrichPositionGreeks } from "./enrich-position-greeks.js";
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
  /**
   * QF-272 — active broker adapter (the live Schwab NT bridge in
   * practice). When present, /api/positions and /api/accounts source
   * their data through it (same Schwab snapshot as the REST path) and
   * fall back to the schwab-rest REST client when NT errors / is absent.
   */
  broker?: BrokerAdapter;
  /**
   * QF-341 — read-only MD fallback policy header for /api/marketdata/bridges
   * (Settings → Bridges). Sourced from config/brokers.json marketdata block.
   */
  fallbackPolicy?: import("./health.js").BridgePolicy;
  /**
   * QF-341 — live set of brokers currently serving as a fallback target.
   * Usually `selector.brokersServingAsFallback.bind(selector)`.
   */
  brokersServingAsFallback?: () => Set<string>;
}

export function createMarketDataApi(deps: MarketDataApiDeps) {
  const { service, adapters, logger, metrics, broker, fallbackPolicy, brokersServingAsFallback } =
    deps;

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
      const response = await getBridgeStatuses({
        adapters,
        metrics,
        ...(fallbackPolicy ? { policy: fallbackPolicy } : {}),
        ...(brokersServingAsFallback
          ? { brokersServingAsFallback: brokersServingAsFallback() }
          : {}),
      });
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
      // QF-272 — prefer the NT bridge (the live Schwab connection) for the
      // default (no specific account) case; it forwards the same raw
      // Schwab snapshot rows, which the shared parser categorizes. An
      // explicit ?account= hash stays on the REST path (the single-account
      // NT bridge can't scope to an arbitrary hash). REST is the fallback
      // whenever NT is absent or errors.
      if (broker && !params.account) {
        try {
          const positions = await broker.getPositions();
          const rows = positions
            .map((p) => p.raw)
            .filter((r): r is Record<string, unknown> => r != null);
          // QF-355 — fill held-option greeks from the live MD chain.
          json(res, await enrichPositionGreeks(parseSchwabPositionRows(rows), service, logger));
          return;
        } catch (e) {
          logger.warn("positions via NT failed; falling back to schwab-rest", {
            error: String(e),
          });
        }
      }
      try {
        const positions = await fetchSchwabPositions(params.account || undefined);
        json(res, await enrichPositionGreeks(positions, service, logger));
      } catch (e) {
        logger.warn("positions fetch failed", { error: String(e) });
        json(res, { error: String((e as Error).message ?? e) }, 502);
      }
    },

    async handleAccounts(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      // QF-272 — prefer the NT bridge's accounts subject; fall back to the
      // schwab-rest REST client when NT is absent or errors.
      if (broker?.getAccounts) {
        try {
          const accounts = await broker.getAccounts();
          json(res, { accounts });
          return;
        } catch (e) {
          logger.warn("accounts via NT failed; falling back to schwab-rest", {
            error: String(e),
          });
        }
      }
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
