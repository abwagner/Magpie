// ── Downloads HTTP Handler ────────────────────────────────────────
// GET /api/downloads/runs[?refresh=1]    — list recent runs across sources
// GET /api/downloads/runs/:id            — per-run activity drilldown

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DownloadsService } from "./index.js";
import type { Logger } from "../logger.js";

export interface DownloadsApiDeps {
  service: DownloadsService;
  logger: Logger;
}

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

export function createDownloadsApi(deps: DownloadsApiDeps) {
  return {
    async handleRuns(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const force = url.searchParams.get("refresh") === "1";
        const response = await deps.service.listRuns(force);
        writeJson(res, response);
      } catch (err) {
        deps.logger.error("Downloads list failed", { error: String(err) });
        writeJson(res, { error: "Internal error" }, 500);
      }
    },

    async handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        // /api/downloads/runs/:id — id may contain ":" so take everything after /runs/
        const m = url.pathname.match(/^\/api\/downloads\/runs\/(.+)$/);
        const id = m?.[1] ? decodeURIComponent(m[1]) : null;
        if (!id) {
          writeJson(res, { error: "Missing run id" }, 400);
          return;
        }
        const detail = await deps.service.getRun(id);
        if (!detail) {
          writeJson(res, { error: "Run not found" }, 404);
          return;
        }
        writeJson(res, detail);
      } catch (err) {
        deps.logger.error("Downloads detail failed", { error: String(err) });
        writeJson(res, { error: "Internal error" }, 500);
      }
    },
  };
}
