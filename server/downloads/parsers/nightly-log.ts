// ── data/chains/.nightly.log Parser ───────────────────────────────
// Splits the append-only nightly log into discrete run sessions and
// extracts the summary block, per-symbol activity, and credit-budget
// state for each run. Two formats coexist in the log (older runs use
// "Target range / Work items"; newer runs use "Bulk Collection" and
// per-request `[marketdata]` lines), so the parser handles both.

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { DownloadRun, RunActivityEntry, RunErrorRef } from "../types.js";

const RUN_START_MARKER = "── Nightly Collection ──";
const RUN_END_MARKER = "── Nightly Complete ──";
const CREDIT_CAP = 100_000;

interface RawRun {
  startedAt: string;
  finishedAt: string | null;
  symbols: Map<string, SymbolAgg>;
  errors: RunErrorRef[];
  summary: SummaryBlock;
  notes: string[];
  stoppedByCreditCap: boolean;
}

interface SummaryBlock {
  requests: number | null;
  durationSeconds: number | null;
  contracts: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  holidays: number | null;
  storageFiles: number | null;
}

interface SymbolAgg {
  symbol: string;
  dateMin: string | null;
  dateMax: string | null;
  contracts: number | null;
  creditsUsed: number | null;
  filesTouched: number;
  errors: RunErrorRef[];
}

const TS_LINE = /^\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*$/;

// Per-symbol header: "  [N/M] SYM  YYYY-MM-DD → YYYY-MM-DD  (mode)"
const SYMBOL_HEADER =
  /^\s*\[\d+\/\d+\]\s+([A-Z][A-Z0-9._-]*)\s+(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\s*\(([^)]+)\)\s*$/;

// Per-day "  K contracts (X credits used [Y remaining])" or "(~K credits total)"
const CONTRACTS_LINE = /(\d+)\s+contracts\s*\(([^)]+)\)/;

// New-style request line: "[marketdata] STATUS endpoint Xms credits=N/100000"
const REQUEST_LINE = /^\[marketdata\]\s+(\d{3})\s+(\S+)\s+(\d+)ms\s+credits=(\d+)\/(\d+)\s*$/;

// "Wrote SPY-2026-04.parquet"
const WROTE_LINE = /Wrote\s+([A-Z][A-Z0-9._-]*)-\d{4}-\d{2}\.parquet/;

// "Credits low (4999 remaining, reserve 5000) — stopping."
const CREDITS_LOW = /Credits low \((\d+)\s+remaining,\s+reserve\s+\d+\)/;

// Summary block lines (each appears once per run footer, before the END marker).
const SUMMARY_FETCHED = /Fetched:\s+([\d,]+)\s+requests\s+in\s+(\d+)s/;
const SUMMARY_CONTRACTS = /Contracts:\s+([\d,]+)/;
const SUMMARY_CREDITS = /Credits:\s+([\d,]+)\s+used,\s+([\d,]+)\s+remaining/;
const SUMMARY_HOLIDAYS = /Holidays:\s+(\d+)\s+market-closed/;
// Two storage formats: "Storage: 359M in 4321 files" (older) | "Storage: 50523 parquet files" (newer)
const SUMMARY_STORAGE_OLD = /Storage:\s+\S+\s+in\s+([\d,]+)\s+files/;
const SUMMARY_STORAGE_NEW = /Storage:\s+([\d,]+)\s+parquet\s+files/;

