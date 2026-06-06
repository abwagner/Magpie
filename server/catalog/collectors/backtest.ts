// ── Backtest Collector ─────────────────────────────────────────────
// Reads data/results/*.json (one run per file). Filename convention:
// {symbol}-{strategy-kebab}-{run_ms}.json. We only parse the header
// (config + summary) — the full trade array is lazy-loaded on
// expander open.

import { readFileSync } from "node:fs";
import type { Collector, DatasetDescriptor } from "../types.js";
import type { IndexRelationLookup } from "../indexRelation.js";
import { listFiles, mtimeToIso } from "../helpers.js";

interface BacktestResultHeader {
  config?: {
    symbol?: string;
    startDate?: string;
    endDate?: string;
    strategy?: string;
  };
  summary?: {
    totalPnl?: number;
    totalTrades?: number;
    winRate?: string;
    maxDrawdown?: number;
    profitFactor?: string;
    tradingDays?: number;
  };
}

export interface BacktestCollectorDeps {
  resultsDir: string;
  indexRelation: IndexRelationLookup;
}

// Filename looks like "SYMBOL-Strategy-Name-{ms}.json"
function parseRunMs(name: string): number | null {
  const m = name.match(/-(\d{12,})\.json$/);
  return m ? Number(m[1]) : null;
}

export function createBacktestCollector(deps: BacktestCollectorDeps): Collector {
  return {
    kind: "backtest",
    async describe(): Promise<DatasetDescriptor[]> {
      const files = listFiles(deps.resultsDir, (n) => n.endsWith(".json"));
      if (files.length === 0) return [];

      const descriptors: DatasetDescriptor[] = [];
      for (const f of files) {
        let header: BacktestResultHeader = {};
        try {
          header = JSON.parse(readFileSync(f.path, "utf-8")) as BacktestResultHeader;
        } catch {
          /* skip file */
        }

        const symbol = header.config?.symbol ?? "";
        const strategy = header.config?.strategy ?? f.name.replace(/\.json$/, "");
        const runMs = parseRunMs(f.name);
        const runTs = runMs ? new Date(runMs).toISOString().replace(/\.\d+Z$/, "Z") : null;

        descriptors.push({
          id: `backtest:${f.name.replace(/\.json$/, "")}`,
          kind: "backtest",
          label: `${symbol ? symbol + " · " : ""}${strategy}`,
          symbols: symbol ? [symbol] : [],
          date_min: header.config?.startDate ?? null,
          date_max: header.config?.endDate ?? null,
          granularity: "event",
          row_count: Number(header.summary?.totalTrades ?? 0),
          file_count: 1,
          size_bytes: f.size,
          last_updated: mtimeToIso(f.mtimeMs),
          source: "backtest runner",
          index_relation: deps.indexRelation.classify(symbol),
          type_specific: {
            strategy,
            run_ts: runTs,
            total_pnl: header.summary?.totalPnl ?? null,
            win_rate: header.summary?.winRate ?? null,
            max_drawdown: header.summary?.maxDrawdown ?? null,
            profit_factor: header.summary?.profitFactor ?? null,
            trading_days: header.summary?.tradingDays ?? null,
            file_path: f.path,
          },
          // Backtest results are JSON headers, not parquet — qf:// data
          // adapters don't consume them. (qo-runs is the parquet-style
          // sibling for the new QO-based flow.)
          parquet_uri: null,
          column_schema: [],
        });
      }
      return descriptors;
    },
  };
}
