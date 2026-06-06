// ── Sidecar (.parquet.meta.json) Aggregator ───────────────────────
// Sources that don't keep a structured run log (ETFs, the vol-buyer
// chain refresh) still drop a sidecar JSON next to each parquet they
// write. We group sidecars by ingest day to synthesize one
// `DownloadRun` per source per day.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DownloadRun, RunActivityEntry, RunErrorRef } from "../types.js";

export interface Sidecar {
  fetched_at: string;
  data_as_of?: string;
  rows_returned?: number;
  http_status?: number;
}

interface SidecarFile {
  path: string;
  parquetName: string; // "VXX.parquet" | "SPY-2026-04.parquet"
  symbol: string; // "VXX" | "SPY"
  meta: Sidecar;
}

const SUFFIX = ".parquet.meta.json";

function readSidecar(path: string): Sidecar | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Sidecar;
    if (typeof parsed.fetched_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Walk a directory non-recursively and collect every `*.parquet.meta.json`.
export function collectSidecars(dir: string): SidecarFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SidecarFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(SUFFIX)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const meta = readSidecar(path);
    if (!meta) continue;
    const parquetName = name.slice(0, -".meta.json".length);
    // "VXX.parquet" → "VXX"; "SPY-2026-04.parquet" → "SPY"
    const baseMatch = parquetName.match(/^([A-Z][A-Z0-9._-]*?)(?:-\d{4}-\d{2})?\.parquet$/);
    const symbol = baseMatch?.[1] ?? parquetName.replace(/\.parquet$/, "");
    out.push({ path, parquetName, symbol, meta });
  }
  return out;
}

// Bucket sidecars by `fetched_at` calendar day (UTC). Each bucket
// becomes one synthetic DownloadRun.
export function groupByDay(sidecars: SidecarFile[]): Map<string, SidecarFile[]> {
  const buckets = new Map<string, SidecarFile[]>();
  for (const s of sidecars) {
    const day = s.meta.fetched_at.slice(0, 10);
    let arr = buckets.get(day);
    if (!arr) {
      arr = [];
      buckets.set(day, arr);
    }
    arr.push(s);
  }
  return buckets;
}

export interface SynthesizeOptions {
  source: string;
  // Stable id prefix; final id = `${idPrefix}:${day}`.
  idPrefix: string;
}

export function synthesizeRuns(sidecars: SidecarFile[], opts: SynthesizeOptions): DownloadRun[] {
  const buckets = groupByDay(sidecars);
  const runs: DownloadRun[] = [];
  for (const [day, files] of buckets) {
    let rows = 0;
    let errors = 0;
    let started = files[0]?.meta.fetched_at ?? `${day}T00:00:00Z`;
    let finished = started;
    for (const f of files) {
      rows += f.meta.rows_returned ?? 0;
      if (f.meta.http_status != null && f.meta.http_status >= 400) errors += 1;
      if (f.meta.fetched_at < started) started = f.meta.fetched_at;
      if (f.meta.fetched_at > finished) finished = f.meta.fetched_at;
    }
    runs.push({
      id: `${opts.idPrefix}:${day}`,
      source: opts.source,
      started_at: started,
      finished_at: finished,
      duration_seconds: Math.max(
        0,
        Math.round((Date.parse(finished) - Date.parse(started)) / 1000),
      ),
      status: errors > 0 ? "error" : "synthesized",
      request_count: files.length,
      rows_written: rows,
      files_written: files.length,
      credits: null,
      error_count: errors,
      notes: errors > 0 ? [`${errors} non-2xx response(s)`] : [],
    });
  }
  // Newest first.
  runs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return runs;
}

export function activityFromSidecars(sidecars: SidecarFile[]): RunActivityEntry[] {
  const bySymbol = new Map<string, RunActivityEntry>();
  for (const f of sidecars) {
    let entry = bySymbol.get(f.symbol);
    if (!entry) {
      entry = {
        symbol: f.symbol,
        date_range: null,
        contracts: null,
        credits_used: null,
        files_touched: 0,
        errors: [],
      };
      bySymbol.set(f.symbol, entry);
    }
    entry.files_touched += 1;
    if (f.meta.data_as_of) {
      const d = f.meta.data_as_of;
      if (!entry.date_range) entry.date_range = [d, d];
      else {
        if (d < entry.date_range[0]) entry.date_range[0] = d;
        if (d > entry.date_range[1]) entry.date_range[1] = d;
      }
    }
    if (f.meta.rows_returned != null) {
      entry.contracts = (entry.contracts ?? 0) + f.meta.rows_returned;
    }
    if (f.meta.http_status != null && f.meta.http_status >= 400) {
      const ref: RunErrorRef = {
        http_status: f.meta.http_status,
        endpoint: f.parquetName,
        ts: f.meta.fetched_at,
      };
      entry.errors.push(ref);
    }
  }
  const out = Array.from(bySymbol.values());
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}
