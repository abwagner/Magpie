// ── Fills Collector ────────────────────────────────────────────────
// Reads data/fills/*.jsonl (portfolio execution logs). Each file is
// one portfolio's chronological fill stream. Files are small enough
// (< 1 MB in practice) that full scanning is acceptable.

import { readFileSync } from "node:fs";
import type { Collector, DatasetDescriptor } from "../types.js";
import type { IndexRelationLookup } from "../indexRelation.js";
import { listFiles, mtimeToIso } from "../helpers.js";

export interface FillsCollectorDeps {
  fillsDir: string;
  indexRelation: IndexRelationLookup;
}

interface Fill {
  ts?: string;
  timestamp?: string;
  fill_ts?: string;
  symbol?: string;
  underlying?: string;
  portfolio?: string;
  notional?: number;
  price?: number;
  quantity?: number;
}

function extractTs(fill: Fill): string | null {
  const t = fill.ts ?? fill.timestamp ?? fill.fill_ts;
  if (!t) return null;
  const s = String(t);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

export function createFillsCollector(deps: FillsCollectorDeps): Collector {
  return {
    kind: "fills",
    async describe(): Promise<DatasetDescriptor[]> {
      const files = listFiles(deps.fillsDir, (n) => n.endsWith(".jsonl"));
      if (files.length === 0) return [];

      const descriptors: DatasetDescriptor[] = [];
      for (const f of files) {
        const portfolio = f.name.replace(/\.jsonl$/, "");
        let fillCount = 0;
        let dateMin: string | null = null;
        let dateMax: string | null = null;
        let grossNotional = 0;
        const symbols = new Set<string>();

        try {
          const content = readFileSync(f.path, "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            let fill: Fill;
            try {
              fill = JSON.parse(line) as Fill;
            } catch {
              continue;
            }
            fillCount++;
            const date = extractTs(fill);
            if (date) {
              if (!dateMin || date < dateMin) dateMin = date;
              if (!dateMax || date > dateMax) dateMax = date;
            }
            const sym = fill.underlying ?? fill.symbol;
            if (sym) symbols.add(sym);
            if (fill.notional) grossNotional += Math.abs(Number(fill.notional));
            else if (fill.price && fill.quantity)
              grossNotional += Math.abs(fill.price * fill.quantity);
          }
        } catch {
          /* skip file */
        }

        descriptors.push({
          id: `fills:${portfolio}`,
          kind: "fills",
          label: `${portfolio} fills`,
          symbols: Array.from(symbols).slice(0, 20),
          date_min: dateMin,
          date_max: dateMax,
          granularity: "event",
          row_count: fillCount,
          file_count: 1,
          size_bytes: f.size,
          last_updated: mtimeToIso(f.mtimeMs),
          source: "order plane",
          index_relation: deps.indexRelation.classify(Array.from(symbols)[0] ?? ""),
          type_specific: {
            portfolio,
            fill_count: fillCount,
            gross_notional: Math.round(grossNotional),
            distinct_underliers: symbols.size,
            file_path: f.path,
          },
          // Fills are JSONL append logs, not parquet — strategy adapters
          // don't consume them through the qf:// resolver.
          parquet_uri: null,
          column_schema: [],
        });
      }
      return descriptors;
    },
  };
}
