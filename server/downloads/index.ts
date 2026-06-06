// ── Downloads Service ─────────────────────────────────────────────
// Owns the registry of source aggregators and serves the
// /api/downloads/* endpoints. Mirrors server/catalog/index.ts so
// adding a new source is one createXxxSource(...) call below.

import { resolve } from "node:path";
import type { Logger } from "../logger.js";
import type { DownloadRun, RunActivityResponse, RunsResponse, SourceAggregator } from "./types.js";
import { createChainsNightlySource } from "./sources/chains-nightly.js";
import { createSidecarSource } from "./sources/sidecar-source.js";
import { createMtimeSource } from "./sources/mtime-source.js";

export interface DownloadsDeps {
  rootDir: string;
  logger: Logger;
}

export interface DownloadsService {
  listRuns(force?: boolean): Promise<RunsResponse>;
  getRun(id: string): Promise<RunActivityResponse | null>;
}

const CACHE_TTL_MS = 60_000;
const RUN_LIMIT = 50;

export function createDownloadsService(deps: DownloadsDeps): DownloadsService {
  const dataDir = resolve(deps.rootDir, "data");

  const sources: SourceAggregator[] = [
    createChainsNightlySource({ chainsDir: resolve(dataDir, "chains") }),
    createSidecarSource({
      source: "marketdata.app:chains-refresh",
      idPrefix: "chains-refresh",
      dir: resolve(dataDir, "chains"),
    }),
    createSidecarSource({
      source: "marketdata.app:etf",
      idPrefix: "etf",
      dir: resolve(dataDir, "etfs"),
    }),
    createMtimeSource({
      source: "fred",
      idPrefix: "fred",
      rootDir: resolve(dataDir, "macro/fred"),
      maxDays: 14,
    }),
    createMtimeSource({
      source: "eia",
      idPrefix: "eia",
      rootDir: resolve(dataDir, "macro/eia"),
      maxDays: 14,
    }),
    createMtimeSource({
      source: "databento",
      idPrefix: "databento",
      rootDir: resolve(dataDir, "databento"),
      maxDays: 14,
    }),
    createMtimeSource({
      source: "futures",
      idPrefix: "futures",
      rootDir: resolve(dataDir, "futures"),
      maxDays: 14,
    }),
  ];

  let cache: { at: number; response: RunsResponse } | null = null;

  async function rebuild(): Promise<RunsResponse> {
    const settled = await Promise.all(
      sources.map(async (s) => {
        try {
          return await s.list();
        } catch (err) {
          deps.logger.warn("Source failed", { source: s.source, error: String(err) });
          return [] as DownloadRun[];
        }
      }),
    );
    const flat = settled.flat();
    flat.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    const runs = flat.slice(0, RUN_LIMIT);
    const sourceList = sources.map((s) => s.source);
    return {
      generated_at: new Date().toISOString(),
      runs,
      sources: sourceList,
    };
  }

  return {
    async listRuns(force = false): Promise<RunsResponse> {
      const now = Date.now();
      if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.response;
      const response = await rebuild();
      cache = { at: Date.now(), response };
      return response;
    },

    async getRun(id: string): Promise<RunActivityResponse | null> {
      // We need both the run summary and the source's activity payload.
      // Look up the run from the (cached) list first, then ask the
      // owning source for activity.
      const { runs } = await this.listRuns(false);
      const run = runs.find((r) => r.id === id);
      if (!run) return null;
      const owner = sources.find((s) => s.source === run.source);
      if (!owner || !owner.detail) {
        return { run, activity: [] };
      }
      const activity = (await owner.detail(id)) ?? [];
      return { run, activity };
    },
  };
}
