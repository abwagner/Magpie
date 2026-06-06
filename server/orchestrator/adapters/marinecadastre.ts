// ── MarineCadastre Adapter ─────────────────────────────────────────
// NOAA Office for Coastal Management — historical US-waters AIS bulk.
// Native TS port of data-signals/data-sources/pipelines/marinecadastre.py.
//
// Two file formats live at the same base URL:
//   2009-2024:  AIS_YYYY_MM_DD.zip       (zip → CSV)
//   2025+:      ais-YYYY-MM-DD.csv.zst   (zstd-compressed CSV)
//
// Files run 170-325 MB each. After the tanker filter (VesselType ∈ [80,89]
// per ITU-R M.1371) the per-day parquet is typically 5-20 MB. We stream
// decompression to a temp CSV, then let DuckDB's read_csv_auto handle the
// filter + parquet write — DuckDB streams the CSV without materializing
// the whole thing in memory.
//
// Output layout: <root>/year=YYYY/month=MM/AIS_YYYY_MM_DD.parquet
//
// Manifest contract:
//   args: { date?: "2026-04-27", since?: "2024-01-01", until?: "2024-01-31",
//           force?: false }
//   output: "flows/marinecadastre/_latest.parquet"  (or directory root —
//           the directory above _latest is the date-partition root)

import { mkdirSync, existsSync, statSync, createWriteStream, createReadStream, unlinkSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as unzipper from "unzipper";
import { init as initZstd, decompress as zstdDecompress } from "@bokuweb/zstd-wasm";
import duckdb, { type Database } from "duckdb";
import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, joinUri } from "../storage.js";

const BASE_URL = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler";
const ZSTD_FORMAT_FROM_YEAR = 2025;
const DOWNLOAD_RETRIES = 3;
const BACKOFF_SECONDS = 5;
const DOWNLOAD_TIMEOUT_MS = 600_000; // 10 min

let zstdReady = false;
async function ensureZstd(): Promise<void> {
  if (zstdReady) return;
  await initZstd();
  zstdReady = true;
}

// ── URL / path builders ──────────────────────────────────────────

function urlForDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (y >= ZSTD_FORMAT_FROM_YEAR) return `${BASE_URL}/${y}/ais-${y}-${m}-${day}.csv.zst`;
  return `${BASE_URL}/${y}/AIS_${y}_${m}_${day}.zip`;
}

function outputUriFor(rootUri: string, d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const root = rootUri.replace(/\/$/, "");
  return `${root}/year=${y}/month=${m}/AIS_${y}_${m}_${day}.parquet`;
}

function isS3(uri: string): boolean {
  return uri.startsWith("s3://");
}
function stripFileScheme(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

// ── Download with retries ────────────────────────────────────────

async function downloadToFile(url: string, destPath: string): Promise<number> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < DOWNLOAD_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (resp.status === 404) throw new NoaaNotFoundError(`NOAA 404: ${url}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (!resp.body) throw new Error("empty body");
      mkdirSync(dirname(destPath), { recursive: true });
      await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(destPath));
      return statSync(destPath).size;
    } catch (e) {
      if (e instanceof NoaaNotFoundError) throw e;
      lastErr = e;
      if (attempt + 1 < DOWNLOAD_RETRIES) {
        const delay = BACKOFF_SECONDS * 2 ** attempt;
        console.warn(`[marinecadastre] retry ${attempt + 1}/${DOWNLOAD_RETRIES} after ${delay}s: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  }
  throw (lastErr as Error) ?? new Error("download failed");
}

class NoaaNotFoundError extends Error {}

// ── Decompression ────────────────────────────────────────────────

async function decompressZip(archivePath: string, outDir: string): Promise<string> {
  // Extract the first .csv inside. NOAA AIS zips contain a single CSV.
  const zip = await unzipper.Open.file(archivePath);
  const csvEntry = zip.files.find((f: { path: string }) => f.path.toLowerCase().endsWith(".csv"));
  if (!csvEntry)
    throw new Error(`No CSV in ${archivePath}: ${zip.files.map((f: { path: string }) => f.path).join(", ")}`);
  const out = join(outDir, basename(csvEntry.path));
  await pipeline(csvEntry.stream(), createWriteStream(out));
  return out;
}

async function decompressZst(archivePath: string, outDir: string): Promise<string> {
  await ensureZstd();
  const compressed = await import("node:fs/promises").then((m) => m.readFile(archivePath));
  const decompressed = zstdDecompress(new Uint8Array(compressed));
  const out = join(outDir, basename(archivePath).replace(/\.zst$/, ""));
  await import("node:fs/promises").then((m) => m.writeFile(out, decompressed));
  return out;
}

// ── DuckDB filter + parquet write ───────────────────────────────

