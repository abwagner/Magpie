import { describe, it, expect, vi } from "vitest";
import {
  createExitRuleMonitor,
  createExitRuleMetrics,
  OPERATOR_STRATEGY_ID,
  type ExitRuleMonitorDeps,
  type ExitRuleMetrics,
  type ExitRuleTripEvent,
  type ExitRuleEvaluation,
  type StrategyExitPolicy,
} from "../../exit-rule-monitor.js";
import type { Position, PositionUpdate } from "../../../../src/types/portfolio.js";
import type { OrderIntent } from "../../../../src/types/order.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("test", "error");
const FIXED_NOW = Date.parse("2026-06-01T12:00:00.000Z");

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    position_id: "pos-1",
    symbol: "EQ:SPY",
    underlying: "SPY",
    direction: "Long",
    quantity: 10,
    entry_price: 100,
    entry_date: "2026-06-01T11:00:00.000Z",
    current_price: 100,
    unrealized_pnl: 0,
    delta: 1,
    gamma: 0,
    theta: 0,
    vega: 0,
    strategy_id: "alpha",
    composite_id: null,
    closing_intent_id: null,
    ...overrides,
  };
}

function makeUpdate(positions: Position[]): PositionUpdate {
  return { portfolio: "main", positions, asof: "2026-06-01T12:00:00.000Z" };
}

function makeMonitor(
  policy: StrategyExitPolicy | undefined,
  overrides: Partial<ExitRuleMonitorDeps> = {},
): { deps: ExitRuleMonitorDeps; metrics: ExitRuleMetrics; submit: ReturnType<typeof vi.fn> } {
  const metrics = createExitRuleMetrics();
  const submit = vi.fn<(intent: OrderIntent) => Promise<void>>().mockResolvedValue(undefined);
  let counter = 0;
  const deps: ExitRuleMonitorDeps = {
    logger,
    metrics,
    getPolicy: () => policy,
    submitClosingIntent: submit,
    newIntentId: () => `intent-${++counter}`,
    now: () => FIXED_NOW,
    ...overrides,
  };
  return { deps, metrics, submit };
}

const STOP: StrategyExitPolicy = { per_position: { stop_loss_pct: 0.05 }, per_strategy: {} };

