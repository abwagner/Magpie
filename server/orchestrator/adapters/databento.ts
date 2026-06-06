// ── Databento Historical Adapter ───────────────────────────────────
// Daily incremental bulk pull from Databento's Historical API for the
// futures whitelisted in config/databento-futures.json. Two layers:
//
//   - Pure helpers (CSV → row projection, cost-refusal decision,
//     incremental-start computation, output-path mapping) — unit
//     tested.
//   - createDatabentoAdapter() — DataAdapter that the
//     scripts/_databento-pull-impl.ts driver calls with one
//     DataRequest per (symbol, schema) pair.
//
// HTTP API surface (https://hist.databento.com/v0/):
//   - GET /metadata.get_cost  → preflight; refuse if > $0
//   - GET /timeseries.get_range?encoding=csv → CSV stream
// Auth: HTTP Basic, API key as username.

import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, maxValue, mergeAndWriteParquetAuto, joinUri } from "../storage.js";

const API_BASE = "https://hist.databento.com/v0";
const DEFAULT_LOOKBACK_DAYS = 30;

// ── Args ──────────────────────────────────────────────────────────

export interface DatabentoRequestArgs {
  /** Parent root (e.g. "CL", "ES"). */
  symbol: string;
  /** Databento dataset id (e.g. "GLBX.MDP3"). */
  dataset: string;
  /** Databento schema (ohlcv-1d, ohlcv-1m, ohlcv-1s, trades, mbp-1). */
  schema: string;
}

// ── Pure helpers ──────────────────────────────────────────────────

/**
 * Symbol-to-Databento-symbology mapping. We use the parent symbology
 * (`<symbol>.fut`) which resolves to the continuous front-month
 * contract across rolls. Avoids per-month subscription bookkeeping.
 */
export function parentSymbol(symbol: string): string {
  return `${symbol}.fut`;
}

/**
 * File-system-friendly schema name (Databento uses hyphens; parquet
 * files convention here uses underscores to match the 2026-05-09 seed
 * already in MinIO: futures/cl/mbp_1.parquet etc.).
 */
export function schemaToFilename(schema: string): string {
  return schema.replace(/-/g, "_");
}

/**
 * Output URI under DATA_URI for a (symbol, schema) pair. Matches the
 * existing MinIO layout from the 2026-05-09 seed.
 */
export function outputUriFor(symbol: string, schema: string): string {
  return joinUri("futures", symbol.toLowerCase(), `${schemaToFilename(schema)}.parquet`);
}

/**
 * Whether to refuse a fetch given a cost preflight result. Per the
 * config/databento-futures.json invariant, only $0 entries belong in
 * the pull_now tier. dryRun=true lets a caller see the refusal
 * without actually proceeding.
 */
export function shouldRefuseOnCost(costUsd: number): boolean {
  // Anything > 0 USD is a refusal. Tiny floating-point noise (< 1e-9)
  // shouldn't tip us into accepting paid pulls.
  return costUsd > 1e-9;
}

/**
 * UTC midnight today, ISO 8601. End boundary for the daily pull.
 */
export function utcMidnightToday(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  return d.toISOString();
}

/**
 * Default lookback start when no parquet exists yet (30 days back).
 */
export function defaultStart(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - DEFAULT_LOOKBACK_DAYS);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Compute the [start, end) window for a fetch. If a parquet already
 * exists, start = max(ts_event) - 1 minute (small overlap window so a
 * partial-day write picks up any new bars in the same minute on
 * re-run). Otherwise fall back to defaultStart(). end = UTC midnight
 * today (exclusive — we don't pull the in-progress day until it
 * closes).
 */
export async function incrementalWindow(
  uri: string,
  now: Date = new Date(),
): Promise<{ start: string; end: string }> {
  const end = utcMidnightToday(now);
  if (!(await exists(uri))) {
    return { start: defaultStart(now), end };
  }
  const max = await maxValue<unknown>(uri, "ts_event");
  if (max === null) return { start: defaultStart(now), end };
  // max can come back as a Date, BigInt nanoseconds, or string —
  // normalize to ISO millisecond precision then back off 60s.
  let lastMs: number;
  if (max instanceof Date) {
    lastMs = max.getTime();
  } else if (typeof max === "bigint") {
    // DuckDB TIMESTAMP_NS comes back as BigInt nanoseconds-since-epoch.
    lastMs = Number(max / 1_000_000n);
  } else {
    const parsed = Date.parse(String(max));
    lastMs = Number.isFinite(parsed) ? parsed : Date.now();
  }
  const overlapMs = 60_000;
  return { start: new Date(lastMs - overlapMs).toISOString(), end };
}

/**
 * Parse a Databento CSV response into row objects. Columns are
 * inferred from the header row. Numeric columns (price/open/high/low/
 * close/volume/size/instrument_id/ts_event) are coerced; everything
 * else stays as VARCHAR. ts_event arrives as nanoseconds-since-epoch
 * in the CSV; we convert to ISO 8601 for parquet TIMESTAMP storage.
 */
