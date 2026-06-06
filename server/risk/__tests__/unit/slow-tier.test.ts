// QF-330 — drift-detector: slow-tier (60s timer + statistical CI + n_min + alert budget)
//
// Covers:
//   Statistical helpers:
//     - mean: correct result, NaN on empty
//     - stdDev: correct sample SD, NaN when n < 2
//     - ciHalfWidth: correct 1.96*σ/√n, NaN when n < 2
//     - meanCI: correct CI bounds, null on empty / singleton
//     - ciOutsideSpecRange: interval/floor/ceiling for inside, above, below
//   n_min gate (§3.1):
//     - metric skipped when n < n_min
//     - metric evaluated when n >= n_min
//   CI overlap (§3.2):
//     - no alert when CI overlaps spec range
//     - alert fires when CI is fully outside spec range
//   Alert budget (§3.3):
//     - second trip on same (strategy, metric, day) is suppressed
//   Hard-drift trip behavior:
//     - alert always recorded on trip
//     - envelopes revoked when metric is halt_eligible
//     - envelopes NOT revoked when metric is not halt_eligible
//     - no revoke when no pending envelopes

import { describe, it, expect, vi } from "vitest";
import {
  mean,
  stdDev,
  ciHalfWidth,
  meanCI,
  ciOutsideSpecRange,
  startSlowTier,
  type SlowTierStrategy,
  type SlowTierHandle,
} from "../../slow-tier.js";
import type { DriftSpec } from "../../../../src/types/drift.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type { DriftDetectorHandle } from "../../drift-detector.js";
import type { PendingIntentsStore, PendingIntent } from "../../pending-intents.js";
import type { EnvelopeRevoker, RevokeResponse } from "../../envelope-revoker.js";
import type { Database } from "duckdb";

// ── Statistical helper tests ──────────────────────────────────────

describe("mean", () => {
  it("returns correct mean for a non-empty array", () => {
    expect(mean([1, 2, 3, 4, 5])).toBeCloseTo(3);
  });

  it("returns NaN for an empty array", () => {
    expect(mean([])).toBeNaN();
  });

  it("returns the single value for a singleton array", () => {
    expect(mean([42])).toBe(42);
  });
});

describe("stdDev", () => {
  it("computes sample standard deviation correctly (ddof=1)", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → sample σ (ddof=1) ≈ 2.138
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138);
  });

  it("returns NaN for empty array", () => {
    expect(stdDev([])).toBeNaN();
  });

  it("returns NaN for singleton array (ddof=1 undefined)", () => {
    expect(stdDev([5])).toBeNaN();
  });

  it("returns 0 for a constant array", () => {
    expect(stdDev([3, 3, 3, 3])).toBeCloseTo(0);
  });
});

describe("ciHalfWidth", () => {
  it("returns 1.96 * σ / √n", () => {
    // σ=2, n=100 → 1.96 * 2 / 10 = 0.392
    expect(ciHalfWidth(2, 100)).toBeCloseTo(0.392);
  });

  it("returns NaN when n < 2", () => {
    expect(ciHalfWidth(1, 1)).toBeNaN();
    expect(ciHalfWidth(1, 0)).toBeNaN();
  });
});

describe("meanCI", () => {
  it("returns correct CI bounds for a sample", () => {
    // values [10, 10, 10, 10] → mean=10, stdDev=0 → CI = [10, 10]
    const ci = meanCI([10, 10, 10, 10]);
    expect(ci).not.toBeNull();
    expect(ci!.ci_lower).toBeCloseTo(10);
    expect(ci!.ci_upper).toBeCloseTo(10);
  });

  it("returns null for empty array", () => {
    expect(meanCI([])).toBeNull();
  });

  it("returns null for singleton (ciHalfWidth NaN)", () => {
    expect(meanCI([5])).toBeNull();
  });

  it("CI lower < CI upper for variable data", () => {
    const ci = meanCI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ci).not.toBeNull();
    expect(ci!.ci_lower).toBeLessThan(ci!.ci_upper);
  });
});

