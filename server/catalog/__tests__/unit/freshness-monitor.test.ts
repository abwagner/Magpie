// ── Unit tests: FreshnessMonitor (QF-295) ────────────────────────
//
// Covers the acceptance criteria from the ticket:
//   1. First-tick cold-start fires for all currently-stale/missing sources.
//   2. No re-fire while continuously stale.
//   3. ingest.recovered.<source> fires on stale → fresh transition.
//   4. New source added to config: treated as missing on first tick.
//   5. ingest.failed.<source> from runner (tested in runner integration;
//      unit here covers the monitor side only).
//
// Integration test: insert a completed write_jobs row 36h ago for a 24h-
// cadence source; tick fires ingest.stale.<source>. Insert a newer completed
// row, tick again, fires ingest.recovered.<source>.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import duckdb, { type Database } from "duckdb";
import { createFreshnessMonitor } from "../../freshness-monitor.js";
import type { DataPlaneConfig } from "../../freshness.js";
import type { AlertEvent, AlertRouter } from "../../../alerts/router.js";

// ── In-memory DuckDB ──────────────────────────────────────────────

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
  source: string;
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

// ── Stub alert router ────────────────────────────────────────────

function makeAlertRouter(): AlertRouter & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    load: async () => {},
    get: () => ({ version: 1, rules: [] }),
    replace: async (_rules) => ({ version: 1, rules: [] }),
    setInternalSink: () => {},
    async record(input) {
      const event: AlertEvent = {
        ts: input.ts ?? new Date().toISOString(),
        type: input.type,
        level: input.level,
        message: input.message,
        ...(input.payload ? { payload: input.payload } : {}),
      };
      events.push(event);
      return event;
    },
    recent: () => [],
  };
}

// ── Stub logger ───────────────────────────────────────────────────

function makeLogger(): import("../../../logger.js").Logger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeLogger(),
  };
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

