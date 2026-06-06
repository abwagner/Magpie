// ── Write-Jobs DuckDB Store (M10-1) ───────────────────────────────
//
// Thin CRUD wrapper around the `write_jobs` table. Pattern mirrors
// `server/risk/halts.ts` — single-table DDL in `init()`, inline
// runExec/runQuery helpers, async surface keyed off job_id.
//
// Schema:
//   job_id           ULID PRIMARY KEY
//   kind             VARCHAR NOT NULL
//   params_json      VARCHAR NOT NULL          -- JSON-serialized
//   idempotency_key  VARCHAR NOT NULL UNIQUE   -- enforced via SELECT-first; DuckDB UNIQUE is weak with concurrent writers but the runner serializes submits anyway
//   status           VARCHAR NOT NULL
//   actor            VARCHAR NOT NULL
//   submitted_at     TIMESTAMP NOT NULL
//   started_at       TIMESTAMP
//   completed_at     TIMESTAMP
//   error            VARCHAR
//   progress         BIGINT NOT NULL DEFAULT 0
//   total            BIGINT
//   output_paths_json VARCHAR NOT NULL DEFAULT '[]'
//   source           VARCHAR                   -- upstream source slug (QF-292)
//   data_through     DATE                      -- latest data date from handler (QF-292)

import type { Database } from "duckdb";
import type { WriteJob, WriteJobStatus } from "./types.js";

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS write_jobs (
    job_id           VARCHAR PRIMARY KEY,
    kind             VARCHAR NOT NULL,
    params_json      VARCHAR NOT NULL,
    idempotency_key  VARCHAR NOT NULL,
    status           VARCHAR NOT NULL,
    actor            VARCHAR NOT NULL,
    submitted_at     TIMESTAMP NOT NULL,
    started_at       TIMESTAMP,
    completed_at     TIMESTAMP,
    error            VARCHAR,
    progress         BIGINT NOT NULL DEFAULT 0,
    total            BIGINT,
    output_paths_json VARCHAR NOT NULL DEFAULT '[]',
    source           VARCHAR,
    data_through     DATE
  )
