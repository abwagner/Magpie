// ── OFAC SDN Adapter ───────────────────────────────────────────────
// US Treasury OFAC Specially Designated Nationals (SDN) — vessel records.
// Native TS port of data-signals/data-sources/pipelines/ofac.py. No API
// key required.
//
// Manifest contract: args = {} (or args.url override); output points at
// the cumulative sdn vessels parquet. Each fetch overwrites existing
// rows by ent_num (last fetch wins) so the cache reflects the latest
// OFAC view, while delisted vessels persist with their last as_of_date.

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { mergeAndWriteParquet } from "../storage.js";

const DEFAULT_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";
const NULL_MARKER = "-0-";
const IMO_RE = /\bIMO\s*([0-9]{6,8})\b/i;
const MAX_RETRIES = 3;
const BACKOFF_SECONDS = 3;

function clean(field: string | undefined): string | null {
  if (field === undefined) return null;
  const s = field.trim();
  if (!s || s === NULL_MARKER) return null;
  return s;
}

function extractImo(remarks: string | null): string | null {
  if (!remarks) return null;
  const m = IMO_RE.exec(remarks);
  return m ? m[1]! : null;
}

// Minimal CSV parser supporting RFC 4180 quoted fields with embedded commas
// and double-double-quote escapes. SDN.CSV is well-formed; we don't need a
// general CSV lib here.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip; \n will close the row
      } else {
        field += c;
      }
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchSdn(url: string): Promise<Array<Record<string, unknown>>> {
  let text: string | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!resp.ok) throw new Error(`OFAC HTTP ${resp.status}`);
      text = await resp.text();
      break;
    } catch (e) {
      lastErr = e;
      const delay = BACKOFF_SECONDS * 2 ** attempt;
      console.warn(`[ofac] retry ${attempt + 1}/${MAX_RETRIES} after ${delay}s: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  if (text === null) throw (lastErr as Error) ?? new Error("OFAC fetch failed");

  const today = new Date().toISOString().slice(0, 10);
  const rows: Array<Record<string, unknown>> = [];
  // Layout: ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign,
  //         Vess_type, Tonnage, GRT, Vess_flag, Vess_owner, Remarks
  for (const raw of parseCsv(text)) {
    if (raw.length < 12) continue;
    if ((raw[2] ?? "").trim().toLowerCase() !== "vessel") continue;
    const entNum = parseInt((raw[0] ?? "").trim(), 10);
    if (!Number.isFinite(entNum)) continue;
    const remarks = clean(raw[11]);
    rows.push({
      ent_num: entNum,
      name: clean(raw[1]),
      program: clean(raw[3]),
      call_sign: clean(raw[5]),
      vessel_type: clean(raw[6]),
      tonnage: clean(raw[7]),
      grt: clean(raw[8]),
      flag: clean(raw[9]),
      owner: clean(raw[10]),
      imo: extractImo(remarks),
      remarks,
      as_of_date: today,
    });
  }
  return rows;
}

async function fetchOne(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const url = (req.args.url as string | undefined) ?? DEFAULT_URL;
  try {
    const rows = await fetchSdn(url);
    if (rows.length === 0) return { request: req, ok: true, dataThrough: undefined };
    await mergeAndWriteParquet({
      uri: req.output,
      schema: `(
        ent_num INTEGER, name VARCHAR, program VARCHAR, call_sign VARCHAR,
        vessel_type VARCHAR, tonnage VARCHAR, grt VARCHAR, flag VARCHAR,
        owner VARCHAR, imo VARCHAR, remarks VARCHAR, as_of_date DATE
      )`,
      dedupKey: "ent_num",
      rows,
      orderBy: "program, name, ent_num",
    });
    const today = new Date().toISOString().slice(0, 10);
    return { request: req, ok: true, dataThrough: today };
  } catch (e) {
    return { request: req, ok: false, error: (e as Error).message };
  }
}

export function createOfacAdapter(): DataAdapter {
  return {
    id: "ofac",
    capabilities: { batch: false, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) results.push(await fetchOne(req));
      return results;
    },
  };
}