describe("ciOutsideSpecRange", () => {
  describe("[lo, hi] two-sided interval", () => {
    it("returns false when CI fully inside spec range", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.4, ci_upper: 0.6 }, [0.3, 0.7])).toBe(false);
    });

    it("returns false when CI partially overlaps from below", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.1, ci_upper: 0.4 }, [0.3, 0.7])).toBe(false);
    });

    it("returns false when CI partially overlaps from above", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.6, ci_upper: 0.9 }, [0.3, 0.7])).toBe(false);
    });

    it("returns true when CI is fully below spec range", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.1, ci_upper: 0.25 }, [0.3, 0.7])).toBe(true);
    });

    it("returns true when CI is fully above spec range", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.8, ci_upper: 0.95 }, [0.3, 0.7])).toBe(true);
    });
  });

  describe("{ floor } one-sided", () => {
    it("returns false when CI upper is above floor", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.3, ci_upper: 0.55 }, { floor: 0.5 })).toBe(false);
    });

    it("returns true when CI upper is below floor", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.2, ci_upper: 0.45 }, { floor: 0.5 })).toBe(true);
    });

    it("returns false when CI upper equals floor exactly", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.3, ci_upper: 0.5 }, { floor: 0.5 })).toBe(false);
    });
  });

  describe("{ ceiling } one-sided", () => {
    it("returns false when CI lower is below ceiling", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.3, ci_upper: 0.7 }, { ceiling: 0.8 })).toBe(false);
    });

    it("returns true when CI lower is above ceiling", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.9, ci_upper: 1.1 }, { ceiling: 0.8 })).toBe(true);
    });

    it("returns false when CI lower equals ceiling exactly", () => {
      expect(ciOutsideSpecRange({ ci_lower: 0.8, ci_upper: 1.0 }, { ceiling: 0.8 })).toBe(false);
    });
  });
});

// ── Stubs ─────────────────────────────────────────────────────────

/** Build a minimal DB stub that returns canned rows for db.all(). */
function makeDbStub(rows: Record<string, unknown>[]): Database {
  return {
    all(...args: unknown[]) {
      const cb = args[args.length - 1] as (
        err: Error | null,
        rows: Record<string, unknown>[],
      ) => void;
      cb(null, rows);
    },
    run(...args: unknown[]) {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(null);
    },
  } as unknown as Database;
}

/** Build a DriftDetectorHandle stub. */
function makeDetectorStub(budgetResult = false): {
  handle: DriftDetectorHandle;
  alerts: Parameters<DriftDetectorHandle["recordAlert"]>[0][];
} {
  const alerts: Parameters<DriftDetectorHandle["recordAlert"]>[0][] = [];
  const handle: DriftDetectorHandle = {
    async recordAlert(alert) {
      alerts.push(alert);
    },
    async budgetExceeded(_strategyId, _metric, _todayUtc) {
      return budgetResult;
    },
    stop() {},
  };
  return { handle, alerts };
}

/** Build a PendingIntentsStore stub. */
function makePendingIntentsStub(activeForStrategy: PendingIntent[] = []): {
  store: PendingIntentsStore;
  revoked: string[];
} {
  const revoked: string[] = [];
  const store: PendingIntentsStore = {
    add: vi.fn(),
    has: vi.fn(),
    get: vi.fn(),
    markPartialFill: vi.fn(),
    markFilled: vi.fn(),
    markCancelled: vi.fn(),
    markRejected: vi.fn(),
    markEnvelopeRevoked(_id, _ts) {
      revoked.push(_id);
    },
    getActive: vi.fn().mockReturnValue(activeForStrategy),
    getActiveForStrategy: vi.fn().mockReturnValue(activeForStrategy),
    getActiveForPortfolio: vi.fn().mockReturnValue([]),
    sweep: vi.fn().mockReturnValue(0),
    size: vi.fn().mockReturnValue(0),
  };
  return { store, revoked };
}

/** Build an EnvelopeRevoker stub. */
function makeRevokerStub(result: RevokeResponse = { status: "revoked" }): {
  revoker: EnvelopeRevoker;
  calls: Array<{ envelopeId: string; reason: string }>;
} {
  const calls: Array<{ envelopeId: string; reason: string }> = [];
  const revoker: EnvelopeRevoker = {
    async revokeEnvelope(envelopeId, reason) {
      calls.push({ envelopeId, reason });
      return result;
    },
  };
  return { revoker, calls };
}

/** Minimal strategy that will produce a hit_rate trip when DB returns 35 profitable of 35 total. */
function makeStrategy(overrides: Partial<SlowTierStrategy> = {}): SlowTierStrategy {
  return {
    id: "strat-1",
    portfolio_id: "port-a",
    broker: "schwab",
    drift: {
      hit_rate: {
        range: [0.5, 0.9],
        n_min: 30,
      },
    },
    ...overrides,
  };
}

