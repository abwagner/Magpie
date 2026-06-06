// QF-328 — drift-detector: module entrypoint + alert budget helper.
//
// Covers:
//   - queryAlertBudgetExceeded: returns false when no alerts exist
//   - queryAlertBudgetExceeded: returns true after an alert row is inserted
//   - startDriftDetector: returns a handle with the expected shape
//   - DriftDetectorHandle.budgetExceeded: delegates to queryAlertBudgetExceeded
//   - DriftDetectorHandle.recordAlert: inserts a row + budget becomes true
//   - DriftDetectorHandle.stop: logs and returns without error

import { describe, it, expect, vi } from "vitest";
import {
  queryAlertBudgetExceeded,
  startDriftDetector,
  type DriftDetectorHandle,
} from "../../drift-detector.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type { DriftAlert } from "../../../../src/types/drift.js";

// ── Minimal DuckDB stub ───────────────────────────────────────────────
//
// We avoid a real DuckDB instance in unit tests — the DB layer is
// exercised in integration tests. The stub records calls and lets each
// test control the return value.
//
// DuckDB uses spread params: db.all(sql, p1, p2, ..., callback).
// The last argument is always the callback; the stub pulls it from
// the rest params array and invokes it synchronously.

interface StubDb {
  _allRows: Array<Record<string, unknown>>;
  _allError: Error | null;
  _runError: Error | null;
  all(...args: unknown[]): void;
  run(...args: unknown[]): void;
}

