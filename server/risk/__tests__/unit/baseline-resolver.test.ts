// QF-331 — drift-detector: baseline-resolver (spec → qo_pinned → computed_historical)
//
// Tests the three-tier baseline fallback and the hasInsufficientHistory helper.
//
// Covers:
//   Tier 1 (spec):
//     - returns BaselineRange { source:"spec" } when metricSpec.range is set
//     - never touches DB when spec range is available
//   Tier 2 (qo_pinned):
//     - returns BaselineRange { source:"qo_pinned" } for a metric in the archive
//     - returns null (falls through) when archive has no data for the metric
//     - falls through to tier 3 when fetchWfoJson returns null
//   Tier 3 (computed_historical):
//     - returns BaselineRange { source:"computed_historical" } for realized_pnl
//     - returns null when fewer than 90 live days
//     - returns null when queries return empty (insufficient data)
//   hasInsufficientHistory:
//     - returns true when live days < 90
//     - returns false when live days >= 90

import { describe, it, expect, vi } from "vitest";
import {
  resolveBaseline,
  hasInsufficientHistory,
  COMPUTED_HISTORICAL_MIN_DAYS,
} from "../../baseline-resolver.js";
import type { DriftSpec } from "../../../../src/types/drift.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type { Database } from "duckdb";

// ── DB stub helpers ───────────────────────────────────────────────

/**
 * Build a minimal Database stub.
 * `queryResults` is a map from query keyword → rows to return.
 * If the SQL contains the keyword the matching rows are returned.
 * Defaults to [] when no keyword matches.
 */
function makeDbStub(
  queryResults: Array<{ keyword: string; rows: Record<string, unknown>[] }> = [],
): Database {
  return {
    all(sql: string, ...args: unknown[]) {
      const cb = args[args.length - 1] as (
        err: Error | null,
        rows: Record<string, unknown>[],
      ) => void;
      const match = queryResults.find((q) => (sql as string).includes(q.keyword));
      cb(null, match?.rows ?? []);
    },
    run(...args: unknown[]) {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(null);
    },
  } as unknown as Database;
}

/** DB stub that returns a specific number of distinct live days. */
function makeDbWithLiveDays(liveDays: number): Database {
  return makeDbStub([
    {
      keyword: "COUNT(DISTINCT",
      rows: [{ day_count: liveDays }],
    },
  ]);
}

/** DB stub that returns enough daily P&L rows for computed-historical. */
function makeDbWithPnl(pnlValues: number[], liveDays = 95): Database {
  const pnlRows = pnlValues.map((v) => ({ pnl: v }));
  return {
    all(sql: string, ...args: unknown[]) {
      const cb = args[args.length - 1] as (err: Error | null, rows: unknown[]) => void;
      if ((sql as string).includes("COUNT(DISTINCT")) {
        cb(null, [{ day_count: liveDays }]);
      } else if ((sql as string).includes("SUM(pnl)")) {
        cb(null, pnlRows);
      } else {
        cb(null, []);
      }
    },
    run(...args: unknown[]) {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(null);
    },
  } as unknown as Database;
}

// ── Tier 1: spec range tests ──────────────────────────────────────

describe("resolveBaseline — Tier 1 (spec)", () => {
  it("returns source:spec when metricSpec.range is set", async () => {
    const db = makeDbStub(); // should never be called
    const logger = createTestLogger("test");
    const allCalls = vi.spyOn(db, "all");

    const result = await resolveBaseline(
      "strat-1",
      "realized_pnl",
      {} as DriftSpec,
      { range: [0.1, 0.3] },
      { db, logger },
    );

    expect(result).not.toBeNull();
    expect(result!.source).toBe("spec");
    expect(result!.range).toEqual([0.1, 0.3]);
    expect(allCalls).not.toHaveBeenCalled();
  });

  it("returns the exact range from the spec unchanged", async () => {
    const db = makeDbStub();
    const logger = createTestLogger("test");
    const specRange = [0.5, 0.9] as [number, number];

    const result = await resolveBaseline(
      "strat-1",
      "hit_rate",
      {} as DriftSpec,
      { range: specRange },
      { db, logger },
    );

    expect(result!.range).toEqual([0.5, 0.9]);
  });

  it("handles floor spec range", async () => {
    const db = makeDbStub();
    const logger = createTestLogger("test");

    const result = await resolveBaseline(
      "strat-1",
      "hit_rate",
      {} as DriftSpec,
      { range: { floor: 0.5 } },
      { db, logger },
    );

    expect(result!.source).toBe("spec");
    expect(result!.range).toEqual({ floor: 0.5 });
  });

  it("handles ceiling spec range", async () => {
    const db = makeDbStub();
    const logger = createTestLogger("test");

    const result = await resolveBaseline(
      "strat-1",
      "slippage",
      {} as DriftSpec,
      { range: { ceiling: 0.05 } },
      { db, logger },
    );

    expect(result!.source).toBe("spec");
    expect(result!.range).toEqual({ ceiling: 0.05 });
  });
});

