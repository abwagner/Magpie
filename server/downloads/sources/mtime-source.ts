// ── Generic mtime-only Source ─────────────────────────────────────
// For data dirs without a log or sidecars. Buckets parquet mtimes by
// calendar day so the user at least sees "FRED was refreshed today".

import { synthesizeFromMtimes, walkParquets } from "../parsers/mtime-groups.js";
import type { DownloadRun, RunActivityEntry, SourceAggregator } from "../types.js";

export interface MtimeSourceDeps {
  source: string;
  idPrefix: string;
  rootDir: string;
  maxDays?: number;
}

export function createMtimeSource(deps: MtimeSourceDeps): SourceAggregator {
  return {
    source: deps.source,
    async list(): Promise<DownloadRun[]> {
      return synthesizeFromMtimes({
        source: deps.source,
        idPrefix: deps.idPrefix,
        rootDir: deps.rootDir,
        maxDays: deps.maxDays,
      });
    },
    async detail(runId: string): Promise<RunActivityEntry[] | null> {
      const day = runId.split(":").at(-1);
      if (!day) return null;
      const files = walkParquets(deps.rootDir).filter(
        (f) => new Date(f.mtimeMs).toISOString().slice(0, 10) === day,
      );
      if (files.length === 0) return null;
      // Roll up by symbol.
      const bySym = new Map<string, RunActivityEntry>();
      for (const f of files) {
        let entry = bySym.get(f.symbol);
        if (!entry) {
          entry = {
            symbol: f.symbol,
            date_range: null,
            contracts: null,
            credits_used: null,
            files_touched: 0,
            errors: [],
          };
          bySym.set(f.symbol, entry);
        }
        entry.files_touched += 1;
      }
      return Array.from(bySym.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
    },
  };
}