function makeStubDb(): StubDb {
  return {
    _allRows: [],
    _allError: null,
    _runError: null,
    all(...args) {
      const cb = args[args.length - 1] as (
        err: Error | null,
        rows: Array<Record<string, unknown>>,
      ) => void;
      cb(this._allError, this._allRows);
    },
    run(...args) {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(this._runError);
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<DriftAlert> = {}): DriftAlert {
  return {
    alert_type: "drift_slow_distribution",
    strategy_id: "strat-1",
    portfolio_id: "port-a",
    metric: "hit_rate",
    observed: { ci_lower: 0.3, ci_upper: 0.45 },
    spec_range: [0.5, 0.9],
    baseline_source: "spec",
    sample_size: 35,
    asof: "2026-06-01T12:00:00Z",
    correlation_id: "01HZ000000000000000000000A",
    ...overrides,
  };
}

// ── queryAlertBudgetExceeded ──────────────────────────────────────────

describe("queryAlertBudgetExceeded", () => {
  it("returns false when no rows exist for the pair", async () => {
    const db = makeStubDb();
    db._allRows = [{ cnt: 0 }];
    const result = await queryAlertBudgetExceeded(
      db as unknown as import("duckdb").Database,
      "strat-1",
      "hit_rate",
      "2026-06-01",
    );
    expect(result).toBe(false);
  });

  it("returns true when at least one row exists for the pair", async () => {
    const db = makeStubDb();
    db._allRows = [{ cnt: 1 }];
    const result = await queryAlertBudgetExceeded(
      db as unknown as import("duckdb").Database,
      "strat-1",
      "hit_rate",
      "2026-06-01",
    );
    expect(result).toBe(true);
  });

  it("returns true for counts greater than 1 (shouldn't happen in practice, but is safe)", async () => {
    const db = makeStubDb();
    db._allRows = [{ cnt: 3 }];
    const result = await queryAlertBudgetExceeded(
      db as unknown as import("duckdb").Database,
      "strat-2",
      "realized_pnl",
      "2026-06-01",
    );
    expect(result).toBe(true);
  });

  it("returns false when rows array is empty (no cnt field)", async () => {
    const db = makeStubDb();
    db._allRows = [];
    const result = await queryAlertBudgetExceeded(
      db as unknown as import("duckdb").Database,
      "strat-1",
      "slippage",
      "2026-06-01",
    );
    expect(result).toBe(false);
  });

  it("rejects when the DB query errors", async () => {
    const db = makeStubDb();
    db._allError = new Error("duckdb gone");
    await expect(
      queryAlertBudgetExceeded(
        db as unknown as import("duckdb").Database,
        "strat-1",
        "hit_rate",
        "2026-06-01",
      ),
    ).rejects.toThrow("duckdb gone");
  });
});

// ── startDriftDetector ────────────────────────────────────────────────

describe("startDriftDetector", () => {
  it("logs drift-detector.started on creation", () => {
    const db = makeStubDb();
    const logger = createTestLogger("test");
    startDriftDetector({ db: db as unknown as import("duckdb").Database, logger });
    expect(logger.logs).toContainEqual(
      expect.objectContaining({ level: "info", msg: "drift-detector.started" }),
    );
  });

  it("returns a handle with the expected methods", () => {
    const db = makeStubDb();
    const handle: DriftDetectorHandle = startDriftDetector({
      db: db as unknown as import("duckdb").Database,
      logger: createTestLogger("test"),
    });
    expect(typeof handle.recordAlert).toBe("function");
    expect(typeof handle.budgetExceeded).toBe("function");
    expect(typeof handle.stop).toBe("function");
  });

  it("stop() logs drift-detector.stopped without throwing", () => {
    const db = makeStubDb();
    const logger = createTestLogger("test");
    const handle = startDriftDetector({
      db: db as unknown as import("duckdb").Database,
      logger,
    });
    expect(() => handle.stop()).not.toThrow();
    expect(logger.logs).toContainEqual(
      expect.objectContaining({ level: "info", msg: "drift-detector.stopped" }),
    );
  });

  it("budgetExceeded() delegates to queryAlertBudgetExceeded (no rows → false)", async () => {
    const db = makeStubDb();
    db._allRows = [{ cnt: 0 }];
    const handle = startDriftDetector({
      db: db as unknown as import("duckdb").Database,
      logger: createTestLogger("test"),
    });
    const exceeded = await handle.budgetExceeded("strat-1", "hit_rate", "2026-06-01");
    expect(exceeded).toBe(false);
  });

  it("budgetExceeded() delegates to queryAlertBudgetExceeded (row present → true)", async () => {
    const db = makeStubDb();
    db._allRows = [{ cnt: 1 }];
    const handle = startDriftDetector({
      db: db as unknown as import("duckdb").Database,
      logger: createTestLogger("test"),
    });
    const exceeded = await handle.budgetExceeded("strat-1", "realized_pnl", "2026-06-01");
    expect(exceeded).toBe(true);
  });

  it("recordAlert() calls db.run with the INSERT statement", async () => {
    const db = makeStubDb();
    const runSpy = vi.spyOn(db, "run");
    const handle = startDriftDetector({
      db: db as unknown as import("duckdb").Database,
      logger: createTestLogger("test"),
    });

    const alert = makeAlert();
    await handle.recordAlert(alert);

    // run() should have been called with the INSERT
    expect(runSpy).toHaveBeenCalledOnce();
    const args = runSpy.mock.calls[0] as unknown[];
    const sql = args[0] as string;
    expect(sql).toContain("INSERT INTO drift_alerts");

    // Spot-check a few positional spread params (after sql).
    // Params: id(1), alert_type(2), strategy_id(3), portfolio_id(4), metric(5),
    //         observed_json(6), spec_range_json(7), baseline_source(8),
    //         sample_size(9), fired_at(10), fired_date_utc(11), correlation_id(12),
    //         callback(13).
    expect(args[2]).toBe("drift_slow_distribution"); // alert_type
    expect(args[3]).toBe("strat-1"); // strategy_id
    expect(args[4]).toBe("port-a"); // portfolio_id
    expect(args[5]).toBe("hit_rate"); // metric
    expect(args[8]).toBe("spec"); // baseline_source
    expect(args[9]).toBe(35); // sample_size
  });

  it("recordAlert() logs alert.recorded", async () => {
    const db = makeStubDb();
    const logger = createTestLogger("test");
    const handle = startDriftDetector({
      db: db as unknown as import("duckdb").Database,
      logger,
    });

    await handle.recordAlert(makeAlert());

    expect(logger.logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "drift-detector.alert.recorded",
        fields: expect.objectContaining({ strategy_id: "strat-1", metric: "hit_rate" }),
      }),
    );
  });

  it("recordAlert() rejects when the DB INSERT errors", async () => {
    const db = makeStubDb();
    db._runError = new Error("insert failed");
    const handle = startDriftDetector({
      db: db as unknown as import("duckdb").Database,
      logger: createTestLogger("test"),
    });
    await expect(handle.recordAlert(makeAlert())).rejects.toThrow("insert failed");
  });
});
