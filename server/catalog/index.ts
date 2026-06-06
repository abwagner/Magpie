// ── Catalog Aggregator ────────────────────────────────────────────
// Owns the list of collectors and serves the /api/catalog endpoint.
// Adding a new dataset kind = write one Collector and register it in
// the registry array below. The UI layer does not change.

import { resolve } from "node:path";
import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type { CatalogResponse, Collector, DatasetDescriptor } from "./types.js";
import { createIndexRelationLookup, type IndexRelationLookup } from "./indexRelation.js";
import { makeSerialRunQuery, type RunQuery } from "./helpers.js";
import { createChainsCollector } from "./collectors/chains.js";
import { createEtfCollector } from "./collectors/etf.js";
import { createFuturesCollector } from "./collectors/futures.js";
import { createMacroCollector } from "./collectors/macro.js";
import { createFillsCollector } from "./collectors/fills.js";
import { createBacktestCollector } from "./collectors/backtest.js";
import { createQoRunsCollector } from "./collectors/qo-runs.js";

interface ChainsStorage {
  getSummary(): Promise<unknown[]>;
}

export interface CatalogDeps {
  db: Database;
  storage: ChainsStorage;
  rootDir: string;
  logger: Logger;
}

export interface CatalogService {
  build(force?: boolean): Promise<CatalogResponse>;
}

const CACHE_TTL_MS = 60_000;

export function createCatalogService(deps: CatalogDeps): CatalogService {
  const dataDir = resolve(deps.rootDir, "data");
  const universePath = resolve(deps.rootDir, "config/universe.txt");
  const indexRelation: IndexRelationLookup = createIndexRelationLookup(universePath);

  // One connection + one serial queue for all DuckDB-backed collectors.
  // The node-duckdb binding rejects overlapping `.all()` calls on the
  // same connection, so we funnel every query through a single promise
  // chain.
  const conn = deps.db.connect();
  const runQuery: RunQuery = makeSerialRunQuery(conn);

  const registry: Collector[] = [
    createChainsCollector({
      storage: deps.storage as { getSummary: () => Promise<never[]> },
      runQuery,
      chainsDir: resolve(dataDir, "chains"),
      indexRelation,
    }),
    createEtfCollector({
      runQuery,
      etfsDir: resolve(dataDir, "etfs"),
      indexRelation,
    }),
    createFuturesCollector({
      runQuery,
      futuresDir: resolve(dataDir, "futures"),
      indexRelation,
    }),
    createMacroCollector({
      runQuery,
      macroDir: resolve(dataDir, "macro"),
      indexRelation,
    }),
    createFillsCollector({
      fillsDir: resolve(dataDir, "fills"),
      indexRelation,
    }),
    createBacktestCollector({
      resultsDir: resolve(dataDir, "results"),
      indexRelation,
    }),
    createQoRunsCollector({
      resultsDir: resolve(dataDir, "results", "qo"),
      indexRelation,
    }),
  ];

  let cache: { at: number; response: CatalogResponse } | null = null;
  let inflight: Promise<CatalogResponse> | null = null;

  async function runRegistry(): Promise<CatalogResponse> {
    // Run collectors concurrently — each one still serializes its own
    // SQL through the shared queue, but we keep the two filesystem-
    // only collectors (fills, backtest) from blocking behind DuckDB.
    const results = await Promise.all(
      registry.map(async (c) => {
        try {
          return await c.describe();
        } catch (err) {
          deps.logger.warn("Collector failed", { kind: c.kind, error: String(err) });
          return [] as DatasetDescriptor[];
        }
      }),
    );
    const descriptors = results.flat();
    return {
      // Bumped to 1.1 in QF-174 — descriptors now include parquet_uri +
      // column_schema. Older consumers reading absent/1.0 still get the
      // same shape sans those fields, but the wire is 1.1.
      schema_version: "1.1",
      generated_at: new Date().toISOString(),
      descriptors,
    };
  }

  return {
    async build(force = false): Promise<CatalogResponse> {
      const now = Date.now();
      if (!force && cache && now - cache.at < CACHE_TTL_MS) {
        return cache.response;
      }
      if (inflight) return inflight;

      inflight = (async () => {
        const response = await runRegistry();
        cache = { at: Date.now(), response };
        inflight = null;
        return response;
      })();
      return inflight;
    },
  };
}