describe("exit-rule-monitor — per-position rules", () => {
  it("trips stop_loss and emits a close with reason + position_id", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    // notional 1000, loss 60 = -6% ≤ -5%
    const pos = makePosition({ unrealized_pnl: -60 });
    const evals = await monitor.evaluate(makeUpdate([pos]));

    expect(submit).toHaveBeenCalledOnce();
    const intent = submit.mock.calls[0]![0];
    expect(intent.action).toBe("close");
    expect(intent.reason).toBe("exit_rule_stop_loss");
    expect(intent.position_id).toBe("pos-1");
    expect(intent.strategy_id).toBe("alpha");
    expect(pos.closing_intent_id).toBe(intent.intent_id);
    expect(evals.find((e) => e.rule === "stop_loss")?.tripped).toBe(true);
  });

  it("does not trip stop_loss above threshold", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ unrealized_pnl: -40 }); // -4% > -5%
    const evals = await monitor.evaluate(makeUpdate([pos]));
    expect(submit).not.toHaveBeenCalled();
    expect(evals[0]!.tripped).toBe(false);
    expect(evals[0]!.headroom_pct).toBeGreaterThan(0);
  });

  it("trips target when gain ≥ target_pct", async () => {
    const policy: StrategyExitPolicy = { per_position: { target_pct: 0.1 }, per_strategy: {} };
    const { deps, submit } = makeMonitor(policy);
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ unrealized_pnl: 150 }); // +15% ≥ +10%
    await monitor.evaluate(makeUpdate([pos]));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].reason).toBe("exit_rule_target");
  });

  it("trips max_hold using the injected clock", async () => {
    const policy: StrategyExitPolicy = {
      per_position: { max_hold_seconds: 1800 }, // 30 min
      per_strategy: {},
    };
    const { deps, submit } = makeMonitor(policy);
    const monitor = createExitRuleMonitor(deps);
    // opened 60 min before FIXED_NOW → 3600s ≥ 1800s
    const pos = makePosition({ entry_date: "2026-06-01T11:00:00.000Z" });
    await monitor.evaluate(makeUpdate([pos]));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].reason).toBe("exit_rule_max_hold");
  });

  it("does not falsely trip max_hold when entry_date is unparseable", async () => {
    const policy: StrategyExitPolicy = {
      per_position: { max_hold_seconds: 1 },
      per_strategy: {},
    };
    const { deps, submit } = makeMonitor(policy);
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ entry_date: "not-a-date" });
    await monitor.evaluate(makeUpdate([pos]));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("exit-rule-monitor — composites", () => {
  it("trips on composite P&L and emits one close per leg", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    // Two legs, composite -6% overall (each notional 1000, -60 each)
    const legA = makePosition({ position_id: "leg-a", composite_id: "cmp-1", unrealized_pnl: -60 });
    const legB = makePosition({ position_id: "leg-b", composite_id: "cmp-1", unrealized_pnl: -60 });
    await monitor.evaluate(makeUpdate([legA, legB]));
    expect(submit).toHaveBeenCalledTimes(2);
    const ids = submit.mock.calls.map((c) => c[0].position_id).sort();
    expect(ids).toEqual(["leg-a", "leg-b"]);
  });

  it("does not trip a composite whose aggregate P&L is within threshold", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    // One leg -60, other +40 → net -20 on 2000 notional = -1%
    const legA = makePosition({ position_id: "leg-a", composite_id: "cmp-1", unrealized_pnl: -60 });
    const legB = makePosition({ position_id: "leg-b", composite_id: "cmp-1", unrealized_pnl: 40 });
    await monitor.evaluate(makeUpdate([legA, legB]));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("exit-rule-monitor — max_drawdown", () => {
  const DD: StrategyExitPolicy = { per_position: {}, per_strategy: { max_drawdown_pct: 0.1 } };

  it("trips when equity falls ≥ max_drawdown_pct from the high-water mark", async () => {
    const { deps, submit } = makeMonitor(DD);
    const monitor = createExitRuleMonitor(deps);
    // Pass 1: equity +200 on 1000 notional sets HWM.
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: 200 })]));
    expect(submit).not.toHaveBeenCalled();
    expect(monitor.highWaterMark("alpha")).toBe(200);
    // Pass 2: equity drops to +50 → drawdown 150/1000 = 15% ≥ 10%.
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: 50 })]));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].reason).toBe("exit_rule_max_drawdown");
  });

  it("closes every position the strategy owns on a drawdown trip", async () => {
    const { deps, submit } = makeMonitor(DD);
    const monitor = createExitRuleMonitor(deps);
    const a = makePosition({ position_id: "p-a", unrealized_pnl: 100 });
    const b = makePosition({ position_id: "p-b", unrealized_pnl: 100 });
    await monitor.evaluate(makeUpdate([a, b])); // HWM 200
    const a2 = makePosition({ position_id: "p-a", unrealized_pnl: -50 });
    const b2 = makePosition({ position_id: "p-b", unrealized_pnl: -50 });
    await monitor.evaluate(makeUpdate([a2, b2])); // equity -100, dd 300/2000=15%
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe("exit-rule-monitor — idempotency + skips", () => {
  it("skips a position whose closing intent is already in-flight", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ unrealized_pnl: -60, closing_intent_id: "already" });
    await monitor.evaluate(makeUpdate([pos]));
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not re-emit on the next tick after a trip", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ unrealized_pnl: -60 });
    await monitor.evaluate(makeUpdate([pos]));
    await monitor.evaluate(makeUpdate([pos])); // closing_intent_id now set
    expect(submit).toHaveBeenCalledOnce();
  });

  it("skips positions with no strategy_id", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(
      makeUpdate([makePosition({ strategy_id: undefined, unrealized_pnl: -99 })]),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("skips operator-originated positions", async () => {
    const { deps, submit } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(
      makeUpdate([makePosition({ strategy_id: OPERATOR_STRATEGY_ID, unrealized_pnl: -99 })]),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("skips strategies with no declared policy", async () => {
    const { deps, submit } = makeMonitor(undefined);
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -99 })]));
    expect(submit).not.toHaveBeenCalled();
  });

  it("skips retired strategies", async () => {
    const { deps, submit } = makeMonitor(STOP, { isStrategyRetired: () => true });
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -99 })]));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("exit-rule-monitor — failure modes + metrics", () => {
  it("leaves closing_intent_id unset when OPL rejects, so a later tick re-emits", async () => {
    const submit = vi
      .fn<(intent: OrderIntent) => Promise<void>>()
      .mockRejectedValueOnce(new Error("rejected"))
      .mockResolvedValueOnce(undefined);
    const { deps } = makeMonitor(STOP, { submitClosingIntent: submit });
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ unrealized_pnl: -60 });
    await monitor.evaluate(makeUpdate([pos]));
    expect(pos.closing_intent_id).toBeNull();
    await monitor.evaluate(makeUpdate([pos]));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(pos.closing_intent_id).not.toBeNull();
  });

  it("onPositionUpdate swallows a throwing eval at the boundary", async () => {
    const submit = vi
      .fn<(intent: OrderIntent) => Promise<void>>()
      .mockRejectedValue(new Error("boom"));
    const { deps } = makeMonitor(STOP, { submitClosingIntent: submit });
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ unrealized_pnl: -60 });
    expect(() => monitor.onPositionUpdate(makeUpdate([pos]))).not.toThrow();
  });

  it("increments exit_rule_trips_total on a trip", async () => {
    const { deps, metrics } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -60 })]));
    const snap = await metrics.tripsTotal.get();
    const row = snap.values.find(
      (v) => v.labels.strategy_id === "alpha" && v.labels.rule === "stop_loss",
    );
    expect(row?.value).toBe(1);
  });

  it("publishes headroom for armed rules", async () => {
    const { deps, metrics } = makeMonitor(STOP);
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -40 })]));
    const snap = await metrics.headroomPct.get();
    expect(snap.values.length).toBeGreaterThan(0);
  });
});

