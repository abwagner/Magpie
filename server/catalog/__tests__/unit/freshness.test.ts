// ── Unit tests: computeFreshness ─────────────────────────────────
// Covers status transitions (fresh/stale/missing), null data_through
// preservation, and sources-not-in-config behaviour.
//
// Uses an in-memory DuckDB and the write_jobs DDL from the store module.

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

interface InsertRow {
  jobId: string;
  source: string | null;
  status: string;
  completedAt: string | null;
  dataThrough: string | null;
}

async function insertJob(db: Database, row: InsertRow): Promise<void> {
  await runExec(
    db,
    `INSERT INTO write_jobs
       (job_id, kind, params_json, idempotency_key, status, actor,
        submitted_at, completed_at, source, data_through)
     VALUES (?, 'ingest', '{}', ?, ?, 'test', '2025-01-01T00:00:00Z', ?, ?, ?)`,
    [row.jobId, row.jobId, row.status, row.completedAt, row.source, row.dataThrough],
  );
}

// ── Config fixtures ───────────────────────────────────────────────

const SIMPLE_CONFIG: DataPlaneConfig = {
  ingestion: {
    fred: { enabled: true, expected_cadence_hours: 24 },
    eia: { enabled: true, expected_cadence_hours: 168 },
  },
};

// Fixed reference time: 2025-06-01T12:00:00Z
const NOW_MS = new Date("2025-06-01T12:00:00Z").getTime();

// ── Tests ─────────────────────────────────────────────────────────

describe("computeFreshness", () => {
  let db: Database;

  beforeEach(async () => {
    db = await makeDb();
  });

  afterEach(() => {
    db.close(() => {});
  });

  // ── Status transitions ────────────────────────────────────────

  it("returns 'fresh' when age_hours <= expected_cadence_hours", async () => {
    // 12 hours ago — within 24h cadence
    const lastSuccess = new Date(NOW_MS - 12 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j1",
      source: "fred",
      status: "completed",
      completedAt: lastSuccess,
      dataThrough: "2025-05-31",
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred).toBeDefined();
    expect(fred!.status).toBe("fresh");
    expect(fred!.age_hours).toBeCloseTo(12, 1);
  });

  it("returns 'stale' when expected_cadence < age <= 2× expected_cadence", async () => {
    // 36 hours ago — beyond 24h but within 48h
    const lastSuccess = new Date(NOW_MS - 36 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j2",
      source: "fred",
      status: "completed",
      completedAt: lastSuccess,
      dataThrough: "2025-05-30",
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred!.status).toBe("stale");
    expect(fred!.age_hours).toBeCloseTo(36, 1);
  });

  it("returns 'missing' when age_hours > 2× expected_cadence_hours", async () => {
    // 50 hours ago — beyond 48h (2 × 24h)
    const lastSuccess = new Date(NOW_MS - 50 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j3",
      source: "fred",
      status: "completed",
      completedAt: lastSuccess,
      dataThrough: "2025-05-29",
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred!.status).toBe("missing");
  });

  it("returns 'missing' when source has no completed ingest rows", async () => {
    // No jobs inserted for any source.
    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred).toBeDefined();
    expect(fred!.status).toBe("missing");
    expect(fred!.last_success_at).toBeNull();
    expect(fred!.age_hours).toBeNull();
  });

  it("ignores failed and running jobs — only completed rows count", async () => {
    const recentFailed = new Date(NOW_MS - 1 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j4",
      source: "fred",
      status: "failed",
      completedAt: recentFailed,
      dataThrough: "2025-06-01",
    });
    await insertJob(db, {
      jobId: "j5",
      source: "fred",
      status: "running",
      completedAt: null,
      dataThrough: null,
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred!.status).toBe("missing");
    expect(fred!.last_success_at).toBeNull();
  });

  // ── At cadence boundary (exact edge) ─────────────────────────

  it("is fresh when age_hours equals expected_cadence_hours exactly", async () => {
    const lastSuccess = new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j6",
      source: "fred",
      status: "completed",
      completedAt: lastSuccess,
      dataThrough: "2025-05-31",
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred!.status).toBe("fresh");
  });

  it("is stale when age_hours equals 2× expected_cadence_hours exactly", async () => {
    const lastSuccess = new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j7",
      source: "fred",
      status: "completed",
      completedAt: lastSuccess,
      dataThrough: "2025-05-30",
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred!.status).toBe("stale");
  });

  // ── null data_through ────────────────────────────────────────

  it("preserves null data_through when the job has no data_through", async () => {
    const lastSuccess = new Date(NOW_MS - 6 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j8",
      source: "fred",
      status: "completed",
      completedAt: lastSuccess,
      dataThrough: null,
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const fred = results.find((r) => r.source === "fred");
    expect(fred!.data_through).toBeNull();
    expect(fred!.last_success_at).not.toBeNull();
    expect(fred!.status).toBe("fresh");
  });

  // ── Sources not in config ─────────────────────────────────────

  it("includes sources from DB that are absent from config with expected_cadence_hours: null, status: 'missing'", async () => {
    const lastSuccess = new Date(NOW_MS - 1 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j9",
      source: "retired-source",
      status: "completed",
      completedAt: lastSuccess,
      dataThrough: "2025-06-01",
    });

    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const retired = results.find((r) => r.source === "retired-source");
    expect(retired).toBeDefined();
    expect(retired!.expected_cadence_hours).toBeNull();
    expect(retired!.status).toBe("missing");
    expect(retired!.last_success_at).not.toBeNull();
  });

  // ── Config sources appear even with no DB rows ────────────────

  it("emits a row for every config source even if no write_jobs rows exist", async () => {
    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const sources = results.map((r) => r.source);
    expect(sources).toContain("fred");
    expect(sources).toContain("eia");
  });

  it("includes expected_cadence_hours from config for config-declared sources", async () => {
    const results = await computeFreshness(db, SIMPLE_CONFIG, NOW_MS);
    const eia = results.find((r) => r.source === "eia");
    expect(eia!.expected_cadence_hours).toBe(168);
  });
});
