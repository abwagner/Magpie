// ── FRED Adapter ───────────────────────────────────────────────────
// FRED (Federal Reserve Economic Data) — native TS. One series per call.
// Replaces the shell-out to data-signals/data-sources/pipelines/fred.py.
//
// Manifest contract:
//   args: { series: "VIXCLS" }           output: "fred/vix.parquet"
//
// Output schema: (date DATE, value DOUBLE) — matches the Python pipeline's
// schema, so existing parquet files are interchangeable across the
// migration boundary.

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, maxValue, mergeAndWriteParquet } from "../storage.js";

const API_BASE = "https://api.stlouisfed.org/fred/series/observations";
const DEFAULT_START = "2019-01-01";

interface FredObservation {
  date: string;
  value: string;
}
interface FredResponse {
  observations?: FredObservation[];
}

function apiKey(): string {
  const k = (process.env.FRED_API_KEY ?? "").trim();
  if (!k) throw new Error("FRED_API_KEY not set");
  return k;
}

function plusDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function incrementalStart(uri: string, defaultStart: string): Promise<string> {
  if (!(await exists(uri))) return defaultStart;
  const max = await maxValue<unknown>(uri, "date");
  if (max === null) return defaultStart;
  const asString = max instanceof Date ? max.toISOString().slice(0, 10) : String(max).slice(0, 10);
  return plusDays(asString, -7); // overlap window for revisions
}

async function fetchSeries(
  series: string,
  start: string,
  end?: string,
): Promise<Array<{ date: string; value: number }>> {
  const url = new URL(API_BASE);
  url.searchParams.set("series_id", series);
  url.searchParams.set("api_key", apiKey());
  url.searchParams.set("file_type", "json");
  url.searchParams.set("observation_start", start);
  url.searchParams.set("sort_order", "asc");
  if (end) url.searchParams.set("observation_end", end);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`FRED HTTP ${resp.status} for ${series}: ${body.slice(0, 200)}`);
  }
  const body = (await resp.json()) as FredResponse;
  const obs = body.observations ?? [];
  const out: Array<{ date: string; value: number }> = [];
  for (const o of obs) {
    const v = Number(o.value);
    if (Number.isFinite(v)) out.push({ date: o.date, value: v });
  }
  return out;
}

async function fetchOne(req: DataRequest): Promise<DataResult> {
  const series = req.args.series as string | undefined;
  if (!series) return { request: req, ok: false, error: "missing args.series" };
  if (!req.output) return { request: req, ok: false, error: "missing output" };

  const start = req.since ?? (await incrementalStart(req.output, DEFAULT_START));
  try {
    const rows = await fetchSeries(series, start);
    if (rows.length === 0) {
      return { request: req, ok: true, dataThrough: undefined };
    }
    await mergeAndWriteParquet({
      uri: req.output,
      schema: "(date DATE, value DOUBLE)",
      dedupKey: "date",
      rows,
      orderBy: "date",
    });
    const last = rows[rows.length - 1];
    return { request: req, ok: true, dataThrough: last?.date };
  } catch (e) {
    return { request: req, ok: false, error: (e as Error).message };
  }
}

export function createFredAdapter(): DataAdapter {
  return {
    id: "fred",
    capabilities: { batch: false, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) results.push(await fetchOne(req));
      return results;
    },
  };
}
