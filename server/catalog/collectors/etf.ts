// ── ETF Collector ──────────────────────────────────────────────────
// Emits one descriptor per data/etfs/{SYMBOL}.parquet. Sidecar meta
// files are consulted for source/freshness hints when present.

import { existsSync, readFileSync } from "node:fs";
import type { Collector, DatasetDescriptor } from "../types.js";
import type { IndexRelationLookup } from "../indexRelation.js";
import {
  getColumnSchema,
  listFiles,
  mtimeToIso,
  parquetLiteral,
  toIsoDate,
  type RunQuery,
} from "../helpers.js";

interface EtfMeta {
  fetched_at?: string;
  data_as_of?: string;
  rows_returned?: number;
  http_status?: number;
}

export interface EtfCollectorDeps {
  runQuery: RunQuery;
  etfsDir: string;
  indexRelation: IndexRelationLookup;
}

function readMeta(path: string): EtfMeta | null {
  const metaPath = `${path}.meta.json`;
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as EtfMeta;
  } catch {
    return null;
  }
}

export function createEtfCollector(deps: EtfCollectorDeps): Collector {
  return {
    kind: "etf",
    async describe(): Promise<DatasetDescriptor[]> {
      const files = listFiles(deps.etfsDir, (n) => n.endsWith(".parquet"));
      if (files.length === 0) return [];

      const descriptors: DatasetDescriptor[] = [];

      for (const f of files) {
        const symbol = f.name.replace(/\.parquet$/, "");
        const meta = readMeta(f.path);

        let dateMin: string | null = null;
        let dateMax: string | null = null;
        let rowCount = 0;
        try {
          const rows = await deps.runQuery<Record<string, unknown>>(`
            SELECT
              MIN(date) AS date_min,
              MAX(date) AS date_max,
              COUNT(*) AS n
            FROM read_parquet(${parquetLiteral(f.path)})
          `);
          const r = rows[0];
          if (r) {
            dateMin = toIsoDate(r.date_min);
            dateMax = toIsoDate(r.date_max);
            rowCount = Number(r.n ?? 0);
          }
        } catch {
          /* skip file */
        }

        const columnSchema = await getColumnSchema(f.path, deps.runQuery);

        descriptors.push({
          id: `etf:${symbol}`,
          kind: "etf",
          label: `${symbol} daily OHLCV`,
          symbols: [symbol],
          date_min: dateMin,
          date_max: dateMax,
          granularity: "daily",
          row_count: rowCount,
          file_count: 1,
          size_bytes: f.size,
          last_updated: mtimeToIso(f.mtimeMs),
          source: meta?.http_status ? "marketdata.app" : "unknown",
          index_relation: deps.indexRelation.classify(symbol),
          type_specific: {
            fetched_at: meta?.fetched_at ?? null,
            data_as_of: meta?.data_as_of ?? null,
          },
          parquet_uri: f.path,
          column_schema: columnSchema,
        });
      }
      return descriptors;
    },
  };
}
