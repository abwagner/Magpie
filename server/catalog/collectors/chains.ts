// ── Chains Collector ───────────────────────────────────────────────
// Wraps the existing storage.getSummary() and adds strike/expiration
// aggregates on top. Strike stats are computed from each symbol's
// most-recent monthly parquet only (single-file read) — a full-glob
// scan of 45k files would dominate request latency.

import { readdirSync, statSync } from "node:fs";
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

interface SummaryRow {
  symbol: string;
  date_min: string;
  date_max: string;
  trading_days: number;
  total_rows: number;
  price_min: number;
  price_max: number;
  files: number;
}

interface ChainsStorage {
  getSummary(): Promise<SummaryRow[]>;
}

interface SymbolFileStats {
  size: number;
  mtimeMs: number;
  newestFile: string | null;
}

export interface ChainsCollectorDeps {
  storage: ChainsStorage;
  runQuery: RunQuery;
  chainsDir: string;
  indexRelation: IndexRelationLookup;
}

// Walk data/chains once to compute per-symbol on-disk size, max mtime,
// and the filename of the newest month — avoids 45k individual
// statSync calls spread across collector passes.
function scanChainFiles(chainsDir: string): Map<string, SymbolFileStats> {
  const out = new Map<string, SymbolFileStats>();
  let entries: string[];
  try {
    entries = readdirSync(chainsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".parquet")) continue;
    const m = name.match(/^(.+)-(\d{4}-\d{2})\.parquet$/);
    if (!m || !m[1]) continue;
    const sym = m[1];
    const path = join(chainsDir, name);
    try {
      const st = statSync(path);
      const prev = out.get(sym);
      if (prev) {
        prev.size += st.size;
        if (st.mtimeMs > prev.mtimeMs) {
          prev.mtimeMs = st.mtimeMs;
          prev.newestFile = path;
        }
      } else {
        out.set(sym, { size: st.size, mtimeMs: st.mtimeMs, newestFile: path });
      }
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

interface RecentAgg {
  latest_date: string | null;
  strike_count: number;
  expiration_count: number;
  dte_min: number;
  dte_max: number;
  strike_width_pct: number;
}

// Read strike/expiration depth from only the newest-month parquet file
// for the symbol, limited to its latest date. Keeps the request cheap
// while still answering "what does a typical recent snapshot look
// like?".
async function recentAgg(runQuery: RunQuery, parquetPath: string): Promise<RecentAgg | null> {
  try {
    const rows = await runQuery<Record<string, unknown>>(`
      WITH latest AS (
        SELECT MAX(date) AS d FROM read_parquet(${parquetLiteral(parquetPath)})
      )
      SELECT
        (SELECT d FROM latest) AS latest_date,
        COUNT(DISTINCT strike) AS strike_count,
        COUNT(DISTINCT expiration) AS expiration_count,
        MIN(dte) AS dte_min,
        MAX(dte) AS dte_max,
        MIN(underlyingPrice) AS spot_min,
        MIN(strike) AS strike_min,
        MAX(strike) AS strike_max
      FROM read_parquet(${parquetLiteral(parquetPath)})
      WHERE date = (SELECT d FROM latest)
    `);
    const r = rows[0];
    if (!r) return null;
    const spot = Number(r.spot_min ?? 0);
    const smin = Number(r.strike_min ?? 0);
    const smax = Number(r.strike_max ?? 0);
    const halfWidth = spot > 0 ? Math.max(smax - spot, spot - smin) : 0;
    return {
      latest_date: toIsoDate(r.latest_date),
      strike_count: Number(r.strike_count ?? 0),
      expiration_count: Number(r.expiration_count ?? 0),
      dte_min: Number(r.dte_min ?? 0),
      dte_max: Number(r.dte_max ?? 0),
      strike_width_pct: spot > 0 ? Math.round((halfWidth / spot) * 1000) / 10 : 0,
    };
  } catch {
    return null;
  }
}

export function createChainsCollector(deps: ChainsCollectorDeps): Collector {
  return {
    kind: "chains",
    async describe(): Promise<DatasetDescriptor[]> {
      const summary = await deps.storage.getSummary();
      if (summary.length === 0) return [];

      const fileStats = scanChainFiles(deps.chainsDir);
      const descriptors: DatasetDescriptor[] = [];

      // Sequential: the RunQuery queue enforces one-in-flight anyway,
      // and 500 symbols × ~50ms each is still under 30 seconds on a
      // cold cache.
      for (const row of summary) {
        const stat = fileStats.get(row.symbol);
        const agg = stat?.newestFile ? await recentAgg(deps.runQuery, stat.newestFile) : null;
        // Chains span monthly parquets per symbol; parquet_uri is the
        // symbol's glob so QO consumers read the whole series in one go.
        const parquetGlob = `${deps.chainsDir}/${row.symbol}-*.parquet`;
        const columnSchema = await getColumnSchema(parquetGlob, deps.runQuery);

        descriptors.push({
          id: `chains:${row.symbol}`,
          kind: "chains",
          label: `${row.symbol} options`,
          symbols: [row.symbol],
          date_min: toIsoDate(row.date_min),
          date_max: toIsoDate(row.date_max),
          granularity: "daily",
          row_count: Number(row.total_rows),
          file_count: Number(row.files),
          size_bytes: stat?.size ?? 0,
          last_updated: stat?.mtimeMs ? mtimeToIso(stat.mtimeMs) : null,
          source: "marketdata.app",
          index_relation: deps.indexRelation.classify(row.symbol),
          type_specific: {
            trading_days: Number(row.trading_days),
            price_min: Number(row.price_min),
            price_max: Number(row.price_max),
            recent_date: agg?.latest_date ?? null,
            strike_count: agg?.strike_count ?? 0,
            expiration_count: agg?.expiration_count ?? 0,
            dte_min: agg?.dte_min ?? 0,
            dte_max: agg?.dte_max ?? 0,
            strike_width_pct: agg?.strike_width_pct ?? 0,
          },
          parquet_uri: parquetGlob,
          column_schema: columnSchema,
        });
      }

      return descriptors;
    },
  };
}