// ── Tier 2: qo_pinned tests ───────────────────────────────────────
//
// These tests use a file:// archive URL to avoid needing S3.

describe("resolveBaseline — Tier 2 (qo_pinned)", () => {
  it("returns source:qo_pinned when archive has data for the metric", async () => {
    const db = makeDbWithLiveDays(0); // tier 2 must not need DB
    const logger = createTestLogger("test");

    // Write a tmp fixture wfo_results file for the test.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), "qf-331-test");
    mkdirSync(dir, { recursive: true });
    const archivePath = join(dir, "wfo_results_test.json");
    writeFileSync(
      archivePath,
      JSON.stringify({
        schema_version: 1,
        strategy: "test-strategy",
        folds: [
          { fold_id: 0, oos: { net_pnl: 1000, hit_rate: 0.6 } },
          { fold_id: 1, oos: { net_pnl: 1200, hit_rate: 0.65 } },
          { fold_id: 2, oos: { net_pnl: 800, hit_rate: 0.55 } },
        ],
      }),
    );

    const driftSpec: DriftSpec = { baseline_qo_run: `file://${archivePath}` };

    const result = await resolveBaseline("strat-1", "realized_pnl", driftSpec, undefined, {
      db,
      logger,
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("qo_pinned");
    // Range should be [mean - σ, mean + σ] of [1000, 1200, 800].
    // mean = 1000, σ = ~200 (approx).
    const range = result!.range as [number, number];
    expect(Array.isArray(range)).toBe(true);
    expect(range[0]).toBeLessThan(range[1]);
  });

  it("returns qo_pinned for hit_rate metric from archive", async () => {
    const db = makeDbWithLiveDays(0);
    const logger = createTestLogger("test");

    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), "qf-331-test");
    mkdirSync(dir, { recursive: true });
    const archivePath = join(dir, "wfo_results_hit_rate.json");
    writeFileSync(
      archivePath,
      JSON.stringify({
        folds: [
          { fold_id: 0, oos: { hit_rate: 0.6 } },
          { fold_id: 1, oos: { hit_rate: 0.7 } },
          { fold_id: 2, oos: { hit_rate: 0.65 } },
        ],
      }),
    );

    const driftSpec: DriftSpec = { baseline_qo_run: `file://${archivePath}` };

    const result = await resolveBaseline("strat-1", "hit_rate", driftSpec, undefined, {
      db,
      logger,
    });

    expect(result!.source).toBe("qo_pinned");
  });

  it("falls through to tier 3 when archive has no data for the metric", async () => {
    // slippage is not in METRIC_TO_OOS_KEY so it has no QO mapping.
    // With insufficient history the fallthrough should return null.
    const db = makeDbWithLiveDays(10); // insufficient history for tier 3
    const logger = createTestLogger("test");

    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), "qf-331-test");
    mkdirSync(dir, { recursive: true });
    const archivePath = join(dir, "wfo_results_no_slippage.json");
    writeFileSync(
      archivePath,
      JSON.stringify({
        folds: [
          { fold_id: 0, oos: { net_pnl: 500 } },
          { fold_id: 1, oos: { net_pnl: 600 } },
        ],
      }),
    );

    const driftSpec: DriftSpec = { baseline_qo_run: `file://${archivePath}` };

    const result = await resolveBaseline("strat-1", "slippage", driftSpec, undefined, {
      db,
      logger,
    });

    // slippage not in archive and insufficient history → null.
    expect(result).toBeNull();
  });

  it("falls through to tier 3 when archive file does not exist", async () => {
    const db = makeDbWithLiveDays(10); // insufficient history for tier 3
    const logger = createTestLogger("test");

    const driftSpec: DriftSpec = {
      baseline_qo_run: "file:///nonexistent/path/wfo_results.json",
    };

    const result = await resolveBaseline("strat-1", "realized_pnl", driftSpec, undefined, {
      db,
      logger,
    });

    // Archive missing + insufficient history → null.
    expect(result).toBeNull();
    // A warning should be logged.
    expect(logger.logs).toContainEqual(expect.objectContaining({ level: "warn" }));
  });
});

