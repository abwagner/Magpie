// ── Catalog Collector Helpers ─────────────────────────────────────
// Shared utilities used across collectors: DuckDB query wrapper,
// filesystem walk with size/mtime aggregation, timestamp coercion.

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type RunQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

// Minimal structural type: DuckDB's node binding exposes `all()` on
// both Database and Connection. We don't import the official type
// because the installed d.ts varies and we only need this one method.
interface QueryCapable {
  all(sql: string, ...args: unknown[]): void;
}

// Serializes through a single DuckDB connection. The node binding is
// not safe to drive with overlapping `all()` calls on the same
// connection; the queue gates queries so each runs to completion
// before the next starts.
export function makeSerialRunQuery(conn: QueryCapable): RunQuery {
  let chain: Promise<unknown> = Promise.resolve();
  return <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const next = chain.then(
      () =>
        new Promise<T[]>((resolveP, rejectP) => {
          conn.all(sql, ...params, (err: Error | null, rows: unknown) => {
            if (err) rejectP(err);
            else resolveP((rows as T[]) ?? []);
          });
        }),
    );
    chain = next.catch(() => {
      /* isolate queue from per-call errors */
    });
    return next;
  };
}

export interface FileStat {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export function listFiles(dir: string, filter: (name: string) => boolean): FileStat[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: FileStat[] = [];
  for (const name of entries) {
    if (!filter(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ path, name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

export function walkFiles(root: string, filter: (name: string) => boolean): FileStat[] {
  const stack = [root];
  const out: FileStat[] = [];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) stack.push(path);
        else if (filter(name)) out.push({ path, name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // skip unreadable entries
      }
    }
  }
  return out;
}

// DuckDB returns TIMESTAMP as Date; strings come through as-is. Coerce
// either to a YYYY-MM-DD string, returning null for missing values.
export function toIsoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  // Already looks like YYYY-MM-DD or a full ISO timestamp
  return s.length >= 10 ? s.slice(0, 10) : null;
}

export function mtimeToIso(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString().replace(/\.\d+Z$/, "Z");
}

export function resolveUnder(root: string, sub: string): string {
  return resolve(root, sub);
}

// Safely stringify for SQL parquet paths — DuckDB expects forward slashes
// and no single quotes. We only accept paths we constructed ourselves,
// but defend against odd filenames by rejecting quotes outright.
export function parquetLiteral(path: string): string {
  if (path.includes("'")) throw new Error(`Unsafe parquet path: ${path}`);
  return `'${path.replace(/\\/g, "/")}'`;
}

/**
 * Introspect a parquet file or glob into a list of `{ name, dtype, nullable }`.
 * Uses DuckDB's `DESCRIBE SELECT * FROM read_parquet(...)` — works for both
 * single files and globs (DuckDB infers a unified schema across the set).
 *
 * Returns `[]` on error (missing file, unreadable parquet, etc.) rather than
 * throwing. Catalog responses must always succeed; column_schema being empty
 * is the agreed-on "introspection unavailable" sentinel for v1.1.
 *
 * `nullable` is best-effort: DuckDB's DESCRIBE reports a `null` column with
 * "YES"/"NO". Since parquet permits nulls by default and we don't enforce
 * NOT NULL anywhere, treat "NO" as not-nullable, anything else as nullable.
 */
export async function getColumnSchema(
  pathOrGlob: string,
  runQuery: RunQuery,
): Promise<{ name: string; dtype: string; nullable: boolean }[]> {
  try {
    const rows = await runQuery<{ column_name: string; column_type: string; null: string }>(
      `DESCRIBE SELECT * FROM read_parquet(${parquetLiteral(pathOrGlob)})`,
    );
    return rows.map((r) => ({
      name: r.column_name,
      dtype: r.column_type,
      nullable: r.null !== "NO",
    }));
  } catch {
    return [];
  }
}
