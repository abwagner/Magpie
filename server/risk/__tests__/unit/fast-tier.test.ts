// QF-329 — drift-detector: fast-tier (per-fill hard-bound checks)
//
// Covers:
//   Initialization:
//     - createFastTier() logs fast-tier.started
//     - unknown strategy_id is a no-op (no alert, no crash)
//   daily_loss_floor:
//     - no alert when daily P&L is above floor
//     - alert fires when daily P&L crosses below floor
//     - alert is suppressed when budget exhausted for the day
//     - P&L accumulates across multiple fills
//   max_notional:
//     - no alert when open_notional is at or below ceiling
//     - alert fires when open_notional exceeds ceiling
//   max_positions:
//     - no alert when open_position_count is at or below ceiling
//     - alert fires when open_position_count exceeds ceiling
//   max_seconds_between_fills:
//     - no alert on first fill (no previous timestamp)
//     - no alert when gap is within bound
//     - alert fires when gap exceeds bound
//   Alert payload shape:
//     - alert_type is always 'drift_fast_floor'
//     - observed is a scalar number
//     - spec_range uses { floor } for daily_loss_floor, { ceiling } for others
//   resetDaily():
//     - resets daily P&L accumulators
//     - resets last-fill timestamps (no cadence alert on first fill after reset)

import { describe, it, expect } from "vitest";
import { createFastTier, type FastTierFill, type FastTierStrategy } from "../../fast-tier.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import type { DriftDetectorHandle } from "../../drift-detector.js";

// ── Stubs ─────────────────────────────────────────────────────────

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

function makeStrategy(overrides: Partial<FastTierStrategy> = {}): FastTierStrategy {
  return {
    id: "strat-1",
    portfolio_id: "port-a",
    drift: {},
    ...overrides,
  };
}

function makeFill(overrides: Partial<FastTierFill> = {}): FastTierFill {
  return {
    fill_ts: "2026-06-01T12:00:00.000Z",
    strategy_id: "strat-1",
    portfolio_id: "port-a",
    realized_pnl: 0,
    open_notional: 0,
    open_position_count: 0,
    ...overrides,
  };
}

// ── Initialization ─────────────────────────────────────────────────

describe("createFastTier", () => {
  it("logs fast-tier.started on creation", () => {
    const logger = createTestLogger("test");
    const { handle: detector } = makeDetectorStub();

    createFastTier({
      logger,
      detector,
      strategies: () => [],
    });

    expect(logger.logs).toContainEqual(
      expect.objectContaining({ level: "info", msg: "fast-tier.started" }),
    );
  });

  it("is a no-op for an unknown strategy_id", async () => {
    const logger = createTestLogger("test");
    const { handle: detector, alerts } = makeDetectorStub();

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ id: "known-strat" })],
    });

    await tier.onFill(makeFill({ strategy_id: "unknown-strat" }));

    expect(alerts).toHaveLength(0);
  });
});

// ── daily_loss_floor ───────────────────────────────────────────────

describe("daily_loss_floor", () => {
  it("does not fire when daily P&L is above floor", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { daily_loss_floor: -500 } })],
    });

    // P&L = -100, floor = -500 → no trip
    await tier.onFill(makeFill({ realized_pnl: -100 }));

    expect(alerts).toHaveLength(0);
  });

  it("fires alert when daily P&L crosses below floor", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { daily_loss_floor: -500 } })],
    });

    // P&L = -600, floor = -500 → trip
    await tier.onFill(makeFill({ realized_pnl: -600 }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: "drift_fast_floor",
      strategy_id: "strat-1",
      portfolio_id: "port-a",
      metric: "daily_loss_floor",
      baseline_source: "spec",
      sample_size: 1,
    });
    expect(alerts[0]?.observed).toBe(-600);
    expect(alerts[0]?.spec_range).toEqual({ floor: -500 });
  });

  it("accumulates P&L across multiple fills before tripping", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { daily_loss_floor: -500 } })],
    });

    // Two fills: -200 and -350 → cumulative -550 → trip on second
    await tier.onFill(makeFill({ realized_pnl: -200 }));
    expect(alerts).toHaveLength(0);

    await tier.onFill(makeFill({ realized_pnl: -350 }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.observed).toBe(-550);
  });

  it("suppresses alert when budget is exhausted", async () => {
    // budgetResult=true → budget exhausted
    const { handle: detector, alerts } = makeDetectorStub(true);
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { daily_loss_floor: -500 } })],
    });

    await tier.onFill(makeFill({ realized_pnl: -600 }));

    expect(alerts).toHaveLength(0);
  });

  it("P&L accumulator resets after resetDaily()", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { daily_loss_floor: -500 } })],
    });

    // First day: -600 → trip
    await tier.onFill(makeFill({ realized_pnl: -600 }));
    expect(alerts).toHaveLength(1);

    // Reset daily
    tier.resetDaily();

    // Next day: -400 → still above floor
    await tier.onFill(makeFill({ realized_pnl: -400 }));
    expect(alerts).toHaveLength(1); // no new alert
  });
});