export function parseCsvToRows(csvText: string): Array<Record<string, unknown>> {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = (lines[0] ?? "").split(",");
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] ?? "").split(",");
    const row: Record<string, unknown> = {};
    for (let j = 0; j < header.length; j++) {
      const col = header[j] ?? "";
      const raw = cells[j] ?? "";
      row[col] = coerceCell(col, raw);
    }
    rows.push(row);
  }
  return rows;
}

function coerceCell(col: string, raw: string): unknown {
  if (raw === "" || raw === "null") return null;
  // ts_event / ts_recv / ts_in_delta — nanoseconds since epoch.
  if (col.startsWith("ts_") && /^\d+$/.test(raw)) {
    const ns = BigInt(raw);
    const ms = Number(ns / 1_000_000n);
    return new Date(ms).toISOString();
  }
  // Pricing / size / volume / instrument_id — numeric.
  if (
    col === "instrument_id" ||
    col === "volume" ||
    col === "size" ||
    col === "open" ||
    col === "high" ||
    col === "low" ||
    col === "close" ||
    col === "price" ||
    col === "bid_px_00" ||
    col === "ask_px_00" ||
    col === "bid_sz_00" ||
    col === "ask_sz_00"
  ) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return raw;
}

// ── HTTP ──────────────────────────────────────────────────────────

function apiKey(): string {
  const k = (process.env.DATABENTO_API_KEY ?? "").trim();
  if (!k) throw new Error("DATABENTO_API_KEY not set");
  return k;
}

function authHeader(): string {
  // Databento uses HTTP Basic with the API key as username, empty
  // password. Encode as base64.
  return "Basic " + Buffer.from(`${apiKey()}:`).toString("base64");
}

interface CostResponse {
  cost?: number;
  // Databento returns a JSON object; the exact key name has historically
  // been "cost" (USD). Defensive parsing in case the contract drifts.
  [k: string]: unknown;
}

export async function preflightCost(
  dataset: string,
  schema: string,
  symbol: string,
  start: string,
  end: string,
): Promise<number> {
  const url = new URL(`${API_BASE}/metadata.get_cost`);
  url.searchParams.set("dataset", dataset);
  url.searchParams.set("schema", schema);
  url.searchParams.set("symbols", parentSymbol(symbol));
  url.searchParams.set("stype_in", "parent");
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("mode", "historical");

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: authHeader(), Accept: "application/json" },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Databento metadata.get_cost HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const body = (await resp.json()) as CostResponse;
  const cost = typeof body.cost === "number" ? body.cost : 0;
  return cost;
}

async function fetchRangeCsv(
  dataset: string,
  schema: string,
  symbol: string,
  start: string,
  end: string,
): Promise<string> {
  const url = new URL(`${API_BASE}/timeseries.get_range`);
  url.searchParams.set("dataset", dataset);
  url.searchParams.set("schema", schema);
  url.searchParams.set("symbols", parentSymbol(symbol));
  url.searchParams.set("stype_in", "parent");
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("encoding", "csv");

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: authHeader(), Accept: "text/csv" },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Databento timeseries.get_range HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return await resp.text();
}

// ── Adapter ───────────────────────────────────────────────────────

async function fetchOne(req: DataRequest): Promise<DataResult> {
  const args = req.args as Partial<DatabentoRequestArgs>;
  if (!args.symbol || !args.dataset || !args.schema) {
    return { request: req, ok: false, error: "missing args.symbol/dataset/schema" };
  }
  if (!req.output) return { request: req, ok: false, error: "missing output" };

  try {
    const { start, end } = await incrementalWindow(req.output);
    if (start >= end) {
      // Nothing to fetch — caller's incremental cursor is at or past
      // the end boundary.
      return { request: req, ok: true, dataThrough: undefined };
    }
    const cost = await preflightCost(args.dataset, args.schema, args.symbol, start, end);
    if (shouldRefuseOnCost(cost)) {
      return {
        request: req,
        ok: false,
        error: `cost preflight refused: $${cost.toFixed(4)} for ${args.symbol}/${args.schema} [${start}..${end})`,
      };
    }
    const csv = await fetchRangeCsv(args.dataset, args.schema, args.symbol, start, end);
    const rows = parseCsvToRows(csv);
    if (rows.length === 0) {
      return { request: req, ok: true, dataThrough: undefined };
    }
    await mergeAndWriteParquetAuto({
      uri: req.output,
      dedupKey: "ts_event, instrument_id",
      rows,
      orderBy: "ts_event",
    });
    const last = rows[rows.length - 1];
    const lastTs = last?.ts_event;
    return {
      request: req,
      ok: true,
      dataThrough: typeof lastTs === "string" ? lastTs.slice(0, 10) : undefined,
    };
  } catch (e) {
    return { request: req, ok: false, error: (e as Error).message };
  }
}

export function createDatabentoAdapter(): DataAdapter {
  return {
    id: "databento",
    capabilities: { batch: false, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) results.push(await fetchOne(req));
      return results;
    },
  };
}