function execAsync(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

async function filterAndWriteParquet(csvPath: string, outputUri: string): Promise<number> {
  const db = new duckdb.Database(":memory:");
  try {
    if (isS3(outputUri)) {
      await execAsync(db, "INSTALL httpfs;");
      await execAsync(db, "LOAD httpfs;");
      // S3 creds inherited from env via DuckDB's standard setup; for MinIO
      // configure via env in deployment.
    }
    if (!isS3(outputUri)) {
      mkdirSync(dirname(stripFileScheme(outputUri)), { recursive: true });
    }
    const dest = isS3(outputUri) ? outputUri : stripFileScheme(outputUri);
    await execAsync(
      db,
      `COPY (
         SELECT * FROM read_csv_auto('${escapeSqlString(csvPath)}', SAMPLE_SIZE=20000, IGNORE_ERRORS=TRUE)
         WHERE TRY_CAST(VesselType AS INTEGER) BETWEEN 80 AND 89
       )
       TO '${escapeSqlString(dest)}'
       (FORMAT PARQUET, OVERWRITE_OR_IGNORE)`,
    );
    const rows = await new Promise<number>((resolve, reject) => {
      db.all(
        `SELECT count(*) AS n FROM read_parquet('${escapeSqlString(dest)}')`,
        (err, result) => {
          if (err) reject(err);
          else resolve(Number((result[0] as { n: number | bigint } | undefined)?.n ?? 0));
        },
      );
    });
    return rows;
  } finally {
    await new Promise<void>((resolve) => db.close(() => resolve()));
  }
}

// ── Orchestration ────────────────────────────────────────────────

async function ingestOneDay(d: Date, outRootUri: string, force: boolean): Promise<{ wrote: boolean; rows: number; uri: string }> {
  const outUri = outputUriFor(outRootUri, d);
  if (!force && (await exists(outUri))) {
    console.log(`[marinecadastre] skip existing ${outUri}`);
    return { wrote: false, rows: 0, uri: outUri };
  }
  const url = urlForDate(d);
  const tmpDir = mkdtempSync(join(tmpdir(), "marinecadastre-"));
  const isZst = d.getUTCFullYear() >= ZSTD_FORMAT_FROM_YEAR;
  const archivePath = join(tmpDir, isZst ? "ais.csv.zst" : "ais.zip");
  try {
    console.log(`[marinecadastre] download ${url}`);
    await downloadToFile(url, archivePath);
    const csvPath = isZst
      ? await decompressZst(archivePath, tmpDir)
      : await decompressZip(archivePath, tmpDir);
    const rows = await filterAndWriteParquet(csvPath, outUri);
    console.log(`[marinecadastre] wrote ${rows} tanker rows → ${outUri}`);
    return { wrote: true, rows, uri: outUri };
  } finally {
    for (const name of readdirSync(tmpDir)) {
      try {
        unlinkSync(join(tmpDir, name));
      } catch {
        // ignore
      }
    }
    try {
      const { rmdirSync } = await import("node:fs");
      rmdirSync(tmpDir);
    } catch {
      // ignore
    }
  }
}

function* dateRange(since: Date, until: Date): Generator<Date> {
  const cur = new Date(since);
  while (cur <= until) {
    yield new Date(cur);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

function parseDate(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${s}`);
  return d;
}

function rootFromOutput(out: string | undefined): string | undefined {
  if (!out) return undefined;
  // The manifest may point output at <root>/_latest.parquet (a sentinel for
  // freshness checks). Strip that to get the date-partition root.
  if (out.endsWith("/_latest.parquet")) return out.slice(0, -"/_latest.parquet".length);
  return out;
}

async function fetchOne(req: DataRequest): Promise<DataResult> {
  const outRoot = rootFromOutput(req.output);
  if (!outRoot) return { request: req, ok: false, error: "missing output" };
  const force = Boolean(req.args.force);

  let dates: Date[];
  if (req.args.date) {
    dates = [parseDate(String(req.args.date))];
  } else {
    const since = parseDate(String(req.args.since ?? req.since ?? "2024-01-01"));
    const yesterdayUtc = new Date();
    yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1);
    const untilStr = (req.args.until as string | undefined) ?? yesterdayUtc.toISOString().slice(0, 10);
    const until = parseDate(untilStr);
    dates = [...dateRange(since, until)];
  }

  let lastWritten: string | undefined;
  let totalRows = 0;
  for (const d of dates) {
    try {
      const r = await ingestOneDay(d, outRoot, force);
      totalRows += r.rows;
      if (r.wrote) lastWritten = d.toISOString().slice(0, 10);
    } catch (e) {
      if (e instanceof NoaaNotFoundError) {
        console.warn(`[marinecadastre] not yet published: ${d.toISOString().slice(0, 10)}`);
        continue;
      }
      return { request: req, ok: false, error: (e as Error).message };
    }
  }

  // Write a small _latest.parquet sentinel so freshness checks can read it
  // with the same machinery as single-file ingestors.
  if (lastWritten) {
    await writeLatestSentinel(outRoot, lastWritten, dates.length, totalRows);
  }
  return { request: req, ok: true, dataThrough: lastWritten };
}

async function writeLatestSentinel(
  outRoot: string,
  latestDate: string,
  daysAttempted: number,
  totalRows: number,
): Promise<void> {
  const { writeParquet } = await import("../storage.js");
  const today = new Date().toISOString().slice(0, 10);
  await writeParquet({
    uri: `${outRoot}/_latest.parquet`,
    schema: "(as_of_date DATE, latest_date DATE, days_present INTEGER, total_rows BIGINT)",
    rows: [{ as_of_date: today, latest_date: latestDate, days_present: daysAttempted, total_rows: totalRows }],
  });
}

export function createMarinecadastreAdapter(): DataAdapter {
  return {
    id: "marinecadastre",
    capabilities: { batch: false, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) results.push(await fetchOne(req));
      return results;
    },
  };
}
