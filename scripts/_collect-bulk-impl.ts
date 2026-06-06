#!/usr/bin/env node
// ── Bulk Historical Chain Collection ──────────────────────────────
// Single-process parallel collector. Runs N concurrent API fetches
// against a single DuckDB instance. Replaces the shell-based
// parallel collector.
//
// Features:
//   - Single DuckDB instance (no segfaults from concurrent access)
//   - Skips already-stored dates via parquet scan
//   - Tracks real API credits from response headers
//   - Stops at credit reserve threshold (default 5,000)
//   - Filters holidays (API "Market closed" dates cached, not re-fetched)
//   - Routes reads + writes through DATA_URI (file:// or s3://) via the
//     orchestrator storage helpers (initS3, joinUri, dataUri)
//
// Usage:
//   tsx scripts/collect-bulk.ts                          # 8 concurrent fetches
//   CONCURRENCY=16 tsx scripts/collect-bulk.ts           # 16 concurrent
//   RESERVE=10000 tsx scripts/collect-bulk.ts            # reserve 10k credits
//   tsx scripts/collect-bulk.ts --from 2019-01-02 --to 2026-04-11

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import duckdb, { type Database } from "duckdb";
import {
  rawHistoricalChain as historicalChain,
  getLastCredits,
} from "../src/lib/marketdata-api.js";
import { initS3, joinUri, dataUri } from "../server/orchestrator/storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ── Path resolution ────────────────────────────────────────────────
//
// Parquet writes go through DATA_URI (resolves to file://… or s3://…).
// Sidecar JSON state (.manifest.json, .nodata.json) stays on a local
// filesystem path — they're small, frequently mutated, and S3 isn't a
// great home for them. Defaults assume the dev layout (data/chains
// alongside the script).
//
// Container/server: DATA_URI=s3://quantfoundry-data + STATE_DIR=/data
// (mounted host volume) yields parquet writes to MinIO while sidecars
// remain on the host's local FS.

const STATE_DIR =
  process.env.COLLECT_BULK_STATE_DIR ?? process.env.DATA_DIR ?? resolve(PROJECT_ROOT, "data");
const CHAINS_STATE_DIR = resolve(STATE_DIR, "chains");
const MANIFEST_PATH = resolve(CHAINS_STATE_DIR, ".manifest.json");
const NODATA_PATH = resolve(CHAINS_STATE_DIR, ".nodata.json");
const CALENDAR_PATH = resolve(PROJECT_ROOT, "config", "market-calendar.json");
const UNIVERSE_PATH = resolve(PROJECT_ROOT, "config", "universe.txt");

// CHAINS_URI is the parquet root — joinUri composes either
//   file:///<DATA_DIR>/chains   (local mode)
// or
//   s3://<bucket>/chains        (s3 mode)
const CHAINS_URI = joinUri("chains");

// DuckDB's parquet COPY/read_parquet accept raw filesystem paths or
// s3:// URIs but choke on `file://`. Normalize per-call.
function uriForDuckDb(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

function isS3Uri(uri: string): boolean {
  return uri.startsWith("s3://");
}

// Per-chains-file URI (e.g. <CHAINS_URI>/SPY-2026-05.parquet).
function chainsFileUri(symbol: string, month: string): string {
  return `${CHAINS_URI}/${symbol}-${month}.parquet`;
}

function chainsSymbolGlobUri(symbol: string): string {
  return `${CHAINS_URI}/${symbol}-*.parquet`;
}

// SQL-quote a string literal (single quotes; escape embedded singles).
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ── Config ──────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 50; // MarketData.app hard limit
const CONCURRENCY = Math.min(parseInt(process.env.CONCURRENCY || "8", 10), MAX_CONCURRENCY);
const RESERVE = parseInt(process.env.RESERVE || "5000", 10);
const STRIKE_LIMIT = parseInt(process.env.STRIKE_LIMIT || "50", 10);
const RFR = parseFloat(process.env.RFR || "0.05");
const TOKEN =
  process.env.MD_TOKEN ||
  (() => {
    try {
      const env = readFileSync(resolve(PROJECT_ROOT, ".env"), "utf-8");
      const m = env.match(/^MD_TOKEN=(.+)$/m);
      return m?.[1] ?? "";
    } catch {
      return "";
    }
  })();

// Parse CLI args
const cliArgs = process.argv.slice(2);
let argFrom = "2019-01-02";
let argTo = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // yesterday
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === "--from") argFrom = cliArgs[++i] ?? argFrom;
  else if (cliArgs[i] === "--to") argTo = cliArgs[++i] ?? argTo;
}

