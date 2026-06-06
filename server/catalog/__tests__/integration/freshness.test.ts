// ── Integration test: freshness MAX semantics ─────────────────────
// Inserts two completed write_jobs rows for the same source with
// different completed_at / data_through values and asserts that the
// freshness endpoint surfaces the MAX of both (most recent row wins).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import duckdb, { type Database } from "duckdb";
import { computeFreshness, type DataPlaneConfig } from "../../freshness.js";

// ── Helpers ───────────────────────────────────────────────────────

function runExec(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, ...params, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

async function makeDb(): Promise<Database> {
  const db = new duckdb.Database(":memory:");
  await runExec(
    db,
    `CREATE TABLE write_jobs (
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
    )`,
  );
  return db;
}

const CONFIG: DataPlaneConfig = {
  ingestion: {
    fred: { enabled: true, expected_cadence_hours: 24 },
  },
};

// Fixed reference time
const NOW_MS = new Date("2025-06-01T12:00:00Z").getTime();

// ── Tests ─────────────────────────────────────────────────────────

describe("computeFreshness — MAX semantics (integration)", () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeDb();
  });

  afterEach(() => {
    db.close(() => {});
  });

  it("picks MAX(completed_at) and MAX(data_through) across two completed rows", async () => {
    // Older row: completed 20h ago, data through May 29
    const older = new Date(NOW_MS - 20 * 60 * 60 * 1000).toISOString();
    // Newer row: completed 4h ago, data through May 31
    const newer = new Date(NOW_MS - 4 * 60 * 60 * 1000).toISOString();

    await runExec(
      db,
      `INSERT INTO write_jobs
         (job_id, kind, params_json, idempotency_key, status, actor,
          submitted_at, completed_at, source, data_through)
       VALUES
         ('j-old', 'ingest', '{}', 'j-old', 'completed', 'test',
          '2025-05-31T16:00:00Z', ?, 'fred', '2025-05-29'),
         ('j-new', 'ingest', '{}', 'j-new', 'completed', 'test',
          '2025-06-01T08:00:00Z', ?, 'fred', '2025-05-31')`,
      [older, newer],
    );

    const results = await computeFreshness(db, CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred).toBeDefined();

    // last_success_at must be the newer timestamp.
    expect(fred!.last_success_at).not.toBeNull();
    const lastSuccessMs = new Date(fred!.last_success_at!).getTime();
    const newerMs = new Date(newer).getTime();
    // Allow small rounding (DuckDB may truncate sub-second precision).
    expect(Math.abs(lastSuccessMs - newerMs)).toBeLessThan(1000);

    // data_through must be the later date.
    expect(fred!.data_through).toBe("2025-05-31");

    // age_hours ≈ 4h → fresh (< 24h cadence)
    expect(fred!.status).toBe("fresh");
    expect(fred!.age_hours).toBeCloseTo(4, 0);
  });

  it("handles a mix of completed and failed rows — only completed rows count", async () => {
    const completedAt = new Date(NOW_MS - 6 * 60 * 60 * 1000).toISOString();
    // A failed row with a more recent timestamp should be ignored.
    const failedAt = new Date(NOW_MS - 1 * 60 * 60 * 1000).toISOString();

    await runExec(
      db,
      `INSERT INTO write_jobs
         (job_id, kind, params_json, idempotency_key, status, actor,
          submitted_at, completed_at, source, data_through)
       VALUES
         ('j-ok',   'ingest', '{}', 'j-ok',   'completed', 'test',
          '2025-06-01T06:00:00Z', ?, 'fred', '2025-05-31'),
         ('j-fail', 'ingest', '{}', 'j-fail', 'failed',    'test',
          '2025-06-01T11:00:00Z', ?, 'fred', '2025-06-01')`,
      [completedAt, failedAt],
    );

    const results = await computeFreshness(db, CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");

    // The completed row at 6h ago should be the one returned.
    const lastSuccessMs = new Date(fred!.last_success_at!).getTime();
    const completedMs = new Date(completedAt).getTime();
    expect(Math.abs(lastSuccessMs - completedMs)).toBeLessThan(1000);

    // data_through from the completed row, not the failed one.
    expect(fred!.data_through).toBe("2025-05-31");
    expect(fred!.status).toBe("fresh");
  });
});