// ── QF-351 — WS push callbacks ───────────────────────────────────────

describe("exit-rule-monitor — WS push callbacks (QF-351)", () => {
  it("calls onTripEvent with position_id, rule, closing_intent_id, strategy_id on a trip", async () => {
    const tripEvents: ExitRuleTripEvent[] = [];
    const { deps } = makeMonitor(STOP, {
      onTripEvent: (ev) => tripEvents.push(ev),
    });
    const monitor = createExitRuleMonitor(deps);
    const pos = makePosition({ unrealized_pnl: -60 }); // trips stop_loss
    await monitor.evaluate(makeUpdate([pos]));

    expect(tripEvents).toHaveLength(1);
    expect(tripEvents[0]!.position_id).toBe("pos-1");
    expect(tripEvents[0]!.rule).toBe("stop_loss");
    expect(tripEvents[0]!.strategy_id).toBe("alpha");
    expect(tripEvents[0]!.closing_intent_id).toBeTruthy();
    // closing_intent_id must match what was set on the position
    expect(tripEvents[0]!.closing_intent_id).toBe(pos.closing_intent_id);
  });

  it("does not call onTripEvent when the rule does not trip", async () => {
    const tripEvents: ExitRuleTripEvent[] = [];
    const { deps } = makeMonitor(STOP, {
      onTripEvent: (ev) => tripEvents.push(ev),
    });
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -40 })])); // -4% < -5%
    expect(tripEvents).toHaveLength(0);
  });

  it("calls onTripAlert with strategyId and rule on a trip", async () => {
    const alerts: Array<{ strategyId: string; rule: string }> = [];
    const { deps } = makeMonitor(STOP, {
      onTripAlert: (sid, rule) => alerts.push({ strategyId: sid, rule }),
    });
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -60 })]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.strategyId).toBe("alpha");
    expect(alerts[0]!.rule).toBe("stop_loss");
  });

  it("calls onTripEvent once per leg on a composite trip", async () => {
    const tripEvents: ExitRuleTripEvent[] = [];
    const { deps } = makeMonitor(STOP, {
      onTripEvent: (ev) => tripEvents.push(ev),
    });
    const monitor = createExitRuleMonitor(deps);
    const legA = makePosition({ position_id: "leg-a", composite_id: "cmp-1", unrealized_pnl: -60 });
    const legB = makePosition({ position_id: "leg-b", composite_id: "cmp-1", unrealized_pnl: -60 });
    await monitor.evaluate(makeUpdate([legA, legB]));
    expect(tripEvents).toHaveLength(2);
    const ids = tripEvents.map((e) => e.position_id).sort();
    expect(ids).toEqual(["leg-a", "leg-b"]);
  });

  it("calls onEvalComplete after each strategy eval pass with all evaluations", async () => {
    const completions: Array<{ strategyId: string; evals: ExitRuleEvaluation[] }> = [];
    const { deps } = makeMonitor(STOP, {
      onEvalComplete: (sid, evals) => completions.push({ strategyId: sid, evals }),
    });
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -40 })]));
    expect(completions).toHaveLength(1);
    expect(completions[0]!.strategyId).toBe("alpha");
    expect(completions[0]!.evals).toHaveLength(1);
    expect(completions[0]!.evals[0]!.rule).toBe("stop_loss");
    expect(completions[0]!.evals[0]!.threshold).toBeCloseTo(-0.05);
  });

  it("does not call onTripEvent when OPL rejects the close intent", async () => {
    const tripEvents: ExitRuleTripEvent[] = [];
    const submit = vi
      .fn<(intent: import("../../../../src/types/order.js").OrderIntent) => Promise<void>>()
      .mockRejectedValue(new Error("rejected"));
    const { deps } = makeMonitor(STOP, {
      submitClosingIntent: submit,
      onTripEvent: (ev) => tripEvents.push(ev),
    });
    const monitor = createExitRuleMonitor(deps);
    await monitor.evaluate(makeUpdate([makePosition({ unrealized_pnl: -60 })]));
    // No trip event because the intent was rejected (closing_intent_id stays null)
    expect(tripEvents).toHaveLength(0);
  });
});