if (!TOKEN) {
  console.error("ERROR: MD_TOKEN not set in .env or environment");
  process.exit(1);
}

// Ensure the local state dir exists (for sidecar JSON writes). No-op for
// the parquet path; that's handled by duckdb/s3.
if (!existsSync(CHAINS_STATE_DIR)) {
  mkdirSync(CHAINS_STATE_DIR, { recursive: true });
}

// ── Holiday filter ──────────────────────────────────────────────────

const knownClosedDates = new Set<string>();
// Per-symbol "no data" dates (persisted across runs)
let noDataDates: Record<string, string[]> = {};

function loadHolidays(): void {
  try {
    const cal = JSON.parse(readFileSync(CALENDAR_PATH, "utf-8")) as {
      exchanges: Record<string, { holidays?: string[] }>;
    };
    for (const exc of Object.values(cal.exchanges)) {
      for (const h of exc.holidays ?? []) knownClosedDates.add(h);
    }
  } catch {
    // ignore
  }
  try {
    noDataDates = JSON.parse(readFileSync(NODATA_PATH, "utf-8")) as Record<string, string[]>;
  } catch {
    noDataDates = {};
  }
}

function saveNoData(): void {
  writeFileSync(NODATA_PATH, JSON.stringify(noDataDates));
}

function isNoData(symbol: string, date: string): boolean {
  return noDataDates[symbol]?.includes(date) ?? false;
}

function addNoData(symbol: string, date: string): void {
  const existing = noDataDates[symbol];
  if (!existing) {
    noDataDates[symbol] = [date];
    return;
  }
  if (!existing.includes(date)) existing.push(date);
}

// ── Date helpers ────────────────────────────────────────────────────

function tradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !knownClosedDates.has(iso)) {
      days.push(iso);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ── DuckDB ──────────────────────────────────────────────────────────

function createDb(): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(":memory:", (err: Error | null) =>
      err ? reject(err) : resolve(db),
    );
  });
}

function dbRun(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function dbAll<T = Record<string, unknown>>(db: Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: unknown) =>
      err ? reject(err) : resolve((rows as T[]) ?? []),
    );
  });
}

// ── Manifest ────────────────────────────────────────────────────────

interface ManifestEntry {
  firstDate?: string;
  lastDate?: string;
  totalContracts?: number;
  totalCredits?: number;
}

type Manifest = Record<string, ManifestEntry>;

function loadManifest(): Manifest {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  } catch {
    return {};
  }
}

