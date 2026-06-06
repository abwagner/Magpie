import { describe, it, expect, vi } from "vitest";
import {
  liquidatePositions,
  OPERATOR_STRATEGY_ID,
  type LiquidationDeps,
  type LiquidatablePosition,
} from "../../positions.js";
import type { OrderIntent, Order } from "../../../../src/types/order.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("test", "error");

function makePos(overrides: Partial<LiquidatablePosition> = {}): LiquidatablePosition {
  return {
    position_id: "pos-1",
    portfolio: "main",
    symbol: "EQ:SPY",
    direction: "Long",
    quantity: 10,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "ord-1",
    intent_id: "intent-1",
    client_order_id: "intent-1",
    portfolio: "main",
    broker: "paper",
    execution_mode: "paper_local",
    status: "risk_check",
    created_at: "2026-06-01T12:00:00.000Z",
    ...overrides,
  } as Order;
}

function makeDeps(
  positions: LiquidatablePosition[],
  overrides: Partial<LiquidationDeps> = {},
): { deps: LiquidationDeps; submit: ReturnType<typeof vi.fn> } {
  const submit = vi
    .fn<(intent: OrderIntent) => Promise<Order>>()
    .mockImplementation((intent) => Promise.resolve(makeOrder({ intent_id: intent.intent_id })));
  let counter = 0;
  const deps: LiquidationDeps = {
    resolvePosition: (id) => positions.find((p) => p.position_id === id) ?? null,
    submit,
    newId: () => `intent-${++counter}`,
    now: () => "2026-06-01T12:00:00.000Z",
    logger,
    ...overrides,
  };
  return { deps, submit };
}

describe("liquidatePositions", () => {
  it("submits a closing intent with operator_manual reason + position_id", async () => {
    const { deps, submit } = makeDeps([makePos()]);
    const outcomes = await liquidatePositions(deps, ["pos-1"]);

    expect(submit).toHaveBeenCalledOnce();
    const intent = submit.mock.calls[0]![0];
    expect(intent.action).toBe("close");
    expect(intent.direction).toBe("close");
    expect(intent.reason).toBe("operator_manual");
    expect(intent.position_id).toBe("pos-1");
    expect(intent.strategy_id).toBe(OPERATOR_STRATEGY_ID);
    expect(intent.quantity).toBe(10);
    expect(outcomes[0]).toMatchObject({ position_id: "pos-1", status: "submitted" });
  });

  it("uses the position's strategy_id when present", async () => {
    const { deps, submit } = makeDeps([makePos({ strategy_id: "alpha" })]);
    await liquidatePositions(deps, ["pos-1"]);
    expect(submit.mock.calls[0]![0].strategy_id).toBe("alpha");
  });

  it("reports not_found for an unknown position and submits nothing", async () => {
    const { deps, submit } = makeDeps([makePos()]);
    const outcomes = await liquidatePositions(deps, ["ghost"]);
    expect(submit).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ position_id: "ghost", status: "not_found" }]);
  });

  it("liquidates several positions in one multi-select request", async () => {
    const positions = [
      makePos({ position_id: "p-a" }),
      makePos({ position_id: "p-b" }),
      makePos({ position_id: "p-c" }),
    ];
    const { deps, submit } = makeDeps(positions);
    const outcomes = await liquidatePositions(deps, ["p-a", "p-b", "p-c"]);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(outcomes.map((o) => o.status)).toEqual(["submitted", "submitted", "submitted"]);
  });

  it("expands a composite to all legs and deduplicates overlapping requests", async () => {
    const legA = makePos({ position_id: "leg-a", composite_id: "cmp-1" });
    const legB = makePos({ position_id: "leg-b", composite_id: "cmp-1" });
    const { deps, submit } = makeDeps([legA, legB], {
      expandComposite: (seed) => (seed.composite_id === "cmp-1" ? [legA, legB] : [seed]),
    });
    // Both legs requested → still one submit per atomic leg (dedup).
    const outcomes = await liquidatePositions(deps, ["leg-a", "leg-b"]);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.position_id).sort()).toEqual(["leg-a", "leg-b"]);
  });

  it("isolates a per-leg submit failure from the rest", async () => {
    const positions = [makePos({ position_id: "p-a" }), makePos({ position_id: "p-b" })];
    const submit = vi
      .fn<(intent: OrderIntent) => Promise<Order>>()
      .mockRejectedValueOnce(new Error("rejected"))
      .mockResolvedValueOnce(makeOrder());
    const { deps } = makeDeps(positions, { submit });
    const outcomes = await liquidatePositions(deps, ["p-a", "p-b"]);
    expect(outcomes[0]).toMatchObject({ position_id: "p-a", status: "error", error: "rejected" });
    expect(outcomes[1]).toMatchObject({ position_id: "p-b", status: "submitted" });
  });
});
