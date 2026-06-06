// ── Catalog HTTP Handler ──────────────────────────────────────────
// Thin wrapper that serves GET /api/catalog from a CatalogService.
// Accepts ?refresh=1 to bypass the in-memory TTL cache.
//
// Also serves GET /api/qo-run/:id for per-run drill-down: returns the
// parsed wfo_results JSON for a single qo-run descriptor. QF reads the
// JSON only — never the Optuna SQLite.

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CatalogService } from "./index.js";
import type { Logger } from "../logger.js";

export interface CatalogApiDeps {
  service: CatalogService;
  logger: Logger;
}

// BigInt-safe: DuckDB aggregates come through as BigInt and JSON.stringify
// would throw. Matches the pattern used in server/store/api.ts.
const jsonReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);

function writeJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data, jsonReplacer));
}

export function createCatalogApi(deps: CatalogApiDeps) {
  return {
    async handleCatalog(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const force = url.searchParams.get("refresh") === "1";
        const response = await deps.service.build(force);
        writeJson(res, response);
      } catch (err) {
        deps.logger.error("Catalog build failed", { error: String(err) });
        writeJson(res, { error: "Internal error" }, 500);
      }
    },

    async handleQoRun(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
      try {
        // Look up the qo-run descriptor by id. Server-side caching is the
        // catalog's TTL cache — we let build() decide whether to rebuild.
        const response = await deps.service.build(false);
        const descriptor = response.descriptors.find(
          (d) => d.kind === "qo-run" && d.id === `qo-run:${id}`,
        );
        if (!descriptor) {
          writeJson(res, { error: "qo-run not found" }, 404);
          return;
        }
        const path = descriptor.type_specific?.file_path as string | undefined;
        if (!path) {
          deps.logger.warn("qo-run descriptor missing file_path", { id });
          writeJson(res, { error: "qo-run file path missing" }, 500);
          return;
        }
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        writeJson(res, parsed);
      } catch (err) {
        deps.logger.error("qo-run fetch failed", { id, error: String(err) });
        writeJson(res, { error: "Internal error" }, 500);
      }
    },
  };
}