function saveManifest(manifest: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ── Universe ────────────────────────────────────────────────────────

function loadUniverse(): string[] {
  const raw = readFileSync(UNIVERSE_PATH, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// ── Get stored dates for a symbol ───────────────────────────────────
//
// For local mode, this used to readdirSync + glob; for URI mode we just
// hand the glob to read_parquet and let DuckDB handle it (s3:// supported
// via httpfs after initS3). DuckDB returns an error on "no files match
// glob" — catch and return an empty set.

async function getStoredDates(db: Database, symbol: string): Promise<Set<string>> {
  const glob = chainsSymbolGlobUri(symbol);
  try {
    const rows = await dbAll<{ date: unknown }>(
      db,
      `SELECT DISTINCT date FROM read_parquet(${sqlString(uriForDuckDb(glob))})`,
    );
    const dates = new Set<string>();
    for (const r of rows) {
      const d = r.date;
      if (typeof d === "string") dates.add(d);
      else if (d instanceof Date) dates.add(d.toISOString().slice(0, 10));
      else dates.add(String(d).slice(0, 10));
    }
    return dates;
  } catch {
    return new Set();
  }
}

// ── Parquet write ───────────────────────────────────────────────────

// Serialize parquet writes per file URI to avoid concurrent DuckDB table conflicts
const writeLocks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (writeLocks.has(key)) {
    await writeLocks.get(key);
  }
  const promise = fn();
  writeLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    writeLocks.delete(key);
  }
}

let writeCounter = 0;

interface Contract {
  underlying: string;
  underlyingPrice: number;
  expiration: string;
  side: string;
  strike: number;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume?: number;
  openInterest?: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

async function fileExistsAtUri(db: Database, uri: string): Promise<boolean> {
  if (isS3Uri(uri)) {
    // DuckDB's parquet_metadata throws on missing object; try and catch.
    try {
      await dbAll(db, `SELECT 1 FROM parquet_metadata(${sqlString(uri)}) LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }
  return existsSync(uriForDuckDb(uri));
}

async function writeToParquet(
  db: Database,
  symbol: string,
  date: string,
  contracts: Contract[],
): Promise<void> {
  const month = date.slice(0, 7);
  const uri = chainsFileUri(symbol, month);
  const duckdbPath = uriForDuckDb(uri);

  await withLock(uri, async () => {
    const table = `_tmp_${++writeCounter}`;

    await dbRun(
      db,
      `CREATE TABLE "${table}" (
      date DATE, underlying VARCHAR, underlyingPrice DOUBLE, expiration DATE,
      side VARCHAR, strike DOUBLE, dte INTEGER, bid DOUBLE, ask DOUBLE,
      mid DOUBLE, last DOUBLE, volume INTEGER, openInterest INTEGER,
      iv DOUBLE, delta DOUBLE, gamma DOUBLE, theta DOUBLE, vega DOUBLE, source VARCHAR
    )`,
    );

    const stmt = await new Promise<duckdb.Statement>((resolveStmt, rejectStmt) => {
      const s: duckdb.Statement = db.prepare(
        `INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        (err: Error | null) => (err ? rejectStmt(err) : resolveStmt(s)),
      );
    });

    for (const c of contracts) {
      await new Promise<void>((resolveRow, rejectRow) => {
        stmt.run(
          date,
          c.underlying,
          c.underlyingPrice,
          c.expiration,
          c.side,
          c.strike,
          c.dte,
          c.bid,
          c.ask,
          c.mid,
          c.last,
          c.volume ?? 0,
          c.openInterest ?? 0,
          c.iv,
          c.delta,
          c.gamma,
          c.theta,
          c.vega,
          "marketdata",
          (err: Error | null) => (err ? rejectRow(err) : resolveRow()),
        );
      });
    }
    await new Promise<void>((resolveFin, rejectFin) => {
      stmt.finalize((err: Error | null) => (err ? rejectFin(err) : resolveFin()));
    });

    // Merge with existing file if present.
    if (await fileExistsAtUri(db, uri)) {
      await dbRun(
        db,
        `INSERT INTO "${table}" SELECT * FROM read_parquet(${sqlString(duckdbPath)}) WHERE date NOT IN (SELECT DISTINCT date FROM "${table}")`,
      );
    }
    await dbRun(
      db,
      `COPY (SELECT * FROM "${table}" ORDER BY date, expiration, strike, side) TO ${sqlString(duckdbPath)} (FORMAT PARQUET, OVERWRITE)`,
    );
    await dbRun(db, `DROP TABLE "${table}"`);
  });
}

// ── Storage summary ────────────────────────────────────────────────

