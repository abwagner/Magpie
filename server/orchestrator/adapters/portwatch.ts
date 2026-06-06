// ── PortWatch Adapter ──────────────────────────────────────────────
// IMF PortWatch — daily port and chokepoint activity (Tier 1 source).
// Native TS port of data-signals/data-sources/pipelines/portwatch.py.
// No API key required.
//
// Two datasets (selected via args.dataset):
//   ports        → Daily_Ports_Data (~2,065 ports, daily port-call counts)
//   chokepoints  → Daily_Chokepoints_Data (28 chokepoints, daily transits)
//
// Manifest contract:
//   args: { dataset: "ports", iso3?: ["SAU","USA"], portid?: ["chokepoint6"] }

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, mergeAndWriteParquetAuto, readParquet } from "../storage.js";

const ARCGIS_BASE = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services";
const DEFAULT_START = "2019-01-01";
const PAGE_SIZE = 5000;
const MAX_RETRIES = 4;
const BACKOFF_SECONDS = 2;
const MAX_ISO3_PER_QUERY = 6; // ArcGIS WHERE clause length limit

interface DatasetSpec {
  name: string;
  arcgisDataset: string;
  dedupKeys: string[];
  orderBy: string;
}

const DATASETS: Record<string, DatasetSpec> = {
  ports: {
    name: "ports",
    arcgisDataset: "Daily_Ports_Data",
    dedupKeys: ["portid", "date"],
    orderBy: "date ASC, portid ASC",
  },
  chokepoints: {
    name: "chokepoints",
    arcgisDataset: "Daily_Chokepoints_Data",
    dedupKeys: ["portid", "date"],
    orderBy: "date ASC, portid ASC",
  },
};

interface ArcgisFeature {
  attributes?: Record<string, unknown>;
}
interface ArcgisResponse {
  features?: ArcgisFeature[];
  exceededTransferLimit?: boolean;
  error?: { message?: string };
}

function plusDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildWhere(
  startDate: string,
  endDate: string | undefined,
  iso3: ReadonlyArray<string> | undefined,
  portid: ReadonlyArray<string> | undefined,
): string {
  const parts = [`date >= TIMESTAMP '${startDate} 00:00:00'`];
  if (endDate) parts.push(`date <= TIMESTAMP '${endDate} 23:59:59'`);
  if (iso3 && iso3.length) {
    const codes = iso3.map((c) => `'${c.toUpperCase()}'`).join(",");
    parts.push(`ISO3 IN (${codes})`);
  }
  if (portid && portid.length) {
    const ids = portid.map((p) => `'${p}'`).join(",");
    parts.push(`portid IN (${ids})`);
  }
  return parts.join(" AND ");
}

async function arcgisRequest(url: string, params: Record<string, string>): Promise<ArcgisResponse> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const u = new URL(url);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      const resp = await fetch(u.toString(), { signal: AbortSignal.timeout(60_000) });
      if (!resp.ok) throw new Error(`PortWatch HTTP ${resp.status}`);
      const body = (await resp.json()) as ArcgisResponse;
      if (body.error) throw new Error(`PortWatch ArcGIS error: ${body.error.message ?? "unknown"}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt + 1 < MAX_RETRIES) {
        const delay = BACKOFF_SECONDS * 2 ** attempt;
        console.warn(`[portwatch] retry ${attempt + 1}/${MAX_RETRIES} after ${delay}s: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  }
  throw (lastErr as Error) ?? new Error("PortWatch fetch failed");
}

async function fetchOneChunk(
  spec: DatasetSpec,
  startDate: string,
  endDate: string | undefined,
  iso3: ReadonlyArray<string> | undefined,
  portid: ReadonlyArray<string> | undefined,
): Promise<Array<Record<string, unknown>>> {
  const apiUrl = `${ARCGIS_BASE}/${spec.arcgisDataset}/FeatureServer/0/query`;
  const where = buildWhere(startDate, endDate, iso3, portid);
  console.log(`[portwatch] ${spec.name} where=${where}`);

  const rows: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    const body = await arcgisRequest(apiUrl, {
      where,
      outFields: "*",
      f: "json",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      orderByFields: spec.orderBy,
      returnGeometry: "false",
    });
    const features = body.features ?? [];
    if (features.length === 0) break;
    for (const f of features) if (f.attributes) rows.push(f.attributes);
    if (!body.exceededTransferLimit) break;
    offset += features.length;
  }
  return rows;
}

