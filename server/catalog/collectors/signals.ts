// ── Signals Collector ──────────────────────────────────────────────
// Enumerates datasets from the main DuckDB's `signal_catalog` table,
// then pulls confidence stats from each (model, symbol)'s newest-
// month parquet.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Collector, DatasetDescriptor } from "../types.js";
import type { IndexRelationLookup } from "../indexRelation.js";
import {
  getColumnSchema,
  mtimeToIso,
  parquetLiteral,
  toIsoDate,
  type RunQuery,
} from "../helpers.js";

interface CatalogRow {
  model_id: string;
  model_version: string;
  symbol: string;
  date_min: string;
  date_max: string;
  row_count: number;
  month_count: number;
  newest_month: string;
}

export interface SignalsCollectorDeps {
  runQuery: RunQuery;
  signalsDir: string;
  indexRelation: IndexRelationLookup;
}

export function createSignalsCollector(deps: SignalsCollectorDeps): Collector {
  return {
    kind: "signals",
    async describe(): Promise<DatasetDescriptor[]> {
      let rows: CatalogRow[];
      try {
        rows = await deps.runQuery<CatalogRow>(`
          SELECT
            model_id,
            model_version,
            symbol,
            MIN(date_min) AS date_min,
            MAX(date_max) AS date_max,
            CAST(SUM(row_count) AS INTEGER) AS row_count,
            CAST(COUNT(*) AS INTEGER) AS month_count,
            MAX(month) AS newest_month
          FROM signal_catalog
          GROUP BY model_id, model_version, symbol
          ORDER BY model_id, symbol
        `);
      } catch {
        return [];
      }

      const descriptors: DatasetDescriptor[] = [];
      for (const r of rows) {
        const { size, mtimeMs, confStats } = await summarize(deps, r);
        // Signals span multiple month-partitioned parquets per (model,symbol);
        // the descriptor's parquet_uri is the symbol's glob so consumers read
        // the full series in one read_parquet() call.
        const symbolFile = r.symbol.replace(/:/g, "-");
        const parquetGlob = join(deps.signalsDir, r.model_id, `${symbolFile}-*.parquet`);
        const columnSchema = await getColumnSchema(parquetGlob, deps.runQuery);
        descriptors.push({
          id: `signals:${r.model_id}:${r.model_version}:${r.symbol}`,
          kind: "signals",
          label: `${r.model_id} · ${r.symbol}`,
          symbols: [r.symbol],
          date_min: toIsoDate(r.date_min),
          date_max: toIsoDate(r.date_max),
          granularity: "event",
          row_count: Number(r.row_count),
          file_count: Number(r.month_count),
          size_bytes: size,
          last_updated: mtimeMs ? mtimeToIso(mtimeMs) : null,
          source: "NATS ingest",
          index_relation: deps.indexRelation.classify(r.symbol),
          type_specific: {
            model_id: r.model_id,
            model_version: r.model_version,
            newest_month: r.newest_month,
            confidence_p50: confStats.p50,
            confidence_p90: confStats.p90,
            kinds: confStats.kinds,
          },
          parquet_uri: parquetGlob,
          column_schema: columnSchema,
        });
      }
      return descriptors;
    },
  };
}

// Read size/mtime from the newest-month parquet and pull confidence
// distribution + distinct kinds from that same file only. Keeps the
// per-descriptor cost bounded to one small file read.
async function summarize(
  deps: SignalsCollectorDeps,
  row: CatalogRow,
): Promise<{
  size: number;
  mtimeMs: number;
  confStats: { p50: number | null; p90: number | null; kinds: string[] };
}> {
  const symbolFile = row.symbol.replace(/:/g, "-");
  const path = join(deps.signalsDir, row.model_id, `${symbolFile}-${row.newest_month}.parquet`);
  let size = 0;
  let mtimeMs = 0;
  if (existsSync(path)) {
    try {
      const st = statSync(path);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* ignore */
    }
  }

  let confStats: { p50: number | null; p90: number | null; kinds: string[] } = {
    p50: null,
    p90: null,
    kinds: [],
  };
  if (mtimeMs > 0) {
    try {
      const result = await deps.runQuery<Record<string, unknown>>(`
        SELECT
          quantile_cont(confidence, 0.5) AS p50,
          quantile_cont(confidence, 0.9) AS p90,
          array_agg(DISTINCT kind) AS kinds
        FROM read_parquet(${parquetLiteral(path)})
      `);
      const r = result[0];
      if (r) {
        confStats = {
          p50: r.p50 == null ? null : Number(r.p50),
          p90: r.p90 == null ? null : Number(r.p90),
          kinds: Array.isArray(r.kinds) ? (r.kinds as string[]) : [],
        };
      }
    } catch {
      /* ignore */
    }
  }
  return { size, mtimeMs, confStats };
}
