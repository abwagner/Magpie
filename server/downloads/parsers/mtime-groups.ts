// ── mtime-only Run Synthesis ──────────────────────────────────────
// For data directories that have neither a structured log nor sidecar
// metadata (FRED, EIA, futures, signals, databento), bucket parquet
// mtimes by calendar day to give the user *some* signal that a refresh
// happened. Resulting runs carry status="synthesized" and no credit
// info, with notes flagging the lack of a real run record.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DownloadRun } from "../types.js";

interface MtimeFile {
  path: string;
  symbol: string;
  mtimeMs: number;
  size: number;
}

function symbolFromName(name: string): string {
  return name.replace(/\.parquet$/, "").replace(/-\d{4}-\d{2}.*$/, "");
}

export function walkParquets(root: string, maxDepth = 3): MtimeFile[] {
  const out: MtimeFile[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) {
          if (depth < maxDepth) stack.push({ dir: path, depth: depth + 1 });
        } else if (name.endsWith(".parquet")) {
          out.push({
            path,
            symbol: symbolFromName(name),
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        }
      } catch {
        // skip unreadable entry
      }
    }
  }
  return out;
}

export interface MtimeSynthesizeOptions {
  source: string;
  idPrefix: string;
  rootDir: string;
  // Only emit groups for the most recent N days to keep the list short.
  maxDays?: number;
}

export function synthesizeFromMtimes(opts: MtimeSynthesizeOptions): DownloadRun[] {
  const files = walkParquets(opts.rootDir);
  if (files.length === 0) return [];

  // Bucket by UTC calendar day of the mtime.
  const buckets = new Map<string, MtimeFile[]>();
  for (const f of files) {
    const day = new Date(f.mtimeMs).toISOString().slice(0, 10);
    let arr = buckets.get(day);
    if (!arr) {
      arr = [];
      buckets.set(day, arr);
    }
    arr.push(f);
  }

  const runs: DownloadRun[] = [];
  for (const [day, group] of buckets) {
    let started = group[0]!.mtimeMs;
    let finished = started;
    for (const f of group) {
      if (f.mtimeMs < started) started = f.mtimeMs;
      if (f.mtimeMs > finished) finished = f.mtimeMs;
    }
    runs.push({
      id: `${opts.idPrefix}:${day}`,
      source: opts.source,
      started_at: new Date(started).toISOString().replace(/\.\d+Z$/, "Z"),
      finished_at: new Date(finished).toISOString().replace(/\.\d+Z$/, "Z"),
      duration_seconds: Math.max(0, Math.round((finished - started) / 1000)),
      status: "synthesized",
      request_count: null,
      rows_written: null,
      files_written: group.length,
      credits: null,
      error_count: 0,
      notes: ["Synthesized from file mtimes — source has no run log"],
    });
  }

  runs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  if (opts.maxDays && runs.length > opts.maxDays) runs.length = opts.maxDays;
  return runs;
}
