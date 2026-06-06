// ── Orchestrator Storage ──────────────────────────────────────────
// Parquet I/O for data-source adapters. TypeScript port of the
// data-signals/data-sources/pipelines/storage.py module — same DATA_URI
// semantics, same helper surface (exists / readParquet / writeParquet /
// mergeAndWriteParquet), backed by DuckDB instead of fsspec+pyarrow.
//
// Resolves DATA_URI from env. Two modes:
//   file:///absolute/path/to/data    local dev
//   s3://bucket-name                 AWS S3 or MinIO (with S3_ENDPOINT_URL)
//
// All adapters write via mergeAndWriteParquet() to get the standard
// "incremental upsert with overlap window" semantics: read existing →
// concat new rows → dedup on a key column → write back atomically.

import duckdb, { type Database } from "duckdb";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Env-driven URI ───────────────────────────────────────────────

function resolveDataUri(): string {
  const uri = (process.env.DATA_URI ?? "").trim();
  if (uri) return uri.replace(/\/$/, "");
  const legacy = (process.env.DATA_DIR ?? "").trim();
  if (legacy) return `file://${legacy.replace(/\/$/, "")}`;
  throw new Error(
    "Neither DATA_URI nor DATA_DIR is set. Configure DATA_URI=file:///path or s3://bucket.",
  );
}

/**
 * Lazy DATA_URI accessor — defers env resolution until first use so importing
 * this module from a test/server context that doesn't need parquet I/O
 * doesn't throw. Each call re-reads in case env was mutated mid-process
 * (test setup pattern).
 */
export function dataUri(): string {
  return resolveDataUri();
}

export function joinUri(...parts: string[]): string {
  const root = dataUri();
  const clean = parts.filter(Boolean).map((p) => p.replace(/^\/+|\/+$/g, ""));
  return clean.length === 0 ? root : `${root}/${clean.join("/")}`;
}

function isS3(uri: string): boolean {
  return uri.startsWith("s3://");
}

function stripFileScheme(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

/**
 * DuckDB's parquet COPY/read_parquet accept raw local paths or `s3://` URIs
 * but choke on the `file://` scheme. Normalize.
 */
function uriForDuckDb(uri: string): string {
  return isS3(uri) ? uri : stripFileScheme(uri);
}

/**
 * For local file:// URIs, ensure the parent directory exists. No-op for s3://.
 */
function ensureParent(uri: string): void {
  if (isS3(uri)) return;
  const path = stripFileScheme(uri);
  const parent = dirname(path);
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

// ── DuckDB lifecycle ─────────────────────────────────────────────

export interface S3Config {
  region: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
}

export function readS3Config(): S3Config {
  return {
    region: (process.env.S3_REGION ?? "us-east-1").trim() || "us-east-1",
    endpoint: process.env.S3_ENDPOINT_URL?.trim() || undefined,
    accessKey: process.env.S3_ACCESS_KEY?.trim() || undefined,
    secretKey: process.env.S3_SECRET_KEY?.trim() || undefined,
  };
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

function execAsync(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function allAsync<T = Record<string, unknown>>(db: Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as unknown as T[]);
    });
  });
}

/**
 * Initialize DuckDB's httpfs extension with S3 credentials and (optionally)
 * a custom endpoint for MinIO-compatible stores. Env vars are canonical;
 * `overrides` lets a caller provide programmatic values (e.g., a chains-read
 * path that wants to point at a specific bucket) without round-tripping
 * through process.env.
 */