`;

// Migration SQL: add the two QF-292 columns to pre-existing databases.
// DuckDB supports ADD COLUMN IF NOT EXISTS from v0.9; both stmts are
// idempotent so re-running init() on an already-migrated DB is safe.
const MIGRATION_DDL = [
  "ALTER TABLE write_jobs ADD COLUMN IF NOT EXISTS source VARCHAR",
  "ALTER TABLE write_jobs ADD COLUMN IF NOT EXISTS data_through DATE",
];

function runExec(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, ...params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function runQuery<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

interface WriteJobRow {
  job_id: string;
  kind: string;
  params_json: string;
  idempotency_key: string;
  status: string;
  actor: string;
  submitted_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  error: string | null;
  progress: number | bigint;
  total: number | bigint | null;
  output_paths_json: string;
  source: string | null;
  // DuckDB DATE columns arrive as Date objects or ISO strings.
  data_through: Date | string | null;
}

function rowToJob(row: WriteJobRow): WriteJob {
  return {
    job_id: row.job_id,
    kind: row.kind,
    params: JSON.parse(row.params_json),
    idempotency_key: row.idempotency_key,
    status: row.status as WriteJobStatus,
    actor: row.actor,
    submitted_at: tsToIso(row.submitted_at),
    started_at: row.started_at === null ? null : tsToIso(row.started_at),
    completed_at: row.completed_at === null ? null : tsToIso(row.completed_at),
    error: row.error,
    progress: typeof row.progress === "bigint" ? Number(row.progress) : (row.progress ?? 0),
    total:
      row.total === null ? null : typeof row.total === "bigint" ? Number(row.total) : row.total,
    output_paths: JSON.parse(row.output_paths_json) as string[],
    source: row.source ?? null,
    data_through: row.data_through === null ? null : dateToIso(row.data_through),
  };
}

// DuckDB DATE columns come back as Date objects (midnight UTC) or
// "YYYY-MM-DD" strings depending on the driver version; normalise both.
function dateToIso(v: Date | string): string {
  if (typeof v === "string") {
    // May already be a full ISO timestamp if the column was written as VARCHAR.
    return v.slice(0, 10);
  }
  return v.toISOString().slice(0, 10);
}

function tsToIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface InsertJobInput {
  job_id: string;
  kind: string;
  params: unknown;
  idempotency_key: string;
  actor: string;
  submitted_at: string;
  /** Upstream source slug; null for multi-source or source-agnostic jobs. */
  source?: string | null;
}

export interface UpdateJobPatch {
  status?: WriteJobStatus;
  started_at?: string;
  completed_at?: string;
  error?: string | null;
  progress?: number;
  total?: number | null;
  output_paths?: string[];
  /** Latest data date (YYYY-MM-DD) written at job completion. */
  data_through?: string | null;
}

export interface WriteJobsStore {
  init(): Promise<void>;
  insert(input: InsertJobInput): Promise<void>;
  /** Lookup by idempotency key, restricted to active rows
   *  (queued|running). Used by `submit()` to dedupe. */
  findActiveByIdempotencyKey(key: string): Promise<WriteJob | null>;
  get(jobId: string): Promise<WriteJob | null>;
  update(jobId: string, patch: UpdateJobPatch): Promise<void>;
  list(opts: {
    kind?: string;
    status?: WriteJobStatus;
    limit?: number;
    /** Default `submitted_at DESC`. */
    order?: "submitted_at_asc" | "submitted_at_desc";
  }): Promise<WriteJob[]>;
  /** Sweep jobs left in `running` by a prior process and mark them
   *  `failed`. Returns the count touched. */
  markOrphansFailed(reason: string): Promise<number>;
}

export function createWriteJobsStore(db: Database): WriteJobsStore {
  return {
    async init(): Promise<void> {
      await runExec(db, TABLE_DDL);
      // Idempotent migrations: add the QF-292 columns to existing databases.
      // DuckDB ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.
      for (const sql of MIGRATION_DDL) {
        await runExec(db, sql);
      }
      // Helper indexes for the two read paths the API uses.
      await runExec(
        db,
        "CREATE INDEX IF NOT EXISTS write_jobs_idem_idx ON write_jobs (idempotency_key)",
      );
      await runExec(
        db,
        "CREATE INDEX IF NOT EXISTS write_jobs_status_idx ON write_jobs (status, submitted_at)",
      );
    },

    async insert(input): Promise<void> {
      await runExec(
        db,
        `INSERT INTO write_jobs
           (job_id, kind, params_json, idempotency_key, status, actor,
            submitted_at, progress, output_paths_json, source)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, '[]', ?)`,
        [
          input.job_id,
          input.kind,
          JSON.stringify(input.params ?? null),
          input.idempotency_key,
          input.actor,
          input.submitted_at,
          input.source ?? null,
        ],
      );
    },

    async findActiveByIdempotencyKey(key): Promise<WriteJob | null> {
      const rows = await runQuery<WriteJobRow>(
        db,
        `SELECT * FROM write_jobs
           WHERE idempotency_key = ?
             AND status IN ('queued', 'running')
           ORDER BY submitted_at DESC
           LIMIT 1`,
        [key],
      );
      const row = rows[0];
      return row ? rowToJob(row) : null;
    },

    async get(jobId): Promise<WriteJob | null> {
      const rows = await runQuery<WriteJobRow>(
        db,
        "SELECT * FROM write_jobs WHERE job_id = ? LIMIT 1",
        [jobId],
      );
      const row = rows[0];
      return row ? rowToJob(row) : null;
    },

    async update(jobId, patch): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.started_at !== undefined) {
        sets.push("started_at = ?");
        params.push(patch.started_at);
      }
      if (patch.completed_at !== undefined) {
        sets.push("completed_at = ?");
        params.push(patch.completed_at);
      }
      if (patch.error !== undefined) {
        sets.push("error = ?");
        params.push(patch.error);
      }
      if (patch.progress !== undefined) {
        sets.push("progress = ?");
        params.push(patch.progress);
      }
      if (patch.total !== undefined) {
        sets.push("total = ?");
        params.push(patch.total);
      }
      if (patch.output_paths !== undefined) {
        sets.push("output_paths_json = ?");
        params.push(JSON.stringify(patch.output_paths));
      }
      if (patch.data_through !== undefined) {
        sets.push("data_through = ?");
        params.push(patch.data_through);
      }
      if (sets.length === 0) return;
      params.push(jobId);
      await runExec(db, `UPDATE write_jobs SET ${sets.join(", ")} WHERE job_id = ?`, params);
    },

    async list(opts): Promise<WriteJob[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.kind) {
        where.push("kind = ?");
        params.push(opts.kind);
      }
      if (opts.status) {
        where.push("status = ?");
        params.push(opts.status);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const orderSql =
        opts.order === "submitted_at_asc"
          ? "ORDER BY submitted_at ASC"
          : "ORDER BY submitted_at DESC";
      // DuckDB chokes on parameterised LIMIT in some configs; clamp + interpolate.
      const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
      const sql = `SELECT * FROM write_jobs ${whereSql} ${orderSql} LIMIT ${limit}`;
      const rows = await runQuery<WriteJobRow>(db, sql, params);
      return rows.map(rowToJob);
    },

    async markOrphansFailed(reason): Promise<number> {
      const before = await runQuery<{ n: number | bigint }>(
        db,
        "SELECT count(*) AS n FROM write_jobs WHERE status = 'running'",
      );
      const n = before[0]?.n ?? 0;
      const count = typeof n === "bigint" ? Number(n) : n;
      if (count === 0) return 0;
      const now = new Date().toISOString();
      await runExec(
        db,
        `UPDATE write_jobs
           SET status = 'failed',
               completed_at = ?,
               error = ?
         WHERE status = 'running'`,
        [now, reason],
      );
      return count;
    },
  };
}
