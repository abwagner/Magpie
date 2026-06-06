// ── QO Runs Collector ─────────────────────────────────────────────
// Reads quant-optimizer wfo_results JSON files from data/results/qo/
// (recursive). Each file = one walk-forward run = one DatasetDescriptor
// with kind "qo-run". Ingests QO-produced archives from MinIO.
//
// Files predating QO's lineage_id stamping are tolerated: lineage_id
// surfaces as null in type_specific.

import { readFileSync } from "node:fs";
import type { Collector, DatasetDescriptor } from "../types.js";
import type { IndexRelationLookup } from "../indexRelation.js";
import { mtimeToIso, walkFiles } from "../helpers.js";

interface OosPanel {
  net_pnl?: number;
}

interface FoldRow {
  fold_id?: number;
  is_start?: string;
  is_end?: string;
  oos_start?: string;
  oos_end?: string;
  n_trials_target?: number | null;
  oos?: OosPanel;
}

interface WfoResultsFile {
  schema_version?: number;
  strategy?: string;
  lineage_id?: string;
  folds?: FoldRow[];
}

export interface QoRunsCollectorDeps {
  // <root>/data/results/qo — walked recursively for any wfo_results_*.json.
  resultsDir: string;
  indexRelation: IndexRelationLookup;
}

const FILENAME_RE = /^wfo_results_.*\.json$/;

export function createQoRunsCollector(deps: QoRunsCollectorDeps): Collector {
  return {
    kind: "qo-run",
    async describe(): Promise<DatasetDescriptor[]> {
      const files = walkFiles(deps.resultsDir, (n) => FILENAME_RE.test(n));
      if (files.length === 0) return [];

      const descriptors: DatasetDescriptor[] = [];
      for (const f of files) {
        let parsed: WfoResultsFile;
        try {
          parsed = JSON.parse(readFileSync(f.path, "utf-8")) as WfoResultsFile;
        } catch {
          // Malformed JSON — skip the file. Collector must not fatal on
          // one bad file (per §4.6 failure-mode policy).
          continue;
        }

        const folds = Array.isArray(parsed.folds) ? parsed.folds : [];
        if (folds.length === 0) continue;

        const sorted = [...folds].sort((a, b) => (a.fold_id ?? 0) - (b.fold_id ?? 0));
        const first = sorted[0]!;
        const last = sorted[sorted.length - 1]!;
        const isStart = first.is_start ?? null;
        const isEnd = last.is_end ?? null;
        const oosStart = first.oos_start ?? null;
        const oosEnd = last.oos_end ?? null;
        const nTrialsTarget = first.n_trials_target ?? null;

        // Best OOS net_pnl across folds. Pure max — strategies use the
        // canonical net_pnl field per quant_optimizer.schema.OosMetricPanel.
        let bestOosMetric: number | null = null;
        for (const fr of sorted) {
          const v = fr.oos?.net_pnl;
          if (typeof v !== "number") continue;
          if (bestOosMetric === null || v > bestOosMetric) bestOosMetric = v;
        }

        const strategy = parsed.strategy ?? "";
        // Deterministic id derived from filename (no extension). This is
        // also what /api/qo-run/:id resolves against.
        const idBase = f.name.replace(/\.json$/, "");

        descriptors.push({
          id: `qo-run:${idBase}`,
          kind: "qo-run",
          label: strategy ? `${strategy} · ${isStart ?? "?"} → ${isEnd ?? "?"}` : idBase,
          symbols: [],
          date_min: isStart,
          date_max: oosEnd ?? isEnd,
          granularity: "event",
          row_count: sorted.length,
          file_count: 1,
          size_bytes: f.size,
          last_updated: mtimeToIso(f.mtimeMs),
          source: "quant-optimizer",
          index_relation: deps.indexRelation.classify(""),
          type_specific: {
            strategy,
            is_window: [isStart, isEnd],
            oos_window: [oosStart, oosEnd],
            n_folds: sorted.length,
            n_trials_per_fold: nTrialsTarget,
            lineage_id: parsed.lineage_id ?? null,
            best_oos_metric: bestOosMetric,
            schema_version: parsed.schema_version ?? null,
            file_path: f.path,
          },
          // qo-runs are JSON wfo_results_*.json — not parquet, not consumed
          // via qf:// data URIs. type_specific.file_path remains the way to
          // locate the underlying file.
          parquet_uri: null,
          column_schema: [],
        });
      }
      return descriptors;
    },
  };
}
