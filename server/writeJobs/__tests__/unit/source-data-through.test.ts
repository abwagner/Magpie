// ── Tests: QF-292 source + data_through schema extension ────────────
//
// Verifies:
//   1. DDL migration is idempotent (can be run on a pre-existing DB).
//   2. source is populated from handler.sourceFor() at submit time.
//   3. data_through is persisted from handler result at completion.
//   4. source and data_through are present and correct in GET /list output.
//   5. sourceFor() mappings for each relevant handler.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import duckdb, { type Database } from "duckdb";
import { createLogger } from "../../../logger.js";
import { createWriteJobRunner } from "../../runner.js";
import { createWriteJobsStore } from "../../store.js";
import type { HandlerResult, JobHandler } from "../../types.js";
import { ingestHandler } from "../../handlers/ingest.js";
import { orchestrateRefreshHandler } from "../../handlers/orchestrate-refresh.js";
import { fmpBackfillHandler } from "../../handlers/fmp-backfill.js";
import { databentoPullHandler } from "../../handlers/databento-pull.js";
import { collectBulkHandler } from "../../handlers/collect-bulk.js";
import { chainStoreHandler } from "../../handlers/chain-store.js";
import { syncToS3Handler } from "../../handlers/sync-to-s3.js";

const logger = createLogger("test").child("write-jobs:qf-292");

async function makeStore(): Promise<{
  db: Database;
  store: ReturnType<typeof createWriteJobsStore>;
}> {
  const db = new duckdb.Database(":memory:");
  const store = createWriteJobsStore(db);
  await store.init();
  return { db, store };
}

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForStatus(
  runner: ReturnType<typeof createWriteJobRunner>,
  jobId: string,
  status: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await runner.status(jobId);
    if (job && job.status === status) return;
    await tick(5);
  }
  const final = await runner.status(jobId);
  throw new Error(`timeout waiting for ${jobId} → ${status}; saw ${final?.status ?? "(missing)"}`);
}

// ── DDL migration ──────────────────────────────────────────────────

describe("write_jobs DDL migration (QF-292)", () => {
  it("init() is idempotent — calling it twice does not error", async () => {
    const db = new duckdb.Database(":memory:");
    const store = createWriteJobsStore(db);
    await expect(store.init()).resolves.toBeUndefined();
    // Second call runs the ADD COLUMN IF NOT EXISTS migration stmts again.
    await expect(store.init()).resolves.toBeUndefined();
    db.close(() => {});
  });

  it("new rows have source and data_through as null by default", async () => {
    const { db, store } = await makeStore();
    await store.insert({
      job_id: "01JTEST000001",
      kind: "test",
      params: {},
      idempotency_key: "idem-1",
      actor: "tester",
      submitted_at: new Date().toISOString(),
    });
    const job = await store.get("01JTEST000001");
    expect(job).not.toBeNull();
    expect(job!.source).toBeNull();
    expect(job!.data_through).toBeNull();
    db.close(() => {});
  });

  it("insert respects a provided source", async () => {
    const { db, store } = await makeStore();
    await store.insert({
      job_id: "01JTEST000002",
      kind: "test",
      params: {},
      idempotency_key: "idem-2",
      actor: "tester",
      submitted_at: new Date().toISOString(),
      source: "fred",
    });
    const job = await store.get("01JTEST000002");
    expect(job!.source).toBe("fred");
    db.close(() => {});
  });

  it("update() can set data_through", async () => {
    const { db, store } = await makeStore();
    await store.insert({
      job_id: "01JTEST000003",
      kind: "test",
      params: {},
      idempotency_key: "idem-3",
      actor: "tester",
      submitted_at: new Date().toISOString(),
    });
    await store.update("01JTEST000003", { data_through: "2025-12-31" });
    const job = await store.get("01JTEST000003");
    expect(job!.data_through).toBe("2025-12-31");
    db.close(() => {});
  });
});

// ── Runner integration ─────────────────────────────────────────────