export async function initS3(db: Database, overrides: Partial<S3Config> = {}): Promise<void> {
  const cfg: S3Config = { ...readS3Config(), ...overrides };
  await execAsync(db, "INSTALL httpfs;");
  await execAsync(db, "LOAD httpfs;");
  await execAsync(db, `SET s3_region = '${escapeSqlString(cfg.region)}';`);
  if (cfg.endpoint) {
    // MinIO / custom S3 — DuckDB wants the host:port without scheme
    const host = cfg.endpoint.replace(/^https?:\/\//, "");
    const useSsl = cfg.endpoint.startsWith("https://");
    await execAsync(db, `SET s3_endpoint = '${escapeSqlString(host)}';`);
    await execAsync(db, `SET s3_use_ssl = ${useSsl};`);
    await execAsync(db, "SET s3_url_style = 'path';");
  }
  if (cfg.accessKey)
    await execAsync(db, `SET s3_access_key_id = '${escapeSqlString(cfg.accessKey)}';`);
  if (cfg.secretKey)
    await execAsync(db, `SET s3_secret_access_key = '${escapeSqlString(cfg.secretKey)}';`);
}

/**
 * Run a function with a fresh in-memory DuckDB. Initializes httpfs + S3 creds
 * if any of the URIs touched are s3://.
 */
export async function withDb<T>(
  fn: (db: Database) => Promise<T>,
  options: { needsS3?: boolean } = {},
): Promise<T> {
  const db = new duckdb.Database(":memory:");
  try {
    if (options.needsS3 || isS3(dataUri())) {
      await initS3(db);
    }
    return await fn(db);
  } finally {
    await new Promise<void>((resolve) => {
      db.close(() => resolve());
    });
  }
}

// ── Public surface ───────────────────────────────────────────────

/**
 * Whether a parquet exists at the given URI. For file:// URIs we use a fast
 * fs check; for s3:// we attempt a DuckDB metadata read.
 */
export async function exists(uri: string): Promise<boolean> {
  if (!isS3(uri)) return existsSync(stripFileScheme(uri));
  return withDb(async (db) => {
    try {
      await allAsync(db, `SELECT * FROM parquet_metadata('${escapeSqlString(uri)}') LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  });
}

function asReadable(uri: string): string {
  return uriForDuckDb(uri);
}

export interface ReadParquetOptions {
  columns?: string[];
  where?: string;
  orderBy?: string;
  limit?: number;
}

/**
 * Read a parquet file/glob into an array of plain objects. For large reads,
 * prefer using withDb directly to keep results in DuckDB rather than
 * materializing JS objects.
 */
export async function readParquet<T = Record<string, unknown>>(
  uri: string,
  opts: ReadParquetOptions = {},
): Promise<T[]> {
  return withDb(async (db) => {
    const cols = opts.columns?.length ? opts.columns.map((c) => `"${c}"`).join(", ") : "*";
    let sql = `SELECT ${cols} FROM read_parquet('${escapeSqlString(asReadable(uri))}')`;
    if (opts.where) sql += ` WHERE ${opts.where}`;
    if (opts.orderBy) sql += ` ORDER BY ${opts.orderBy}`;
    if (opts.limit !== undefined) sql += ` LIMIT ${Math.floor(opts.limit)}`;
    return allAsync<T>(db, sql);
  });
}

/**
 * Materialize an array of plain objects into a DuckDB temp table inside the
 * provided db connection. Adapters use this to feed new data through the
 * merge-and-write pipeline. Schema is the column list as DuckDB DDL,
 * e.g. "(date DATE, value DOUBLE)".
 */
export async function registerRows(
  db: Database,
  tableName: string,
  schema: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await execAsync(db, `CREATE TEMP TABLE "${tableName}" ${schema}`);
  if (rows.length === 0) return;
  const columns = parseSchemaColumns(schema);
  // Stream inserts via prepared statement for medium batches; for very large
  // batches the caller should use COPY FROM CSV/parquet instead.
  const placeholders = columns.map(() => "?").join(", ");
  const stmt = await new Promise<duckdb.Statement>((resolve, reject) => {
    db.prepare(
      `INSERT INTO "${tableName}" VALUES (${placeholders})`,
      (err: Error | null, s: duckdb.Statement) => {
        if (err) reject(err);
        else resolve(s);
      },
    );
  });
  try {
    for (const row of rows) {
      await new Promise<void>((resolve, reject) => {
        stmt.run(...columns.map((c) => normalizeForDuckDb(row[c])), (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  } finally {
    await new Promise<void>((resolve) => {
      stmt.finalize(() => resolve());
    });
  }
}

function parseSchemaColumns(schema: string): string[] {
  // Accept "(col1 TYPE, col2 TYPE, ...)" — extract column names
  const inner = schema.trim().replace(/^\(|\)$/g, "");
  const out: string[] = [];
  for (const piece of inner.split(",")) {
    const parts = piece.trim().split(/\s+/);
    const name = parts[0]?.replace(/^"|"$/g, "");
    if (name) out.push(name);
  }
  return out;
}

function normalizeForDuckDb(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * Append-or-upsert pattern shared by every batch ingest pipeline:
 *   1. Read existing parquet (if any) into a temp table
 *   2. Concat new rows
 *   3. Dedup on `dedupKey` (keep latest by row order — new rows win)
 *   4. COPY back to the same URI atomically
 *
 * `schema` is the DuckDB column list, e.g. "(date DATE, value DOUBLE)".
 * `dedupKey` is one or more column names used as the unique key (comma-joined).
 */
export async function mergeAndWriteParquet(args: {
  uri: string;
  schema: string;
  dedupKey: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  orderBy?: string;
}): Promise<{ rowCount: number }> {
  const { uri, schema, dedupKey, rows, orderBy } = args;
  return withDb(async (db) => {
    await registerRows(db, "incoming", schema, rows);

    const hadExisting = await exists(uri);
    if (hadExisting) {
      await execAsync(
        db,
        `CREATE TEMP TABLE existing AS SELECT * FROM read_parquet('${escapeSqlString(asReadable(uri))}')`,
      );
    } else {
      await execAsync(db, `CREATE TEMP TABLE existing ${schema}`);
    }

    // Combine, then keep the LAST row per dedup key (incoming wins because it's
    // appended after existing in the union order).
    await execAsync(
      db,
      `CREATE TEMP TABLE combined AS
       SELECT * FROM (SELECT *, 0 AS _src FROM existing UNION ALL
                      SELECT *, 1 AS _src FROM incoming)
       QUALIFY ROW_NUMBER() OVER (PARTITION BY ${dedupKey} ORDER BY _src DESC) = 1`,
    );

    const orderClause = orderBy ? `ORDER BY ${orderBy}` : "";
    ensureParent(uri);
    await execAsync(
      db,
      `COPY (SELECT * EXCLUDE (_src) FROM combined ${orderClause})
       TO '${escapeSqlString(uriForDuckDb(uri))}'
       (FORMAT PARQUET, OVERWRITE_OR_IGNORE)`,
    );

    const [count] = await allAsync<{ n: number | bigint }>(
      db,
      "SELECT count(*) AS n FROM combined",
    );
    return { rowCount: Number(count?.n ?? 0) };
  });
}

/**
 * Atomic-replace pattern: drop existing rows matching `replaceWhere` from the
 * parquet at `uri`, then append `rows`. Used when the new data is the
 * authoritative snapshot for some slice (e.g. all option contracts for a
 * given symbol+date) and stale rows in that slice should not survive.
 *
 * `replaceWhere` is a raw SQL predicate evaluated against the existing parquet
 * (e.g. `"date = '2026-04-30'"`). Caller is responsible for escaping any
 * user-controlled values.
 */
export async function replaceAndWriteParquet(args: {
  uri: string;
  schema: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  replaceWhere: string;
  orderBy?: string;
}): Promise<{ rowCount: number }> {
  const { uri, schema, rows, replaceWhere, orderBy } = args;
  return withDb(async (db) => {
    await registerRows(db, "incoming", schema, rows);

    const hadExisting = await exists(uri);
    if (hadExisting) {
      await execAsync(
        db,
        `CREATE TEMP TABLE existing AS
         SELECT * FROM read_parquet('${escapeSqlString(asReadable(uri))}')
         WHERE NOT (${replaceWhere})`,
      );
    } else {
      await execAsync(db, `CREATE TEMP TABLE existing ${schema}`);
    }

    await execAsync(
      db,
      `CREATE TEMP TABLE combined AS
       SELECT * FROM existing UNION ALL SELECT * FROM incoming`,
    );

    const orderClause = orderBy ? `ORDER BY ${orderBy}` : "";
    ensureParent(uri);
    await execAsync(
      db,
      `COPY (SELECT * FROM combined ${orderClause})
       TO '${escapeSqlString(uriForDuckDb(uri))}'
       (FORMAT PARQUET, OVERWRITE_OR_IGNORE)`,
    );

    const [count] = await allAsync<{ n: number | bigint }>(
      db,
      "SELECT count(*) AS n FROM combined",
    );
    return { rowCount: Number(count?.n ?? 0) };
  });
}

/**
 * Direct write — overwrite the parquet at `uri` with the given rows. Use when
 * the source is not incremental (e.g. a fresh universe snapshot, GICS table).
 */
export async function writeParquet(args: {
  uri: string;
  schema: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  orderBy?: string;
}): Promise<{ rowCount: number }> {
  const { uri, schema, rows, orderBy } = args;
  return withDb(async (db) => {
    await registerRows(db, "incoming", schema, rows);
    const orderClause = orderBy ? `ORDER BY ${orderBy}` : "";
    ensureParent(uri);
    await execAsync(
      db,
      `COPY (SELECT * FROM incoming ${orderClause})
       TO '${escapeSqlString(uriForDuckDb(uri))}'
       (FORMAT PARQUET, OVERWRITE_OR_IGNORE)`,
    );
    return { rowCount: rows.length };
  });
}

/**
 * Schema-less variant of mergeAndWriteParquet. Used by adapters with dynamic
 * column sets (PortWatch ArcGIS responses, GFW vessel events, marine cadastre
 * AIS) where hardcoding a DDL is impractical. Writes rows to a temp JSON file
 * and lets DuckDB's read_json_auto infer the schema, then merges with the
 * existing parquet and overwrites atomically.
 */
export async function mergeAndWriteParquetAuto(args: {
  uri: string;
  dedupKey: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  orderBy?: string;
}): Promise<{ rowCount: number }> {
  const { uri, dedupKey, rows, orderBy } = args;
  if (rows.length === 0) return { rowCount: 0 };

  const { writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const tempPath = joinPath(
    tmpdir(),
    `orch-ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  await writeFile(tempPath, JSON.stringify(rows));

  try {
    return await withDb(async (db) => {
      await execAsync(
        db,
        `CREATE TEMP TABLE incoming AS SELECT * FROM read_json_auto('${escapeSqlString(tempPath)}')`,
      );

      const hadExisting = await exists(uri);
      if (hadExisting) {
        await execAsync(
          db,
          `CREATE TEMP TABLE existing AS SELECT * FROM read_parquet('${escapeSqlString(asReadable(uri))}')`,
        );
        // UNION BY NAME tolerates schema drift across runs (new columns added).
        await execAsync(
          db,
          `CREATE TEMP TABLE combined AS
           SELECT * FROM (SELECT *, 0 AS _src FROM existing UNION ALL BY NAME
                          SELECT *, 1 AS _src FROM incoming)
           QUALIFY ROW_NUMBER() OVER (PARTITION BY ${dedupKey} ORDER BY _src DESC) = 1`,
        );
      } else {
        await execAsync(db, "CREATE TEMP TABLE combined AS SELECT * FROM incoming");
      }

      const orderClause = orderBy ? `ORDER BY ${orderBy}` : "";
      const excludeSrc = hadExisting ? "EXCLUDE (_src)" : "";
      ensureParent(uri);
      await execAsync(
        db,
        `COPY (SELECT * ${excludeSrc} FROM combined ${orderClause})
         TO '${escapeSqlString(uriForDuckDb(uri))}'
         (FORMAT PARQUET, OVERWRITE_OR_IGNORE)`,
      );
      const [count] = await allAsync<{ n: number | bigint }>(
        db,
        "SELECT count(*) AS n FROM combined",
      );
      return { rowCount: Number(count?.n ?? 0) };
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Max value of a column across an existing parquet — used by adapters to
 * compute incremental start dates ("fetch from last_date - overlap").
 */
export async function maxValue<T = string>(uri: string, column: string): Promise<T | null> {
  if (!(await exists(uri))) return null;
  return withDb(async (db) => {
    const rows = await allAsync<{ max_v: T }>(
      db,
      `SELECT max("${column}") AS max_v FROM read_parquet('${escapeSqlString(asReadable(uri))}')`,
    );
    const v = rows[0]?.max_v;
    return v ?? null;
  });
}