function parseInt2(s: string | undefined): number | null {
  if (s == null) return null;
  const n = parseInt(s.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function isoFromTs(line: string): string | null {
  const m = TS_LINE.exec(line);
  if (!m) return null;
  // Treat the timestamp as America/New_York wall time and output ISO-8601
  // with the local UTC offset. We approximate by emitting it as UTC since
  // the consumer formats with `fmtAge` (relative). For absolute display
  // we keep the original date+time string.
  return `${m[1]}T${m[2]}Z`;
}

function durationBetween(startIso: string, endIso: string): number {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000);
}

function makeEmptyRun(startedAt: string): RawRun {
  return {
    startedAt,
    finishedAt: null,
    symbols: new Map(),
    errors: [],
    summary: {
      requests: null,
      durationSeconds: null,
      contracts: null,
      creditsUsed: null,
      creditsRemaining: null,
      holidays: null,
      storageFiles: null,
    },
    notes: [],
    stoppedByCreditCap: false,
  };
}

function getOrCreateSymbol(run: RawRun, symbol: string): SymbolAgg {
  let agg = run.symbols.get(symbol);
  if (!agg) {
    agg = {
      symbol,
      dateMin: null,
      dateMax: null,
      contracts: null,
      creditsUsed: null,
      filesTouched: 0,
      errors: [],
    };
    run.symbols.set(symbol, agg);
  }
  return agg;
}

function widenRange(agg: SymbolAgg, a: string, b: string): void {
  if (!agg.dateMin || a < agg.dateMin) agg.dateMin = a;
  if (!agg.dateMax || b > agg.dateMax) agg.dateMax = b;
}

// Decide a final status from the parsed run state.
function deriveStatus(run: RawRun): DownloadRun["status"] {
  if (!run.finishedAt) return "incomplete";
  if (run.stoppedByCreditCap) return "stopped-credit-cap";
  if (run.errors.length > 0 && run.summary.contracts === null) return "error";
  return "ok";
}

function buildRunId(startedAt: string): string {
  return `chains-nightly:${startedAt}`;
}

export function rawToDownloadRun(raw: RawRun, source: string): DownloadRun {
  const credits =
    raw.summary.creditsUsed != null && raw.summary.creditsRemaining != null
      ? {
          used: raw.summary.creditsUsed,
          remaining: raw.summary.creditsRemaining,
          cap: CREDIT_CAP,
        }
      : null;
  return {
    id: buildRunId(raw.startedAt),
    source,
    started_at: raw.startedAt,
    finished_at: raw.finishedAt,
    duration_seconds:
      raw.summary.durationSeconds ??
      (raw.finishedAt ? durationBetween(raw.startedAt, raw.finishedAt) : null),
    status: deriveStatus(raw),
    request_count: raw.summary.requests,
    rows_written: raw.summary.contracts,
    files_written: raw.summary.storageFiles,
    credits,
    error_count: raw.errors.length,
    notes: raw.notes,
  };
}

// One streaming pass: emits both top-level run summaries and the
// per-symbol activity map. Caller can decide which to keep.
export interface ParsedRun {
  raw: RawRun;
  run: DownloadRun;
}

export async function parseNightlyLog(path: string, source: string): Promise<ParsedRun[]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const runs: ParsedRun[] = [];
  let current: RawRun | null = null;
  let pendingTimestamp: "start" | "end" | null = null;
  let lastSymbol: string | null = null;

  for await (const line of rl) {
    // Marker lines drive run boundaries first; the timestamp is on the
    // next non-blank line.
    if (line.includes(RUN_START_MARKER)) {
      // If a previous run never closed, finalize it as incomplete.
      if (current) {
        runs.push({ raw: current, run: rawToDownloadRun(current, source) });
      }
      current = null;
      pendingTimestamp = "start";
      lastSymbol = null;
      continue;
    }
    if (line.includes(RUN_END_MARKER)) {
      pendingTimestamp = "end";
      continue;
    }

    if (pendingTimestamp) {
      const iso = isoFromTs(line);
      if (iso) {
        if (pendingTimestamp === "start") {
          current = makeEmptyRun(iso);
        } else if (pendingTimestamp === "end" && current) {
          current.finishedAt = iso;
        }
        pendingTimestamp = null;
        continue;
      }
      // Blank line between marker and timestamp — keep waiting.
      if (line.trim() === "") continue;
      // Anything else: drop the pending marker and process this line.
      pendingTimestamp = null;
    }

    if (!current) continue;

    // Per-symbol header → start tracking activity for this symbol.
    const symMatch = SYMBOL_HEADER.exec(line);
    if (symMatch) {
      const [, sym, startD, endD] = symMatch;
      if (sym && startD && endD) {
        const agg = getOrCreateSymbol(current, sym);
        widenRange(agg, startD, endD);
        lastSymbol = sym;
      }
      continue;
    }

    // "Wrote SYM-YYYY-MM.parquet"
    const wroteMatch = WROTE_LINE.exec(line);
    if (wroteMatch && wroteMatch[1]) {
      const agg = getOrCreateSymbol(current, wroteMatch[1]);
      agg.filesTouched += 1;
      lastSymbol = wroteMatch[1];
      continue;
    }

    // Per-day "K contracts (...)" — credits the active symbol.
    const cMatch = CONTRACTS_LINE.exec(line);
    if (cMatch && cMatch[1] && lastSymbol) {
      const contracts = parseInt2(cMatch[1]);
      if (contracts != null) {
        const agg = getOrCreateSymbol(current, lastSymbol);
        agg.contracts = (agg.contracts ?? 0) + contracts;
      }
    }

    // Request-level [marketdata] line. Newer runs only.
    const reqMatch = REQUEST_LINE.exec(line);
    if (reqMatch && reqMatch[1] && reqMatch[2]) {
      const status = parseInt(reqMatch[1], 10);
      // Treat any non-2xx as an error worth surfacing. (The downloader
      // also emits 203 for empty chains, which we count as success.)
      if (status >= 400) {
        const ref: RunErrorRef = { http_status: status, endpoint: reqMatch[2], ts: null };
        current.errors.push(ref);
        // Best-effort attribute to the active symbol.
        const symFromEndpoint = /\/options\/chain\/([A-Z][A-Z0-9._-]*)\//.exec(reqMatch[2]);
        const sym = symFromEndpoint?.[1] ?? lastSymbol;
        if (sym) getOrCreateSymbol(current, sym).errors.push(ref);
      }
      continue;
    }

    if (CREDITS_LOW.test(line)) {
      current.stoppedByCreditCap = true;
      if (!current.notes.includes("Credits low — stopping")) {
        current.notes.push("Credits low — stopping");
      }
      continue;
    }

    // Summary block — only appears once near the end of a run.
    const fetched = SUMMARY_FETCHED.exec(line);
    if (fetched && fetched[1] && fetched[2]) {
      current.summary.requests = parseInt2(fetched[1]);
      current.summary.durationSeconds = parseInt2(fetched[2]);
      continue;
    }
    const con = SUMMARY_CONTRACTS.exec(line);
    if (con && con[1]) {
      current.summary.contracts = parseInt2(con[1]);
      continue;
    }
    const cred = SUMMARY_CREDITS.exec(line);
    if (cred && cred[1] && cred[2]) {
      current.summary.creditsUsed = parseInt2(cred[1]);
      current.summary.creditsRemaining = parseInt2(cred[2]);
      continue;
    }
    const hol = SUMMARY_HOLIDAYS.exec(line);
    if (hol && hol[1]) {
      current.summary.holidays = parseInt2(hol[1]);
      continue;
    }
    const stOld = SUMMARY_STORAGE_OLD.exec(line);
    if (stOld && stOld[1]) {
      current.summary.storageFiles = parseInt2(stOld[1]);
      continue;
    }
    const stNew = SUMMARY_STORAGE_NEW.exec(line);
    if (stNew && stNew[1]) {
      current.summary.storageFiles = parseInt2(stNew[1]);
      continue;
    }
  }

  if (current) {
    runs.push({ raw: current, run: rawToDownloadRun(current, source) });
  }

  return runs;
}

// Aggregator-level cache: re-parse only when the log mtime advances.
interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: ParsedRun[];
}

const cache = new Map<string, CacheEntry>();

export async function loadNightlyLog(path: string, source: string): Promise<ParsedRun[]> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed;
  }
  const parsed = await parseNightlyLog(path, source);
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

export function activityFromRaw(raw: RawRun): RunActivityEntry[] {
  const entries: RunActivityEntry[] = [];
  for (const agg of raw.symbols.values()) {
    entries.push({
      symbol: agg.symbol,
      date_range: agg.dateMin && agg.dateMax ? [agg.dateMin, agg.dateMax] : null,
      contracts: agg.contracts,
      credits_used: agg.creditsUsed,
      files_touched: agg.filesTouched,
      errors: agg.errors,
    });
  }
  // Stable sort: most contracts first, then symbol name.
  entries.sort((a, b) => {
    const ac = a.contracts ?? 0;
    const bc = b.contracts ?? 0;
    if (bc !== ac) return bc - ac;
    return a.symbol.localeCompare(b.symbol);
  });
  return entries;
}

// Test-only: clear the in-memory cache.
export function _resetCache(): void {
  cache.clear();
}