describe("FreshnessMonitor", () => {
  let db: Database;
  let alertRouter: ReturnType<typeof makeAlertRouter>;

  beforeEach(async () => {
    db = await makeDb();
    alertRouter = makeAlertRouter();
  });

  afterEach(() => {
    db.close(() => {});
  });

  // ── 1. Cold start fires for all stale/missing ─────────────────

  it("first tick fires ingest.stale for every stale/missing source", async () => {
    // fred: stale (36h ago, 24h cadence)
    const staleAt = new Date(NOW_MS - 36 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-fred",
      source: "fred",
      status: "completed",
      completedAt: staleAt,
      dataThrough: "2025-05-30",
    });
    // eia: missing (no row)

    const monitor = createFreshnessMonitor({
      db,
      config: SIMPLE_CONFIG,
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    await monitor.tick();

    const types = alertRouter.events.map((e) => e.type);
    expect(types).toContain("ingest.stale.fred");
    expect(types).toContain("ingest.stale.eia");
    expect(types).not.toContain("ingest.recovered.fred");
    expect(types).not.toContain("ingest.recovered.eia");
  });

  it("first tick does NOT fire for fresh sources", async () => {
    // fred: fresh (2h ago, 24h cadence)
    const freshAt = new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-fred",
      source: "fred",
      status: "completed",
      completedAt: freshAt,
      dataThrough: "2025-06-01",
    });
    // eia: missing (no row) — should still fire

    const monitor = createFreshnessMonitor({
      db,
      config: SIMPLE_CONFIG,
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    await monitor.tick();

    const types = alertRouter.events.map((e) => e.type);
    expect(types).not.toContain("ingest.stale.fred");
    expect(types).toContain("ingest.stale.eia");
  });

  // ── 2. No re-fire while continuously stale ────────────────────

  it("does not re-fire ingest.stale while source remains stale", async () => {
    const staleAt = new Date(NOW_MS - 36 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-fred",
      source: "fred",
      status: "completed",
      completedAt: staleAt,
      dataThrough: "2025-05-30",
    });
    // eia: missing (no row)

    const monitor = createFreshnessMonitor({
      db,
      config: SIMPLE_CONFIG,
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    await monitor.tick();
    const countAfterFirst = alertRouter.events.length;

    // Second tick — no new data added, same staleness.
    await monitor.tick();
    // No new events should have fired.
    expect(alertRouter.events.length).toBe(countAfterFirst);
  });

  // ── 3. Recovered event on stale → fresh transition ────────────

  it("fires ingest.recovered when source transitions from stale to fresh", async () => {
    // fred initially stale (36h ago, 24h cadence)
    const staleAt = new Date(NOW_MS - 36 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-stale",
      source: "fred",
      status: "completed",
      completedAt: staleAt,
      dataThrough: "2025-05-30",
    });

    const monitor = createFreshnessMonitor({
      db,
      config: SIMPLE_CONFIG,
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    // First tick — fires ingest.stale.fred
    await monitor.tick();
    const staleTypes = alertRouter.events.map((e) => e.type);
    expect(staleTypes).toContain("ingest.stale.fred");

    // Now add a fresh row (2h ago)
    const freshAt = new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-fresh",
      source: "fred",
      status: "completed",
      completedAt: freshAt,
      dataThrough: "2025-06-01",
    });

    alertRouter.events.length = 0; // clear events

    // Second tick — fred is now fresh → fires ingest.recovered.fred
    await monitor.tick();
    const recoveredTypes = alertRouter.events.map((e) => e.type);
    expect(recoveredTypes).toContain("ingest.recovered.fred");
    expect(recoveredTypes).not.toContain("ingest.stale.fred");
  });

  it("fires ingest.recovered when missing source gains a fresh row", async () => {
    // eia: missing (no row)
    const monitor = createFreshnessMonitor({
      db,
      config: SIMPLE_CONFIG,
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    await monitor.tick();
    const firstTypes = alertRouter.events.map((e) => e.type);
    expect(firstTypes).toContain("ingest.stale.eia");

    // eia now has a fresh row (10h ago, 168h cadence)
    const freshAt = new Date(NOW_MS - 10 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-eia",
      source: "eia",
      status: "completed",
      completedAt: freshAt,
      dataThrough: "2025-06-01",
    });

    alertRouter.events.length = 0;
    await monitor.tick();

    const recoveryTypes = alertRouter.events.map((e) => e.type);
    expect(recoveryTypes).toContain("ingest.recovered.eia");
  });

  // ── 4. New source added to config ────────────────────────────

  it("treats a new source in config as missing on the first tick", async () => {
    const configWithNew: DataPlaneConfig = {
      ingestion: {
        fred: { enabled: true, expected_cadence_hours: 24 },
        "new-source": { enabled: true, expected_cadence_hours: 48 },
      },
    };
    // No rows for either source
    const monitor = createFreshnessMonitor({
      db,
      config: configWithNew,
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    await monitor.tick();
    const types = alertRouter.events.map((e) => e.type);
    expect(types).toContain("ingest.stale.new-source");
  });

  // ── 5. Integration: stale → tick → recovered ────────────────

  it("integration: 36h-old completed row → stale; add newer row → recovered", async () => {
    const staleAt = new Date(NOW_MS - 36 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "int-stale",
      source: "fred",
      status: "completed",
      completedAt: staleAt,
      dataThrough: "2025-05-29",
    });

    const monitor = createFreshnessMonitor({
      db,
      config: SIMPLE_CONFIG,
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    await monitor.tick();
    const staleEvent = alertRouter.events.find((e) => e.type === "ingest.stale.fred");
    expect(staleEvent).toBeDefined();
    expect(staleEvent!.level).toBe("warning");
    expect(staleEvent!.payload).toMatchObject({
      source: "fred",
      expected_cadence_hours: 24,
    });

    // Insert a newer row (1h ago)
    const newAt = new Date(NOW_MS - 1 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "int-fresh",
      source: "fred",
      status: "completed",
      completedAt: newAt,
      dataThrough: "2025-06-01",
    });

    alertRouter.events.length = 0;
    await monitor.tick();

    const recoveredEvent = alertRouter.events.find((e) => e.type === "ingest.recovered.fred");
    expect(recoveredEvent).toBeDefined();
    expect(recoveredEvent!.level).toBe("info");
    expect(recoveredEvent!.payload).toMatchObject({ source: "fred" });
  });

  // ── 6. Stale fires once, then suppressed until recovery ───────

  it("stale fires once then stays quiet until recovered, fires again if goes stale again", async () => {
    // Start stale
    const staleAt = new Date(NOW_MS - 36 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-stale-1",
      source: "fred",
      status: "completed",
      completedAt: staleAt,
      dataThrough: "2025-05-29",
    });

    const monitor = createFreshnessMonitor({
      db,
      config: { ingestion: { fred: { enabled: true, expected_cadence_hours: 24 } } },
      alertRouter,
      logger: makeLogger(),
      nowMs: () => NOW_MS,
    });

    // Tick 1: fires stale
    await monitor.tick();
    expect(alertRouter.events.filter((e) => e.type === "ingest.stale.fred")).toHaveLength(1);

    // Tick 2: still stale → no new events
    await monitor.tick();
    expect(alertRouter.events.filter((e) => e.type === "ingest.stale.fred")).toHaveLength(1);

    // Recover
    const freshAt = new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString();
    await insertJob(db, {
      jobId: "j-fresh-1",
      source: "fred",
      status: "completed",
      completedAt: freshAt,
      dataThrough: "2025-06-01",
    });

    // Tick 3: recovered → ingest.recovered.fred
    await monitor.tick();
    expect(alertRouter.events.filter((e) => e.type === "ingest.recovered.fred")).toHaveLength(1);

    // Now simulate going stale again by using a new monitor with cleared fresh data
    // (simulated via a 3rd stale tick point). We just delete the fresh row and re-run.
    await runExec(db, "DELETE FROM write_jobs WHERE job_id = 'j-fresh-1'");

    // Tick 4: fred is stale again — should fire once more
    await monitor.tick();
    expect(alertRouter.events.filter((e) => e.type === "ingest.stale.fred")).toHaveLength(2);
  });
});
