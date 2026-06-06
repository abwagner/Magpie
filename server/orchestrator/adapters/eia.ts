// ── EIA Adapter ────────────────────────────────────────────────────
// EIA Open Data API v2 — petroleum series. Native TS port of
// data-signals/data-sources/pipelines/eia.py. EIA's API supports multiple
// series per call (`facets[series][]=A&facets[series][]=B`), so we batch.
//
// Output schema: (date DATE, value DOUBLE) — same as fred.ts.

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, maxValue, mergeAndWriteParquet } from "../storage.js";

const API_BASE = "https://api.eia.gov/v2/petroleum/sum/sndw/data/";
const DEFAULT_START = "2019-01-01";

interface EiaResponseBody {
  response?: {
    data?: Array<Record<string, unknown>>;
    total?: number | string;
  };
}

function apiKey(): string {
  const k = (process.env.EIA_API_KEY ?? "").trim();
  if (!k) throw new Error("EIA_API_KEY not set");
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
  return plusDays(asString, -7);
}

async function fetchSeries(
  seriesIds: ReadonlyArray<string>,
  start: string,
  end?: string,
): Promise<Map<string, Array<{ date: string; value: number }>>> {
  const out = new Map<string, Array<{ date: string; value: number }>>();
  for (const sid of seriesIds) out.set(sid, []);

  let offset = 0;
  const limit = 5000;
  while (true) {
    const url = new URL(API_BASE);
    url.searchParams.set("api_key", apiKey());
    url.searchParams.set("frequency", "weekly");
    url.searchParams.set("data[0]", "value");
    url.searchParams.set("sort[0][column]", "period");
    url.searchParams.set("sort[0][direction]", "asc");
    url.searchParams.set("start", start);
    url.searchParams.set("length", String(limit));
    url.searchParams.set("offset", String(offset));
    if (end) url.searchParams.set("end", end);
    for (const sid of seriesIds) url.searchParams.append("facets[series][]", sid);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`EIA HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const body = (await resp.json()) as EiaResponseBody;
    const data = body.response?.data ?? [];
    if (data.length === 0) break;

    for (const r of data) {
      const sid = String(r["series-id"] ?? "");
      const period = String(r["period"] ?? "");
      const v = Number(r["value"]);
      if (!sid || !period || !Number.isFinite(v)) continue;
      const arr = out.get(sid);
      if (arr) arr.push({ date: period, value: v });
    }

    const total = Number(body.response?.total ?? data.length);
    offset += data.length;
    if (offset >= total) break;
  }
  return out;
}

export function createEiaAdapter(): DataAdapter {
  return {
    id: "eia",
    capabilities: { batch: true, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      // Group requests by min(start) so we issue one API call per starting date.
      const work = await Promise.all(
        requests.map(async (req) => ({
          req,
          series: req.args.series as string | undefined,
          start:
            req.since ??
            (req.output ? await incrementalStart(req.output, DEFAULT_START) : DEFAULT_START),
        })),
      );

      // EIA accepts multiple series in one call; batch all distinct series with the
      // earliest start so a single round trip serves the whole batch.
      const validWork = work.filter((w) => w.series && w.req.output);
      if (validWork.length === 0) {
        return work.map((w) => ({
          request: w.req,
          ok: false,
          error: !w.series ? "missing args.series" : "missing output",
        }));
      }
      const earliest = validWork.reduce((min, w) => (w.start < min ? w.start : min), validWork[0]!.start);
      const seriesIds = [...new Set(validWork.map((w) => w.series as string))];

      let bySeries: Map<string, Array<{ date: string; value: number }>>;
      try {
        bySeries = await fetchSeries(seriesIds, earliest);
      } catch (e) {
        return work.map((w) => ({ request: w.req, ok: false, error: (e as Error).message }));
      }

      const results: DataResult[] = [];
      for (const w of work) {
        if (!w.series) {
          results.push({ request: w.req, ok: false, error: "missing args.series" });
          continue;
        }
        if (!w.req.output) {
          results.push({ request: w.req, ok: false, error: "missing output" });
          continue;
        }
        const rows = bySeries.get(w.series) ?? [];
        if (rows.length === 0) {
          results.push({ request: w.req, ok: true, dataThrough: undefined });
          continue;
        }
        try {
          await mergeAndWriteParquet({
            uri: w.req.output,
            schema: "(date DATE, value DOUBLE)",
            dedupKey: "date",
            rows,
            orderBy: "date",
          });
          results.push({ request: w.req, ok: true, dataThrough: rows[rows.length - 1]?.date });
        } catch (e) {
          results.push({ request: w.req, ok: false, error: (e as Error).message });
        }
      }
      return results;
    },
  };
}
