// ── Store API Endpoints ────────────────────────────────────────────
// HTTP endpoints for the data store. Signal-specific endpoints were
// retired with the Arch-A signal subsystem (QF-261).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { StoreQuery } from "./query.js";
import type { Logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface StoreApiDeps {
  storeQuery: StoreQuery;
  logger: Logger;
}

// ── Helpers ─────────────────────────────────────────────────────────

// BigInt-safe replacer — DuckDB returns SUM/COUNT as BigInt which
// JSON.stringify can't serialize natively. Coerce to Number.
const jsonReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);

function json(res: ServerResponse, data: unknown, status: number = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data, jsonReplacer));
}

export function createStoreApi(deps: StoreApiDeps) {
  return {
    async handleStoreSummary(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        // Signal queries retired per QF-261; return empty summary.
        json(res, { signals: { model_count: 0, symbol_count: 0, models: [] } });
      } catch (err) {
        deps.logger.error("Store summary failed", { error: String(err) });
        json(res, { error: "Internal error" }, 500);
      }
    },
  };
}
