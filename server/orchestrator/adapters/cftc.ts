// ── CFTC Adapter ───────────────────────────────────────────────────
// CFTC Commitments of Traders, Socrata API. Native TS port of
// data-signals/data-sources/pipelines/cftc.py. No API key required.
//
// One commodity per request. Manifest contract:
//   args: { commodity: "067651" }    output: "cftc/wti_crude.parquet"

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, maxValue, mergeAndWriteParquet } from "../storage.js";

const API_BASE = "https://publicreporting.cftc.gov/resource/jun7-fc8e.json";
const DEFAULT_START = "2019-01-01";

const POSITION_FIELDS = [
  "open_interest_all",
  "noncomm_positions_long_all",
  "noncomm_positions_short_all",
  "noncomm_postions_spread_all",
  "comm_positions_long_all",
  "comm_positions_short_all",
  "tot_rept_positions_long_all",
  "tot_rept_positions_short",
  "nonrept_positions_long_all",
  "nonrept_positions_short_all",
  "change_in_open_interest_all",
  "change_in_noncomm_long_all",
  "change_in_noncomm_short_all",
  "change_in_comm_long_all",
  "change_in_comm_short_all",
] as const;

type CftcRow = {
  date: string;
  noncomm_net?: number;
  comm_net?: number;
} & Partial<Record<(typeof POSITION_FIELDS)[number], number>>;

const SCHEMA = `(
  date DATE,
  open_interest_all DOUBLE, noncomm_positions_long_all DOUBLE, noncomm_positions_short_all DOUBLE,
  noncomm_postions_spread_all DOUBLE, comm_positions_long_all DOUBLE, comm_positions_short_all DOUBLE,
  tot_rept_positions_long_all DOUBLE, tot_rept_positions_short DOUBLE,
  nonrept_positions_long_all DOUBLE, nonrept_positions_short_all DOUBLE,
  change_in_open_interest_all DOUBLE, change_in_noncomm_long_all DOUBLE,
  change_in_noncomm_short_all DOUBLE, change_in_comm_long_all DOUBLE,
  change_in_comm_short_all DOUBLE,
  noncomm_net DOUBLE, comm_net DOUBLE
)`;

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
  return plusDays(asString, -14); // COT revisions look back further
}

async function fetchCommodity(code: string, start: string): Promise<CftcRow[]> {
  const out: CftcRow[] = [];
  let offset = 0;
  const limit = 5000;
  while (true) {
    const url = new URL(API_BASE);
    url.searchParams.set(
      "$where",
      `cftc_contract_market_code='${code}' AND report_date_as_yyyy_mm_dd >= '${start}' AND futonly_or_combined='Combined'`,
    );
    url.searchParams.set("$order", "report_date_as_yyyy_mm_dd ASC");
    url.searchParams.set("$limit", String(limit));
    url.searchParams.set("$offset", String(offset));

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`CFTC HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as Array<Record<string, unknown>>;
    if (data.length === 0) break;

    for (const raw of data) {
      const date = String(raw["report_date_as_yyyy_mm_dd"] ?? "");
      if (!date) continue;
      const row: CftcRow = { date: date.slice(0, 10) };
      for (const f of POSITION_FIELDS) {
        const v = Number(raw[f]);
        if (Number.isFinite(v)) row[f] = v;
      }
      const long = row["noncomm_positions_long_all"];
      const short = row["noncomm_positions_short_all"];
      if (long !== undefined && short !== undefined) row.noncomm_net = long - short;
      const cLong = row["comm_positions_long_all"];
      const cShort = row["comm_positions_short_all"];
      if (cLong !== undefined && cShort !== undefined) row.comm_net = cLong - cShort;
      out.push(row);
    }
    if (data.length < limit) break;
    offset += limit;
  }
  return out;
}

async function fetchOne(req: DataRequest): Promise<DataResult> {
  const code = req.args.commodity as string | undefined;
  if (!code) return { request: req, ok: false, error: "missing args.commodity" };
  if (!req.output) return { request: req, ok: false, error: "missing output" };

  const start = req.since ?? (await incrementalStart(req.output, DEFAULT_START));
  try {
    const rows = await fetchCommodity(code, start);
    if (rows.length === 0) return { request: req, ok: true, dataThrough: undefined };
    await mergeAndWriteParquet({
      uri: req.output,
      schema: SCHEMA,
      dedupKey: "date",
      rows: rows as unknown as Array<Record<string, unknown>>,
      orderBy: "date",
    });
    return { request: req, ok: true, dataThrough: rows[rows.length - 1]?.date };
  } catch (e) {
    return { request: req, ok: false, error: (e as Error).message };
  }
}

export function createCftcAdapter(): DataAdapter {
  return {
    id: "cftc",
    capabilities: { batch: true, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) results.push(await fetchOne(req));
      return results;
    },
  };
}
