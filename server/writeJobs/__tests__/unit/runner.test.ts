import { afterEach, beforeEach, describe, expect, it } from "vitest";
import duckdb, { type Database } from "duckdb";
import { createLogger } from "../../../logger.js";
import { createWriteJobRunner, computeIdempotencyKey } from "../../runner.js";
import { createWriteJobsStore } from "../../store.js";
import type { JobHandler } from "../../types.js";

const logger = createLogger("test").child("write-jobs");

async function makeStore(): Promise<{
  db: Database;
  store: ReturnType<typeof createWriteJobsStore>;
}> {
  const db = new duckdb.Database(":memory:");
  const store = createWriteJobsStore(db);
  await store.init();
  return { db, store };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

describe("WriteJobRunner", () => {
  let db: Database;
  let runner: ReturnType<typeof createWriteJobRunner>;
  let store: ReturnType<typeof createWriteJobsStore>;

  beforeEach(async () => {
    ({ db, store } = await makeStore());
    runner = createWriteJobRunner({ store, logger });
  });

  afterEach(() => {
    db.close(() => {});
  });

  it("registerHandler refuses duplicate kinds", () => {
    const h: JobHandler = {
      kind: "k",
      async run() {
        return { output_paths: [] };
      },
    };
    runner.registerHandler(h);
    expect(() => runner.registerHandler(h)).toThrow(/already registered/);
  });

  it("submit rejects without a registered handler", async () => {
    await expect(runner.submit({ kind: "nope", params: {} }, "tester")).rejects.toThrow(
      /no handler registered/,
    );
  });

  it("validates params via the handler's validate hook", async () => {
    runner.registerHandler({
      kind: "vk",
      validate(p) {
        const errs: string[] = [];
        if ((p as { x?: unknown })?.x !== "ok") errs.push("x must be 'ok'");
        return errs;
      },
      async run() {
        return { output_paths: [] };
      },
    });
    await expect(runner.submit({ kind: "vk", params: { x: "bad" } }, "tester")).rejects.toThrow(
      /x must be 'ok'/,
    );
  });

  it("runs a job to completion and records output_paths", async () => {
    runner.registerHandler({
      kind: "ok",
      async run() {
        return { output_paths: ["s3://bucket/a", "s3://bucket/b"] };
      },
    });
    const { job_id } = await runner.submit({ kind: "ok", params: {} }, "tester");
    await waitForStatus(runner, job_id, "completed");
    const job = (await runner.status(job_id))!;
    expect(job.status).toBe("completed");
    expect(job.output_paths).toEqual(["s3://bucket/a", "s3://bucket/b"]);
    expect(job.error).toBeNull();
    expect(job.completed_at).toBeTruthy();
  });

  it("records errors on handler failure", async () => {
    runner.registerHandler({
      kind: "boom",
      async run() {
        throw new Error("kaboom");
      },
    });
    const { job_id } = await runner.submit({ kind: "boom", params: {} }, "tester");
    await waitForStatus(runner, job_id, "failed");
    const job = (await runner.status(job_id))!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("kaboom");
  });

  it("dedupes identical submissions while the original is queued/running", async () => {
    const gate = deferred<void>();
    runner.registerHandler({
      kind: "slow",
      async run() {
        await gate.promise;
        return { output_paths: [] };
      },
    });
    const first = await runner.submit({ kind: "slow", params: { x: 1 } }, "tester");
    expect(first.deduped).toBe(false);
    // While the first is running, a duplicate submit returns the same job_id.
    await waitForStatus(runner, first.job_id, "running");
    const second = await runner.submit({ kind: "slow", params: { x: 1 } }, "tester2");
    expect(second.deduped).toBe(true);
    expect(second.job_id).toBe(first.job_id);
    // Different params produce a fresh job (different idempotency key) but
    // queue behind the in-flight one (same kind → single-flight).
    const other = await runner.submit({ kind: "slow", params: { x: 2 } }, "tester");
    expect(other.deduped).toBe(false);
    expect(other.job_id).not.toBe(first.job_id);

    gate.resolve();
    await waitForStatus(runner, first.job_id, "completed");
    await waitForStatus(runner, other.job_id, "completed");
  });

  it("serializes per-kind execution (single-flight)", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    runner.registerHandler({
      kind: "serial",
      async run(params) {
        order.push(`start:${(params as { tag: string }).tag}`);
        await new Promise<void>((resolve) => releases.push(resolve));
        order.push(`done:${(params as { tag: string }).tag}`);
        return { output_paths: [] };
      },
    });
    const a = await runner.submit({ kind: "serial", params: { tag: "a" } }, "t");
    const b = await runner.submit({ kind: "serial", params: { tag: "b" } }, "t");
    await waitForStatus(runner, a.job_id, "running");
    // b is still queued because the kind is locked.
    const bJob = (await runner.status(b.job_id))!;
    expect(bJob.status).toBe("queued");
    releases[0]!();
    await waitForStatus(runner, a.job_id, "completed");
    await waitForStatus(runner, b.job_id, "running");
    releases[1]!();
    await waitForStatus(runner, b.job_id, "completed");
    expect(order).toEqual(["start:a", "done:a", "start:b", "done:b"]);
  });

  it("different kinds run in parallel", async () => {
    let startedB = false;
    const aGate = deferred<void>();
    runner.registerHandler({
      kind: "a",
      async run() {
        await aGate.promise;
        return { output_paths: [] };
      },
    });
    runner.registerHandler({
      kind: "b",
      async run() {
        startedB = true;
        return { output_paths: [] };
      },
    });
    const a = await runner.submit({ kind: "a", params: {} }, "t");
    const b = await runner.submit({ kind: "b", params: {} }, "t");
    await waitForStatus(runner, a.job_id, "running");
    await waitForStatus(runner, b.job_id, "completed");
    expect(startedB).toBe(true);
    aGate.resolve();
    await waitForStatus(runner, a.job_id, "completed");
  });

  it("reports progress through the sink", async () => {
    runner.registerHandler({
      kind: "prog",
      async run(_params, progress) {
        progress(1, 3);
        progress(2, 3);
        progress(3, 3, "done");
        return { output_paths: [] };
      },
    });
    const { job_id } = await runner.submit({ kind: "prog", params: {} }, "t");
    await waitForStatus(runner, job_id, "completed");
    const job = (await runner.status(job_id))!;
    expect(job.progress).toBe(3);
    expect(job.total).toBe(3);
  });

  it("recovers orphan running jobs as failed", async () => {
    runner.registerHandler({
      kind: "stuck",
      async run() {
        // Never resolves — but we won't await it.
        return new Promise<{ output_paths: string[] }>(() => {});
      },
    });
    const { job_id } = await runner.submit({ kind: "stuck", params: {} }, "t");
    await waitForStatus(runner, job_id, "running");
    // Simulate a fresh process boot.
    const recovered = await runner.recoverOrphans("test restart");
    expect(recovered).toBe(1);
    const job = (await runner.status(job_id))!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("test restart");
  });

  it("computeIdempotencyKey is stable + ignores key order", () => {
    const a = computeIdempotencyKey("k", { x: 1, y: 2 });
    const b = computeIdempotencyKey("k", { y: 2, x: 1 });
    const c = computeIdempotencyKey("k", { x: 2, y: 2 });
    const d = computeIdempotencyKey("other", { x: 1, y: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});