async function fetchAll(
  spec: DatasetSpec,
  startDate: string,
  endDate: string | undefined,
  iso3: ReadonlyArray<string> | undefined,
  portid: ReadonlyArray<string> | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (iso3 && iso3.length > MAX_ISO3_PER_QUERY) {
    const all: Array<Record<string, unknown>> = [];
    for (let i = 0; i < iso3.length; i += MAX_ISO3_PER_QUERY) {
      const chunk = iso3.slice(i, i + MAX_ISO3_PER_QUERY);
      console.log(`[portwatch] iso3 chunk ${i / MAX_ISO3_PER_QUERY + 1}: ${chunk.join(",")}`);
      const part = await fetchOneChunk(spec, startDate, endDate, chunk, portid);
      all.push(...part);
    }
    return all;
  }
  return fetchOneChunk(spec, startDate, endDate, iso3, portid);
}

async function incrementalStart(uri: string, defaultStart: string): Promise<string> {
  if (!(await exists(uri))) return defaultStart;
  try {
    const rows = await readParquet<{ date: unknown }>(uri, {
      columns: ["max(date) AS max_date"],
    });
    // Custom max query: skip readParquet's column quoting and just query raw
    return defaultStart; // fallback if column trick fails
  } catch {
    return defaultStart;
  }
}

async function maxDateFromParquet(uri: string): Promise<string | null> {
  if (!(await exists(uri))) return null;
  // Use a direct query through readParquet's raw mode by passing a SELECT projection
  // — but readParquet doesn't take that, so go through withDb. Simpler: use
  // storage.maxValue, which already handles this case.
  const { maxValue } = await import("../storage.js");
  const v = await maxValue<unknown>(uri, "date");
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // PortWatch stores dates as TIMESTAMP; DuckDB returns them as Date or ISO string.
  const s = String(v);
  return s.slice(0, 10);
}

function normalizeDates(rows: Array<Record<string, unknown>>): void {
  // ArcGIS returns `date` as epoch milliseconds. Convert to ISO date string so
  // DuckDB stores TIMESTAMP and downstream signals can compare on date.
  for (const r of rows) {
    const d = r.date;
    if (typeof d === "number" && Number.isFinite(d)) {
      r.date = new Date(d).toISOString();
    }
  }
}

async function fetchOne(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const datasetName = (req.args.dataset as string | undefined) ?? "ports";
  const spec = DATASETS[datasetName];
  if (!spec) return { request: req, ok: false, error: `unknown dataset: ${datasetName}` };

  const iso3 = toArray(req.args.iso3);
  const portid = toArray(req.args.portid);
  const today = new Date().toISOString().slice(0, 10);

  let start = req.since;
  if (!start) {
    const last = await maxDateFromParquet(req.output);
    start = last ? plusDays(last, -7) : DEFAULT_START;
  }
  const end = (req.args.until as string | undefined) ?? today;

  try {
    const rows = await fetchAll(spec, start, end, iso3, portid);
    if (rows.length === 0) return { request: req, ok: true, dataThrough: undefined };
    normalizeDates(rows);
    await mergeAndWriteParquetAuto({
      uri: req.output,
      dedupKey: spec.dedupKeys.join(", "),
      rows,
      orderBy: spec.dedupKeys.join(", "),
    });
    return { request: req, ok: true, dataThrough: end };
  } catch (e) {
    return { request: req, ok: false, error: (e as Error).message };
  }
}

function toArray(v: unknown): ReadonlyArray<string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map(String);
  return undefined;
}

export function createPortwatchAdapter(): DataAdapter {
  return {
    id: "portwatch",
    capabilities: { batch: false, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) results.push(await fetchOne(req));
      return results;
    },
    supportsRequest(args: Record<string, unknown>): boolean {
      const ds = String(args.dataset ?? "");
      return ds === "" || ds in DATASETS;
    },
  };
}