describe("runner: source population (QF-292)", () => {
  let db: Database;
  let runner: ReturnType<typeof createWriteJobRunner>;

  beforeEach(async () => {
    const s = await makeStore();
    db = s.db;
    runner = createWriteJobRunner({ store: s.store, logger });
  });

  afterEach(() => {
    db.close(() => {});
  });

  it("populates source from handler.sourceFor() at submit time", async () => {
    const handler: JobHandler<{ src: string }> = {
      kind: "sourced-kind",
      sourceFor: (p) => p.src,
      async run(): Promise<HandlerResult> {
        return { output_paths: [] };
      },
    };
    runner.registerHandler(handler);
    const { job_id } = await runner.submit({ kind: "sourced-kind", params: { src: "fmp" } }, "t");
    await waitForStatus(runner, job_id, "completed");
    const job = (await runner.status(job_id))!;
    expect(job.source).toBe("fmp");
  });

  it("source is null when handler has no sourceFor()", async () => {
    const handler: JobHandler = {
      kind: "unsourced-kind",
      async run(): Promise<HandlerResult> {
        return { output_paths: [] };
      },
    };
    runner.registerHandler(handler);
    const { job_id } = await runner.submit({ kind: "unsourced-kind", params: {} }, "t");
    await waitForStatus(runner, job_id, "completed");
    const job = (await runner.status(job_id))!;
    expect(job.source).toBeNull();
  });

  it("persists data_through from handler result at completion", async () => {
    const handler: JobHandler = {
      kind: "dt-kind",
      async run(): Promise<HandlerResult> {
        return { output_paths: [], data_through: "2025-06-01" };
      },
    };
    runner.registerHandler(handler);
    const { job_id } = await runner.submit({ kind: "dt-kind", params: {} }, "t");
    await waitForStatus(runner, job_id, "completed");
    const job = (await runner.status(job_id))!;
    expect(job.data_through).toBe("2025-06-01");
  });

  it("data_through is null when handler does not return it", async () => {
    const handler: JobHandler = {
      kind: "no-dt-kind",
      async run(): Promise<HandlerResult> {
        return { output_paths: [] };
      },
    };
    runner.registerHandler(handler);
    const { job_id } = await runner.submit({ kind: "no-dt-kind", params: {} }, "t");
    await waitForStatus(runner, job_id, "completed");
    const job = (await runner.status(job_id))!;
    expect(job.data_through).toBeNull();
  });

  it("both source and data_through are present on listed jobs", async () => {
    const handler: JobHandler<{ src: string }> = {
      kind: "full-kind",
      sourceFor: (p) => p.src,
      async run(): Promise<HandlerResult> {
        return { output_paths: ["s3://b/o"], data_through: "2025-05-31" };
      },
    };
    runner.registerHandler(handler);
    const { job_id } = await runner.submit(
      { kind: "full-kind", params: { src: "databento" } },
      "t",
    );
    await waitForStatus(runner, job_id, "completed");
    const jobs = await runner.list({ kind: "full-kind" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.source).toBe("databento");
    expect(jobs[0]!.data_through).toBe("2025-05-31");
  });
});

// ── Handler sourceFor() mappings ───────────────────────────────────

describe("handler sourceFor() mappings (QF-292)", () => {
  it("ingest: sourceFor returns params.source when present", () => {
    expect(ingestHandler.sourceFor?.({ source: "fred" })).toBe("fred");
  });

  it("ingest: sourceFor returns null when params.source is absent", () => {
    expect(ingestHandler.sourceFor?.({})).toBeNull();
    expect(ingestHandler.sourceFor?.({ signal: "peg-rotation" })).toBeNull();
  });

  it("orchestrate-refresh: sourceFor returns params.source", () => {
    expect(
      orchestrateRefreshHandler.sourceFor?.({
        source: "eia",
        args: {},
        output: "out.parquet",
      }),
    ).toBe("eia");
  });

  it("fmp-backfill: sourceFor always returns 'fmp'", () => {
    expect(fmpBackfillHandler.sourceFor?.({})).toBe("fmp");
    expect(fmpBackfillHandler.sourceFor?.({ universe_parquet: "x.parquet" })).toBe("fmp");
  });

  it("databento-pull: sourceFor always returns 'databento'", () => {
    expect(databentoPullHandler.sourceFor?.({})).toBe("databento");
  });

  it("collect-bulk: has no sourceFor (source is null)", () => {
    // collect-bulk is source-agnostic; no sourceFor defined.
    expect(collectBulkHandler.sourceFor).toBeUndefined();
  });

  it("chain-store: has no sourceFor (source is null)", () => {
    expect(chainStoreHandler.sourceFor).toBeUndefined();
  });

  it("sync-to-s3: has no sourceFor (source is null)", () => {
    expect(syncToS3Handler.sourceFor).toBeUndefined();
  });
});
