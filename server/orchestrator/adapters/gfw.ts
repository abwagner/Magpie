// ── GFW Adapter ────────────────────────────────────────────────────
// Global Fishing Watch — vessel events. Native TS port of
// data-signals/data-sources/pipelines/gfw.py.
//
// Auth: GFW_API_TOKEN env (free non-commercial tokens at
// https://globalfishingwatch.org/our-apis/).
//
// Fetches PORT_VISIT + ENCOUNTER events for vessel types
// {BUNKER_OR_TANKER, CARGO} by default, with 365-day chunking and
// exponential backoff on 429s. Cumulative parquet keyed on event id.

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, mergeAndWriteParquetAuto, maxValue } from "../storage.js";

const EVENTS_URL = "https://gateway.api.globalfishingwatch.org/v3/events";
const DEFAULT_DATASET = "public-global-fishing-events:latest";
const DEFAULT_VESSEL_TYPES = ["BUNKER_OR_TANKER", "CARGO"];
const DEFAULT_EVENT_TYPES = ["PORT_VISIT", "ENCOUNTER"];
const DEFAULT_START = "2024-01-01";
const PAGE_LIMIT = 500;
const MAX_RETRIES = 4;
const BACKOFF_SECONDS = 2;
const MAX_RANGE_DAYS = 365;

interface GfwEntry {
  id?: string;
  type?: string;
  start?: string;
  end?: string;
  vessel?: { id?: string; ssvid?: string; imo?: string; name?: string; flag?: string; type?: string; shipType?: string };
  position?: { lat?: number; lon?: number };
  encounter?: { vessel?: { id?: string; ssvid?: string; type?: string; shipType?: string } };
  port_visit?: { id?: string; name?: string; flag?: string; country?: string; portId?: string; portName?: string };
  portVisit?: { id?: string; name?: string; flag?: string; country?: string; portId?: string; portName?: string };
}
interface GfwResponse {
  entries?: GfwEntry[];
  data?: GfwEntry[];
}

function authHeaders(): Record<string, string> {
  const token = (process.env.GFW_API_TOKEN ?? "").trim();
  if (!token) {
    throw new Error(
      "GFW_API_TOKEN not set. Register at https://globalfishingwatch.org/our-apis/.",
    );
  }
  return { Authorization: `Bearer ${token}` };
}

function plusDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateChunks(start: string, end: string, maxDays = MAX_RANGE_DAYS): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cur = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (cur <= e) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > e) chunkEnd.setTime(e.getTime());
    out.push([cur.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);
    cur = new Date(chunkEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function gfwGet(params: URLSearchParams): Promise<GfwResponse> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const url = `${EVENTS_URL}?${params.toString()}`;
      const resp = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(120_000) });
      if (resp.status === 401) throw new Error("GFW 401 — check GFW_API_TOKEN");
      if (resp.status === 429) {
        const delay = BACKOFF_SECONDS * 4 ** attempt;
        console.warn(`[gfw] rate-limited (attempt ${attempt + 1}); sleeping ${delay}s`);
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }
      if (!resp.ok) throw new Error(`GFW HTTP ${resp.status}`);
      return (await resp.json()) as GfwResponse;
    } catch (e) {
      lastErr = e;
      if (attempt + 1 < MAX_RETRIES) {
        const delay = BACKOFF_SECONDS * 2 ** attempt;
        console.warn(`[gfw] retry ${attempt + 1}/${MAX_RETRIES} after ${delay}s: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  }
  throw (lastErr as Error) ?? new Error("GFW fetch failed");
}

function flatten(e: GfwEntry): Record<string, unknown> {
  const v = e.vessel ?? {};
  const p = e.position ?? {};
  const enc = e.encounter?.vessel ?? {};
  const pv = e.port_visit ?? e.portVisit ?? {};
  return {
    id: e.id ?? null,
    type: e.type ?? null,
    start: e.start ?? null,
    end: e.end ?? null,
    vessel_id: v.id ?? null,
    vessel_ssvid: v.ssvid ?? null,
    vessel_imo: v.imo ?? null,
    vessel_name: v.name ?? null,
    vessel_flag: v.flag ?? null,
    vessel_type: v.type ?? v.shipType ?? null,
    lat: typeof p.lat === "number" ? p.lat : null,
    lon: typeof p.lon === "number" ? p.lon : null,
    encounter_vessel_id: enc.id ?? null,
    encounter_vessel_ssvid: enc.ssvid ?? null,
    encounter_vessel_type: enc.type ?? enc.shipType ?? null,
    port_id: pv.id ?? pv.portId ?? null,
    port_name: pv.name ?? pv.portName ?? null,
    port_country: pv.flag ?? pv.country ?? null,
    raw_json: JSON.stringify(e),
  };
}

async function fetchEvents(
  startDate: string,
  endDate: string,
  eventTypes: ReadonlyArray<string>,
  vesselTypes: ReadonlyArray<string>,
  datasets: ReadonlyArray<string>,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [s, e] of dateChunks(startDate, endDate)) {
    console.log(`[gfw] chunk ${s} → ${e} (events=${eventTypes.join(",")} vessels=${vesselTypes.join(",")})`);
    let offset = 0;
    while (true) {
      const params = new URLSearchParams();
      params.set("start-date", s);
      params.set("end-date", e);
      params.set("offset", String(offset));
      params.set("limit", String(PAGE_LIMIT));
      eventTypes.forEach((t, i) => params.append(`types[${i}]`, t.toUpperCase()));
      vesselTypes.forEach((t, i) => params.append(`vessel-types[${i}]`, t.toUpperCase()));
      datasets.forEach((d, i) => params.append(`datasets[${i}]`, d));

      const body = await gfwGet(params);
      const entries = body.entries ?? body.data ?? [];
      if (entries.length === 0) break;
      for (const ent of entries) rows.push(flatten(ent));
      if (entries.length < PAGE_LIMIT) break;
      offset += entries.length;
    }
  }
  return rows;
}

function toArray(v: unknown, fallback: ReadonlyArray<string>): ReadonlyArray<string> {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map(String);
  return fallback;
}

async function fetchOne(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };

  const eventTypes = toArray(req.args.event_types ?? req.args.event_type, DEFAULT_EVENT_TYPES);
  const vesselTypes = toArray(req.args.vessel_types ?? req.args.vessel_type, DEFAULT_VESSEL_TYPES);
  const datasets = toArray(req.args.datasets ?? req.args.dataset, [DEFAULT_DATASET]);
  const today = new Date().toISOString().slice(0, 10);
  const until = (req.args.until as string | undefined) ?? today;

  let since = req.since;
  if (!since) {
    if (await exists(req.output)) {
      const last = await maxValue<unknown>(req.output, "start");
      if (last !== null) {
        const lastDate = last instanceof Date ? last.toISOString().slice(0, 10) : String(last).slice(0, 10);
        since = plusDays(lastDate, -3);
      }
    }
    since = since ?? DEFAULT_START;
  }

  try {
    const rows = await fetchEvents(since, until, eventTypes, vesselTypes, datasets);
    if (rows.length === 0) return { request: req, ok: true, dataThrough: undefined };
    await mergeAndWriteParquetAuto({
      uri: req.output,
      dedupKey: "id",
      rows,
      orderBy: "start, id",
    });
    return { request: req, ok: true, dataThrough: until };
  } catch (e) {
    return { request: req, ok: false, error: (e as Error).message };
  }
}

export function createGfwAdapter(): DataAdapter {
  return {
    id: "gfw",
    capabilities: { batch: false, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) results.push(await fetchOne(req));
      return results;
    },
  };
}
