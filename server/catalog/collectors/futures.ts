// ── Futures Collector ──────────────────────────────────────────────
// Walks data/futures/{root}/*.parquet and emits one descriptor per
// file. Granularity is inferred from the filename (ohlcv_1d →
// daily, mbp_1 → event, etc.) since the same root has many
// resolutions.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Collector, DatasetDescriptor, Granularity } from "../types.js";
import type { IndexRelationLookup } from "../indexRelation.js";
import {
  getColumnSchema,
  listFiles,
  mtimeToIso,
  parquetLiteral,
  toIsoDate,
  type RunQuery,
} from "../helpers.js";

export interface FuturesCollectorDeps {
  runQuery: RunQuery;
  futuresDir: string;
  indexRelation: IndexRelationLookup;
}

interface InferredMeta {
  granularity: Granularity;
  label: string;
  /** Human/programmatic bar interval ("1m", "5m", "1h", "1d") for OHLCV;
   *  null for non-bar event data. Exposed via type_specific.bar_interval
   *  so QO loaders don't have to re-parse filename conventions (OQ8). */
  barInterval: string | null;
}

function inferGranularity(filename: string): InferredMeta {
  const stem = filename.replace(/\.parquet$/, "");
  switch (stem) {
    case "ohlcv_1d":
      return { granularity: "daily", label: "daily OHLCV", barInterval: "1d" };
    case "ohlcv_1h":
      return { granularity: "intraday-1h", label: "1-hour OHLCV", barInterval: "1h" };
    case "ohlcv_5m":
      return { granularity: "intraday-5m", label: "5-minute OHLCV", barInterval: "5m" };
    case "ohlcv_1m":
      return { granularity: "intraday-1m", label: "1-minute OHLCV", barInterval: "1m" };
    case "ohlcv_1s":
      return { granularity: "intraday-1s", label: "1-second OHLCV", barInterval: "1s" };
    case "mbp_1":
      return { granularity: "event", label: "market-by-price (L1)", barInterval: null };
    case "trades":
      return { granularity: "event", label: "trade prints", barInterval: null };
    default:
      return { granularity: "event", label: stem, barInterval: null };
  }
}

export function createFuturesCollector(deps: FuturesCollectorDeps): Collector {
  return {
    kind: "futures",
    async describe(): Promise<DatasetDescriptor[]> {
      let roots: string[];
      try {
        roots = readdirSync(deps.futuresDir);
      } catch {
        return [];
      }

      const descriptors: DatasetDescriptor[] = [];

      for (const root of roots) {
        const rootDir = join(deps.futuresDir, root);
        const files = listFiles(rootDir, (n) => n.endsWith(".parquet"));
        const rootUpper = root.toUpperCase();

        for (const f of files) {
          const { granularity, label, barInterval } = inferGranularity(f.name);
          const columnSchema = await getColumnSchema(f.path, deps.runQuery);

          let dateMin: string | null = null;
          let dateMax: string | null = null;
          let rowCount = 0;
          try {
            // All futures parquets use `datetime` for the time column.
            const rows = await deps.runQuery<Record<string, unknown>>(`
              SELECT
                MIN(datetime) AS date_min,
                MAX(datetime) AS date_max,
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

          descriptors.push({
            id: `futures:${root}:${f.name.replace(/\.parquet$/, "")}`,
            kind: "futures",
            label: `/${rootUpper} ${label}`,
            symbols: [`/${rootUpper}`],
            date_min: dateMin,
            date_max: dateMax,
            granularity,
            row_count: rowCount,
            file_count: 1,
            size_bytes: f.size,
            last_updated: mtimeToIso(f.mtimeMs),
            source: "databento",
            index_relation: deps.indexRelation.classify(`/${rootUpper}`),
            type_specific: {
              root: rootUpper,
              schema: f.name.replace(/\.parquet$/, ""),
              ...(barInterval !== null && { bar_interval: barInterval }),
              // Databento OHLCV parquets are UTC-normalized at ingest time
              // (see scripts/collect-history.js); strategy adapters can rely
              // on this without re-checking the timestamp column type (OQ8).
              tz: "UTC",
            },
            parquet_uri: f.path,
            column_schema: columnSchema,
          });
        }
      }
      return descriptors;
    },
  };
}
