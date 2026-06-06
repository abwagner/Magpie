// ── Macro Collector ────────────────────────────────────────────────
// Walks data/macro/{fred,cftc,eia}/*.parquet and emits one descriptor
// per series. Frequency (daily/weekly/monthly) is inferred from the
// median gap between observations — FRED has mixed cadences and the
// per-series mix is not declared anywhere we can read.

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

export interface MacroCollectorDeps {
  runQuery: RunQuery;
  macroDir: string;
  indexRelation: IndexRelationLookup;
}

function frequencyFromMedianGap(days: number): Granularity {
  if (days <= 2) return "daily";
  if (days <= 10) return "weekly";
  return "monthly";
}

export function createMacroCollector(deps: MacroCollectorDeps): Collector {
  return {
    kind: "macro",
    async describe(): Promise<DatasetDescriptor[]> {
      let sources: string[];
      try {
        sources = readdirSync(deps.macroDir);
      } catch {
        return [];
      }

      const descriptors: DatasetDescriptor[] = [];

      for (const source of sources) {
        const sourceDir = join(deps.macroDir, source);
        const files = listFiles(sourceDir, (n) => n.endsWith(".parquet"));

        for (const f of files) {
          const seriesCode = f.name.replace(/\.parquet$/, "");

          let dateMin: string | null = null;
          let dateMax: string | null = null;
          let rowCount = 0;
          let medianGapDays = 1;
          try {
            const rows = await deps.runQuery<Record<string, unknown>>(`
              WITH gaps AS (
                SELECT date_diff('day', LAG(date) OVER (ORDER BY date), date) AS gap
                FROM read_parquet(${parquetLiteral(f.path)})
              )
              SELECT
                (SELECT MIN(date) FROM read_parquet(${parquetLiteral(f.path)})) AS date_min,
                (SELECT MAX(date) FROM read_parquet(${parquetLiteral(f.path)})) AS date_max,
                (SELECT COUNT(*) FROM read_parquet(${parquetLiteral(f.path)})) AS n,
                median(gap) AS median_gap
              FROM gaps
            `);
            const r = rows[0];
            if (r) {
              dateMin = toIsoDate(r.date_min);
              dateMax = toIsoDate(r.date_max);
              rowCount = Number(r.n ?? 0);
              medianGapDays = Math.max(1, Number(r.median_gap ?? 1));
            }
          } catch {
            /* skip file */
          }

          const granularity = frequencyFromMedianGap(medianGapDays);
          const columnSchema = await getColumnSchema(f.path, deps.runQuery);

          descriptors.push({
            id: `macro:${source}:${seriesCode}`,
            kind: "macro",
            label: `${source.toUpperCase()} · ${seriesCode}`,
            symbols: [],
            date_min: dateMin,
            date_max: dateMax,
            granularity,
            row_count: rowCount,
            file_count: 1,
            size_bytes: f.size,
            last_updated: mtimeToIso(f.mtimeMs),
            source: source.toUpperCase(),
            index_relation: deps.indexRelation.classify(seriesCode),
            type_specific: {
              series_code: seriesCode,
              provider: source,
              median_gap_days: medianGapDays,
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