async function countStoredParquets(db: Database): Promise<number> {
  const glob = `${CHAINS_URI}/*.parquet`;
  try {
    const rows = await dbAll<{ n: number | bigint }>(
      db,
      `SELECT COUNT(*) AS n FROM glob(${sqlString(uriForDuckDb(glob))})`,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

// ── Main ────────────────────────────────────────────────────────────

interface QueueItem {
  symbol: string;
  date: string;
}

interface MarketDataError extends Error {
  status?: number;
}

async function main(): Promise<void> {
  loadHolidays();

  const uri = dataUri();
  const useS3 = isS3Uri(uri);

  const symbols = loadUniverse();
  const allDays = tradingDays(argFrom, argTo);
  const manifest = loadManifest();
  const db = await createDb();

  // Wire up httpfs + S3 creds once on the long-lived db when DATA_URI is s3://.
  if (useS3) {
    await initS3(db);
  }

  console.log();
  console.log("  Bulk Collection");
  console.log();
  console.log(`  DATA_URI:    ${uri}`);
  console.log(`  Chains URI:  ${CHAINS_URI}`);
  console.log(`  State dir:   ${CHAINS_STATE_DIR}`);
  console.log(`  Range:       ${argFrom} → ${argTo} (${allDays.length} trading days)`);
  console.log(`  Symbols:     ${symbols.length}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Reserve:     ${RESERVE} credits`);
  console.log();

  // Build work queue: [symbol, date] pairs that need fetching
  const queue: QueueItem[] = [];
  let skipCount = 0;
  let symbolsComplete = 0;
  let symbolsPartial = 0;
  let symbolsNew = 0;

  const lastDay = allDays[allDays.length - 1] ?? argTo;

  for (const symbol of symbols) {
    // Fast path: if manifest shows this symbol covers the full target range,
    // skip entirely (no parquet scan needed)
    const entry = manifest[symbol];
    if (
      entry?.firstDate &&
      entry?.lastDate &&
      entry.firstDate <= argFrom &&
      entry.lastDate >= lastDay
    ) {
      symbolsComplete++;
      skipCount += allDays.length;
      continue;
    }

    process.stdout.write(`  Scanning ${symbol}...  \r`);
    const stored = await getStoredDates(db, symbol);
    const missing = allDays.filter((d) => !stored.has(d) && !isNoData(symbol, d));
    skipCount += allDays.length - missing.length;

    if (missing.length === 0) {
      // Fully stored — update manifest with widest known range
      const prevFirst = entry?.firstDate ?? argFrom;
      const prevLast = entry?.lastDate ?? lastDay;
      manifest[symbol] = {
        ...entry,
        firstDate: prevFirst < argFrom ? prevFirst : argFrom,
        lastDate: prevLast > lastDay ? prevLast : lastDay,
      };
      symbolsComplete++;
    } else if (stored.size > 0) {
      symbolsPartial++;
    } else {
      symbolsNew++;
    }

    for (const date of missing) {
      queue.push({ symbol, date });
    }
  }

  // Save updated manifest (for symbols we marked complete via scan)
  saveManifest(manifest);

  console.log(
    `  Symbols:     ${symbolsComplete} complete, ${symbolsPartial} partial, ${symbolsNew} new`,
  );
  console.log(`  Work queue:  ${queue.length.toLocaleString()} symbol-days to fetch`);
  console.log(`  Skipped:     ${skipCount.toLocaleString()} already stored`);
  console.log();

  if (queue.length === 0) {
    console.log("  Nothing to collect — all dates stored.");
    db.close();
    return;
  }

  // Process queue with bounded concurrency
  let idx = 0;
  let totalContracts = 0;
  let creditsRemaining = null as number | null;
  let creditsAtStart = null as number | null;
  let rateLimited = false;
  let closedDatesFound = 0;
  let errors = 0;
  const startTime = Date.now();

  function creditsUsed(): number {
    if (creditsAtStart == null || creditsRemaining == null) return 0;
    return creditsAtStart - creditsRemaining;
  }

  function progress(): string {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = idx > 0 ? (idx / elapsed).toFixed(1) : "0";
    const used = creditsUsed();
    const remaining =
      creditsRemaining != null ? `  remaining: ${creditsRemaining.toLocaleString()}` : "";
    return `[${ts}] [${idx}/${queue.length}] ${rate} req/s  ${used.toLocaleString()} credits used${remaining}`;
  }

  async function worker(): Promise<void> {
    while (idx < queue.length && !rateLimited) {
      const i = idx++;
      const item = queue[i];
      if (!item) break;
      const { symbol, date } = item;

      try {
        const contracts = (await historicalChain(
          symbol,
          date,
          null,
          TOKEN,
          STRIKE_LIMIT,
          RFR,
        )) as Contract[];
        const credits = getLastCredits() as unknown as {
          remaining: number | null;
          consumed: number;
        };
        if (credits.remaining != null) creditsRemaining = credits.remaining;
        if (creditsAtStart == null && creditsRemaining != null) {
          creditsAtStart = creditsRemaining;
        }

        if (contracts.length > 0) {
          await writeToParquet(db, symbol, date, contracts);
          totalContracts += contracts.length;
        }

        // Update manifest (never shrink the range)
        const prev: ManifestEntry = manifest[symbol] ?? {
          firstDate: date,
          lastDate: date,
          totalContracts: 0,
          totalCredits: 0,
        };
        if (!prev.firstDate || date < prev.firstDate) prev.firstDate = date;
        if (!prev.lastDate || date > prev.lastDate) prev.lastDate = date;
        prev.totalContracts = (prev.totalContracts ?? 0) + contracts.length;
        prev.totalCredits = (prev.totalCredits ?? 0) + (credits.consumed || 1);
        manifest[symbol] = prev;

        // Check credit reserve
        if (creditsRemaining != null && creditsRemaining < RESERVE && !rateLimited) {
          console.log(
            `\n  Credits low (${creditsRemaining} remaining, reserve ${RESERVE}) — stopping.`,
          );
          rateLimited = true;
        }

        // Progress every 100 items — full log line, not \r overwrite
        if (i % 100 === 0) {
          console.log(`  ${progress()}`);
          saveManifest(manifest);
          saveNoData();
        }
      } catch (e: unknown) {
        const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
        const err = e as MarketDataError;
        if (err.message?.includes("Market closed")) {
          knownClosedDates.add(date);
          closedDatesFound++;
        } else if (err.status === 429) {
          console.log(`\n  [${ts}] Rate limited — stopping.`);
          rateLimited = true;
        } else if (
          err.status === 404 ||
          err.message?.includes("no_data") ||
          err.message?.includes("No chain data")
        ) {
          // No data for this date — cache it so we don't retry
          closedDatesFound++;
          addNoData(symbol, date);
        } else {
          errors++;
          if (errors <= 20) console.log(`\n  [${ts}] ${symbol} ${date}: ${err.message ?? e}`);
        }
      }
    }
  }

  // Launch workers
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Final save
  saveManifest(manifest);
  saveNoData();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const parquetCount = await countStoredParquets(db);
  console.log();
  console.log();
  console.log("  Done");
  const used = creditsUsed();
  console.log(
    `  Fetched:    ${idx.toLocaleString()} requests in ${elapsed}s (${(idx / (Number(elapsed) || 1)).toFixed(1)} req/s)`,
  );
  console.log(`  Contracts:  ${totalContracts.toLocaleString()}`);
  console.log(
    `  Credits:    ${used.toLocaleString()} used${creditsRemaining != null ? `, ${creditsRemaining.toLocaleString()} remaining` : ""}`,
  );
  console.log(`  Holidays:   ${closedDatesFound} market-closed dates discovered`);
  if (errors > 0) console.log(`  Errors:     ${errors}`);
  console.log(`  Storage:    ${parquetCount.toLocaleString()} parquet files`);
  console.log();

  db.close();
}

main().catch((e: unknown) => {
  const err = e as Error;
  console.error("Fatal:", err.message ?? e);
  process.exit(1);
});