/**
 * Build a DB stub that returns enough data to produce a hit_rate trip.
 * hit_rate query returns total=35, profitable=5 (rate=0.143 — well below floor=0.5).
 * All other metric queries return empty to keep the test focused.
 */
function makeTrippingDbStub(): Database {
  let callCount = 0;
  return {
    all(...args: unknown[]) {
      const cb = args[args.length - 1] as (
        err: Error | null,
        rows: Record<string, unknown>[],
      ) => void;
      callCount += 1;
      // Query order from computeMetrics:
      //   1. realized_pnl (daily P&L)
      //   2. hit_rate
      //   3. slippage
      //   4. signal_fill_latency
      // The realized_vol uses pnl values from query 1.
      if (callCount === 1) {
        // realized_pnl: return empty so only hit_rate fires
        cb(null, []);
      } else if (callCount === 2) {
        // hit_rate: 35 total, 5 profitable → rate=0.143 (below floor=0.5)
        cb(null, [{ total: 35, profitable: 5 }]);
      } else {
        // slippage, latency: empty
        cb(null, []);
      }
    },
    run(...args: unknown[]) {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(null);
    },
  } as unknown as Database;
}

// ── slow-tier integration tests ────────────────────────────────────

describe("startSlowTier / tick()", () => {
  it("does not fire alert when n < n_min", async () => {
    // hit_rate returns only 10 total fills — below n_min=30.
    let callCount = 0;
    const db: Database = {
      all(...args: unknown[]) {
        const cb = args[args.length - 1] as (err: Error | null, rows: unknown[]) => void;
        callCount += 1;
        if (callCount === 2) {
          cb(null, [{ total: 10, profitable: 2 }]);
        } else {
          cb(null, []);
        }
      },
      run(...args: unknown[]) {
        const cb = args[args.length - 1] as (err: Error | null) => void;
        cb(null);
      },
    } as unknown as Database;

    const { handle: detector, alerts } = makeDetectorStub(false);
    const { store: pendingIntents } = makePendingIntentsStub();
    const logger = createTestLogger("test");

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map(),
      strategies: () => [makeStrategy()],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(alerts).toHaveLength(0);
  });

  it("does not fire alert when CI overlaps spec range", async () => {
    // hit_rate = 35/50 = 0.70 with n=50 → CI spans [0.5x, 0.8x] — inside [0.5, 0.9]
    let callCount = 0;
    const db: Database = {
      all(...args: unknown[]) {
        const cb = args[args.length - 1] as (err: Error | null, rows: unknown[]) => void;
        callCount += 1;
        if (callCount === 2) {
          cb(null, [{ total: 50, profitable: 35 }]);
        } else {
          cb(null, []);
        }
      },
      run(...args: unknown[]) {
        const cb = args[args.length - 1] as (err: Error | null) => void;
        cb(null);
      },
    } as unknown as Database;

    const { handle: detector, alerts } = makeDetectorStub(false);
    const { store: pendingIntents } = makePendingIntentsStub();
    const logger = createTestLogger("test");

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map(),
      strategies: () => [makeStrategy()],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(alerts).toHaveLength(0);
  });

  it("fires alert when CI is fully outside spec range", async () => {
    const db = makeTrippingDbStub();
    const { handle: detector, alerts } = makeDetectorStub(false);
    const { store: pendingIntents } = makePendingIntentsStub();
    const logger = createTestLogger("test");

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map(),
      strategies: () => [makeStrategy()],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: "drift_slow_distribution",
      strategy_id: "strat-1",
      portfolio_id: "port-a",
      metric: "hit_rate",
      baseline_source: "spec",
    });
    expect(alerts[0]?.sample_size).toBe(35);
  });

  it("suppresses alert when alert budget is exhausted (§3.3)", async () => {
    const db = makeTrippingDbStub();
    // budgetExceeded returns true → should suppress
    const { handle: detector, alerts } = makeDetectorStub(true);
    const { store: pendingIntents } = makePendingIntentsStub();
    const logger = createTestLogger("test");

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map(),
      strategies: () => [makeStrategy()],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(alerts).toHaveLength(0);
  });

  it("does not revoke envelopes when metric is NOT halt_eligible", async () => {
    const db = makeTrippingDbStub();
    const { handle: detector } = makeDetectorStub(false);

    const envelope: PendingIntent = {
      intent_id: "intent-1",
      strategy_id: "strat-1",
      portfolio_id: "port-a",
      broker: "schwab",
      symbol: "SPY",
      side: "buy",
      qty: 10,
      remaining_qty: 10,
      estimated_notional: 5000,
      estimated_delta: 0.5,
      asof: "2026-06-01T10:00:00Z",
      status: "pending",
      envelope_id: "env-1",
    };

    const { store: pendingIntents, revoked } = makePendingIntentsStub([envelope]);
    const { revoker, calls } = makeRevokerStub();
    const logger = createTestLogger("test");

    // Strategy has NO halt_eligible on hit_rate
    const strategy = makeStrategy({
      drift: {
        hit_rate: {
          range: [0.5, 0.9],
          n_min: 30,
          // halt_eligible NOT set
        },
      },
    });

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map([["schwab", revoker]]),
      strategies: () => [strategy],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(calls).toHaveLength(0);
    expect(revoked).toHaveLength(0);
  });

  it("revokes open envelopes when metric is halt_eligible", async () => {
    const db = makeTrippingDbStub();
    const { handle: detector } = makeDetectorStub(false);

    const envelope: PendingIntent = {
      intent_id: "intent-1",
      strategy_id: "strat-1",
      portfolio_id: "port-a",
      broker: "schwab",
      symbol: "SPY",
      side: "buy",
      qty: 10,
      remaining_qty: 10,
      estimated_notional: 5000,
      estimated_delta: 0.5,
      asof: "2026-06-01T10:00:00Z",
      status: "pending",
      envelope_id: "env-1",
    };

    const { store: pendingIntents, revoked } = makePendingIntentsStub([envelope]);
    const { revoker, calls } = makeRevokerStub({ status: "revoked" });
    const logger = createTestLogger("test");

    const strategy = makeStrategy({
      drift: {
        hit_rate: {
          range: [0.5, 0.9],
          n_min: 30,
          halt_eligible: true,
        },
      },
    });

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map([["schwab", revoker]]),
      strategies: () => [strategy],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      envelopeId: "env-1",
      reason: "drift_hard_trip",
    });
    expect(revoked).toContain("env-1");
  });

  it("does not revoke when there are no pending envelopes", async () => {
    const db = makeTrippingDbStub();
    const { handle: detector } = makeDetectorStub(false);
    const { store: pendingIntents } = makePendingIntentsStub([]); // no envelopes
    const { revoker, calls } = makeRevokerStub();
    const logger = createTestLogger("test");

    const strategy = makeStrategy({
      drift: {
        hit_rate: {
          range: [0.5, 0.9],
          n_min: 30,
          halt_eligible: true,
        },
      },
    });

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map([["schwab", revoker]]),
      strategies: () => [strategy],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(calls).toHaveLength(0);
  });

  it("skips metric when no spec range declared (no baseline yet)", async () => {
    const db = makeTrippingDbStub();
    const { handle: detector, alerts } = makeDetectorStub(false);
    const { store: pendingIntents } = makePendingIntentsStub();
    const logger = createTestLogger("test");

    // Strategy has hit_rate config but NO range declared.
    const strategy = makeStrategy({
      drift: {
        hit_rate: { n_min: 30 },
      } as DriftSpec,
    });

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map(),
      strategies: () => [strategy],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    // No range → no alert.
    expect(alerts).toHaveLength(0);
  });

  it("stop() logs slow-tier.stopped", () => {
    const db = makeDbStub([]);
    const { handle: detector } = makeDetectorStub(false);
    const { store: pendingIntents } = makePendingIntentsStub();
    const logger = createTestLogger("test");

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map(),
      strategies: () => [],
      now: () => "2026-06-01T12:00:00.000Z",
    });

    tier.stop();

    expect(logger.logs).toContainEqual(
      expect.objectContaining({ level: "info", msg: "slow-tier.stopped" }),
    );
  });

  it("alert payload contains CI bounds as observed", async () => {
    const db = makeTrippingDbStub();
    const { handle: detector, alerts } = makeDetectorStub(false);
    const { store: pendingIntents } = makePendingIntentsStub();
    const logger = createTestLogger("test");

    const tier = startSlowTier({
      db,
      logger,
      detector,
      pendingIntents,
      revokers: new Map(),
      strategies: () => [makeStrategy()],
      now: () => "2026-06-01T12:00:00.000Z",
    });
    tier.stop();

    await tier.tick();

    expect(alerts).toHaveLength(1);
    const observed = alerts[0]?.observed;
    expect(observed).toHaveProperty("ci_lower");
    expect(observed).toHaveProperty("ci_upper");
  });
});