// ── max_notional ───────────────────────────────────────────────────

describe("max_notional", () => {
  it("does not fire when open_notional is at or below ceiling", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_notional: 100_000 } })],
    });

    await tier.onFill(makeFill({ open_notional: 100_000 }));

    expect(alerts).toHaveLength(0);
  });

  it("fires alert when open_notional exceeds ceiling", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_notional: 100_000 } })],
    });

    await tier.onFill(makeFill({ open_notional: 120_000 }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: "drift_fast_floor",
      strategy_id: "strat-1",
      metric: "max_notional",
    });
    expect(alerts[0]?.observed).toBe(120_000);
    expect(alerts[0]?.spec_range).toEqual({ ceiling: 100_000 });
  });
});

// ── max_positions ──────────────────────────────────────────────────

describe("max_positions", () => {
  it("does not fire when open_position_count is at or below ceiling", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_positions: 10 } })],
    });

    await tier.onFill(makeFill({ open_position_count: 10 }));

    expect(alerts).toHaveLength(0);
  });

  it("fires alert when open_position_count exceeds ceiling", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_positions: 10 } })],
    });

    await tier.onFill(makeFill({ open_position_count: 11 }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: "drift_fast_floor",
      strategy_id: "strat-1",
      metric: "max_positions",
    });
    expect(alerts[0]?.observed).toBe(11);
    expect(alerts[0]?.spec_range).toEqual({ ceiling: 10 });
  });
});

// ── max_seconds_between_fills ──────────────────────────────────────

describe("max_seconds_between_fills", () => {
  it("does not fire on the first fill (no previous timestamp)", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_seconds_between_fills: 60 } })],
    });

    await tier.onFill(makeFill({ fill_ts: "2026-06-01T12:00:00.000Z" }));

    expect(alerts).toHaveLength(0);
  });

  it("does not fire when gap is within bound", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_seconds_between_fills: 60 } })],
    });

    // First fill sets the baseline
    await tier.onFill(makeFill({ fill_ts: "2026-06-01T12:00:00.000Z" }));
    // Second fill 30 seconds later — within bound
    await tier.onFill(makeFill({ fill_ts: "2026-06-01T12:00:30.000Z" }));

    expect(alerts).toHaveLength(0);
  });

  it("fires alert when gap exceeds bound", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_seconds_between_fills: 60 } })],
    });

    // First fill sets the baseline
    await tier.onFill(makeFill({ fill_ts: "2026-06-01T12:00:00.000Z" }));
    // Second fill 120 seconds later — exceeds bound
    await tier.onFill(makeFill({ fill_ts: "2026-06-01T12:02:00.000Z" }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: "drift_fast_floor",
      strategy_id: "strat-1",
      metric: "max_seconds_between_fills",
    });
    expect(alerts[0]?.observed).toBeCloseTo(120);
    expect(alerts[0]?.spec_range).toEqual({ ceiling: 60 });
  });

  it("does not fire on first fill after resetDaily()", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [makeStrategy({ drift: { max_seconds_between_fills: 60 } })],
    });

    // First day: two fills; second one trips
    await tier.onFill(makeFill({ fill_ts: "2026-06-01T12:00:00.000Z" }));
    await tier.onFill(makeFill({ fill_ts: "2026-06-01T12:02:00.000Z" }));
    expect(alerts).toHaveLength(1);

    // Reset daily — clears last-fill timestamp
    tier.resetDaily();

    // Next day first fill: no previous timestamp → no cadence alert
    await tier.onFill(makeFill({ fill_ts: "2026-06-02T12:00:00.000Z" }));
    expect(alerts).toHaveLength(1); // no new alert
  });
});

// ── Multiple checks in a single fill ──────────────────────────────

describe("multiple bounds on a single fill", () => {
  it("fires multiple alerts when several bounds are tripped", async () => {
    const { handle: detector, alerts } = makeDetectorStub();
    const logger = createTestLogger("test");

    const tier = createFastTier({
      logger,
      detector,
      strategies: () => [
        makeStrategy({
          drift: {
            daily_loss_floor: -500,
            max_notional: 100_000,
            max_positions: 5,
          },
        }),
      ],
    });

    // Single fill that trips all three bounds
    await tier.onFill(
      makeFill({
        realized_pnl: -600,
        open_notional: 150_000,
        open_position_count: 7,
      }),
    );

    expect(alerts).toHaveLength(3);
    const metrics = alerts.map((a) => a.metric);
    expect(metrics).toContain("daily_loss_floor");
    expect(metrics).toContain("max_notional");
    expect(metrics).toContain("max_positions");
  });
});

// ── resetDaily ────────────────────────────────────────────────────

describe("resetDaily", () => {
  it("logs fast-tier.daily-reset", () => {
    const logger = createTestLogger("test");
    const { handle: detector } = makeDetectorStub();

    const tier = createFastTier({ logger, detector, strategies: () => [] });
    tier.resetDaily();

    expect(logger.logs).toContainEqual(
      expect.objectContaining({ level: "info", msg: "fast-tier.daily-reset" }),
    );
  });
});