// ── Tier 3: computed_historical tests ─────────────────────────────

describe("resolveBaseline — Tier 3 (computed_historical)", () => {
  it("returns source:computed_historical for realized_pnl with enough data", async () => {
    const pnlValues = [100, 200, 150, 180, 130, 110, 90, 160, 170, 200];
    const db = makeDbWithPnl(pnlValues, 95);
    const logger = createTestLogger("test");

    const result = await resolveBaseline("strat-1", "realized_pnl", {} as DriftSpec, undefined, {
      db,
      logger,
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("computed_historical");
    expect(result!.computed_window_days).toBe(90);
    const range = result!.range as [number, number];
    expect(Array.isArray(range)).toBe(true);
    expect(range[0]).toBeLessThan(range[1]);
  });

  it("returns null when fewer than 90 live days", async () => {
    const db = makeDbWithLiveDays(30);
    const logger = createTestLogger("test");

    const result = await resolveBaseline("strat-1", "realized_pnl", {} as DriftSpec, undefined, {
      db,
      logger,
    });

    expect(result).toBeNull();
  });

  it("returns null when P&L query returns only one value (σ undefined)", async () => {
    const db = makeDbWithPnl([100], 95); // single value → stdDev NaN
    const logger = createTestLogger("test");

    const result = await resolveBaseline("strat-1", "realized_pnl", {} as DriftSpec, undefined, {
      db,
      logger,
    });

    // Single value can't produce a stable range.
    expect(result).toBeNull();
  });

  it("respects custom windowDays opt", async () => {
    const pnlValues = [50, 60, 55, 58, 52, 61, 57, 54, 59, 53];
    const db = makeDbWithPnl(pnlValues, 35);
    const logger = createTestLogger("test");

    const result = await resolveBaseline(
      "strat-1",
      "realized_pnl",
      {} as DriftSpec,
      undefined,
      { db, logger },
      { windowDays: 30 },
    );

    expect(result).not.toBeNull();
    expect(result!.computed_window_days).toBe(30);
  });

  it("returns computed_historical for realized_vol with enough data", async () => {
    const pnlValues = [50, 60, 45, 70, 55, 65, 48, 72, 58, 62, 53, 67, 51];
    const db = makeDbWithPnl(pnlValues, 95);
    const logger = createTestLogger("test");

    const result = await resolveBaseline("strat-1", "realized_vol", {} as DriftSpec, undefined, {
      db,
      logger,
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("computed_historical");
    const range = result!.range as [number, number];
    expect(Array.isArray(range)).toBe(true);
    // vol range: [0.5*vol, 1.5*vol] — both must be positive.
    expect(range[0]).toBeGreaterThan(0);
    expect(range[1]).toBeGreaterThan(range[0]);
  });
});

// ── hasInsufficientHistory ────────────────────────────────────────

describe("hasInsufficientHistory", () => {
  it("returns true when live days < 90", async () => {
    const db = makeDbWithLiveDays(45);
    const result = await hasInsufficientHistory("strat-1", db);
    expect(result).toBe(true);
  });

  it("returns false when live days >= 90", async () => {
    const db = makeDbWithLiveDays(90);
    const result = await hasInsufficientHistory("strat-1", db);
    expect(result).toBe(false);
  });

  it("returns false when live days > 90", async () => {
    const db = makeDbWithLiveDays(150);
    const result = await hasInsufficientHistory("strat-1", db);
    expect(result).toBe(false);
  });

  it("returns true when DB errors (conservative fallback)", async () => {
    const db: Database = {
      all(...args: unknown[]) {
        const cb = args[args.length - 1] as (err: Error | null, rows: unknown) => void;
        cb(new Error("db connection failed"), null);
      },
      run(...args: unknown[]) {
        const cb = args[args.length - 1] as (err: Error | null) => void;
        cb(null);
      },
    } as unknown as Database;

    const result = await hasInsufficientHistory("strat-1", db);
    expect(result).toBe(true);
  });

  it("exports COMPUTED_HISTORICAL_MIN_DAYS = 90", () => {
    expect(COMPUTED_HISTORICAL_MIN_DAYS).toBe(90);
  });
});
