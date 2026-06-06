// ── Gate Evaluator CLI Tests ───────────────────────────────────────
// Tests NDJSON frame protocol against fixture frames (backtest-gate.md §3.2).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  EVALUATOR_SCHEMA_VERSION,
  makeEmptyState,
  applyFillToState,
  resolveCommitHash,
  writeFrame,
  run,
} from "./gate-evaluator-cli.js";
import type {
  InitFrame,
  EvaluateFrame,
  FillFrame,
  SnapshotFrame,
  ShutdownFrame,
  InitOkFrame,
  DecisionFrame,
  OutboundFrame,
} from "./gate-evaluator-cli.js";
import type { PortfolioState, RiskLimits } from "../src/types/portfolio.js";
import type { Fill, OrderIntent } from "../src/types/order.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeReadable(lines: string[]): Readable {
  return Readable.from(lines.join("\n") + "\n");
}

function makeWritable(): { writable: Writable; frames: () => OutboundFrame[] } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    writable,
    frames: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as OutboundFrame),
  };
}

function makeInitFrame(overrides: Partial<InitFrame> = {}): InitFrame {
  return {
    type: "init",
    risk_limits: makeLimits(),
    portfolio_id: "test-portfolio",
    initial_cash: 100000,
    ...overrides,
  };
}

function makeLimits(overrides: Partial<RiskLimits> = {}): RiskLimits {
  return {
    max_net_delta: 50,
    max_net_vega: 100,
    max_daily_loss: 5000,
    max_symbol_concentration: 20,
    max_drawdown: 10000,
    max_order_size: 10,
    max_open_orders: 20,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intent_id: "intent-1",
    portfolio: "test-portfolio",
    strategy_id: "test-strategy",
    action: "open",
    symbol: "EQ:SPY",
    direction: "Long",
    quantity: 1,
    reason: "test",
    signal_ids: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvaluateFrame(overrides: Partial<EvaluateFrame> = {}): EvaluateFrame {
  const intent = makeIntent(overrides.intent);
  return {
    type: "evaluate",
    intent_id: intent.intent_id,
    intent,
    ...overrides,
  };
}

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    fill_id: "fill-1",
    order_id: "order-1",
    intent_id: "intent-1",
    portfolio: "test-portfolio",
    symbol: "EQ:SPY",
    direction: "Long",
    quantity: 1,
    price: 500,
    fees: 1,
    filled_at: new Date().toISOString(),
    broker: "test",
    ...overrides,
  };
}

async function runWithFrames(inboundFrames: object[]): Promise<OutboundFrame[]> {
  const lines = inboundFrames.map((f) => JSON.stringify(f));
  const input = makeReadable(lines);
  const { writable, frames } = makeWritable();
  await run(input, writable, "test-hash");
  return frames();
}

// ── Tests ──────────────────────────────────────────────────────────

describe("EVALUATOR_SCHEMA_VERSION", () => {
  it("is a positive integer", () => {
    expect(typeof EVALUATOR_SCHEMA_VERSION).toBe("number");
    expect(Number.isInteger(EVALUATOR_SCHEMA_VERSION)).toBe(true);
    expect(EVALUATOR_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe("resolveCommitHash", () => {
  it("returns a non-empty string", () => {
    const hash = resolveCommitHash();
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe("makeEmptyState", () => {
  it("initializes empty state with given portfolio and cash", () => {
    const state = makeEmptyState("p1", 50000);
    expect(state.portfolio_id).toBe("p1");
    expect(state.cash).toBe(50000);
    expect(state.equity).toBe(50000);
    expect(state.positions).toHaveLength(0);
    expect(state.halted).toBe(false);
  });
});

describe("applyFillToState", () => {
  it("opens a new position on fill", () => {
    const state = makeEmptyState("p1", 100000);
    const fill = makeFill({ quantity: 5, price: 500 });
    applyFillToState(state, fill);
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0]!.quantity).toBe(5);
    expect(state.positions[0]!.direction).toBe("Long");
    expect(state.cash).toBe(100000 - 5 * 500 - 1); // cash - cost - fees
  });

  it("closes an existing position on opposing fill", () => {
    const state = makeEmptyState("p1", 100000);
    const openFill = makeFill({ direction: "Long", quantity: 5, price: 500, fill_id: "f1" });
    applyFillToState(state, openFill);
    expect(state.positions).toHaveLength(1);

    const closeFill = makeFill({ direction: "Short", quantity: 5, price: 510, fill_id: "f2" });
    applyFillToState(state, closeFill);
    expect(state.positions).toHaveLength(0);
    // PnL: (510-500)*5 = 50, minus closing fill fees (1) → 49
    // (opening fill fees were already subtracted from cash, not realized_pnl)
    expect(state.total_realized_pnl).toBeCloseTo(49, 5);
  });

  it("partially closes a position", () => {
    const state = makeEmptyState("p1", 100000);
    applyFillToState(
      state,
      makeFill({ direction: "Long", quantity: 5, price: 500, fill_id: "f1" }),
    );
    applyFillToState(
      state,
      makeFill({ direction: "Short", quantity: 2, price: 505, fill_id: "f2" }),
    );
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0]!.quantity).toBe(3);
  });

  it("updates net_delta after fill", () => {
    const state = makeEmptyState("p1", 100000);
    applyFillToState(state, makeFill({ direction: "Long", quantity: 3, price: 500 }));
    // Default delta=1 for new positions
    expect(state.net_delta).toBe(3);
  });

  it("derives underlying from symbol with prefix", () => {
    const state = makeEmptyState("p1", 100000);
    applyFillToState(
      state,
      makeFill({ symbol: "EQ:AAPL", direction: "Long", quantity: 1, price: 200 }),
    );
    expect(state.positions[0]!.underlying).toBe("AAPL");
  });

  it("uses full symbol as underlying when no prefix", () => {
    const state = makeEmptyState("p1", 100000);
    applyFillToState(
      state,
      makeFill({ symbol: "SPY", direction: "Long", quantity: 1, price: 200 }),
    );
    expect(state.positions[0]!.underlying).toBe("SPY");
  });
});

describe("writeFrame", () => {
  it("writes JSON + newline to the output stream", () => {
    const { writable, frames } = makeWritable();
    const frame: InitOkFrame = {
      type: "init_ok",
      evaluator_schema_version: EVALUATOR_SCHEMA_VERSION,
      commit_hash: "abc123",
    };
    writeFrame(frame, writable);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toEqual(frame);
  });
});

// ── Protocol integration tests ─────────────────────────────────────

describe("run — init / init_ok", () => {
  it("replies init_ok with schema version and commit hash after init", async () => {
    const frames = await runWithFrames([makeInitFrame(), { type: "shutdown" }]);
    expect(frames).toHaveLength(1);
    const ok = frames[0] as InitOkFrame;
    expect(ok.type).toBe("init_ok");
    expect(ok.evaluator_schema_version).toBe(EVALUATOR_SCHEMA_VERSION);
    expect(ok.commit_hash).toBe("test-hash");
  });

  it("only replies init_ok once even if init is sent twice", async () => {
    const frames = await runWithFrames([makeInitFrame(), makeInitFrame(), { type: "shutdown" }]);
    const initOks = frames.filter((f) => f.type === "init_ok");
    expect(initOks).toHaveLength(1);
  });
});

describe("run — evaluate / decision", () => {
  it("approves valid intent and returns decision frame correlated by intent_id", async () => {
    const frames = await runWithFrames([
      makeInitFrame(),
      makeEvaluateFrame({ intent_id: "ev-001", intent: makeIntent({ intent_id: "ev-001" }) }),
      { type: "shutdown" },
    ]);
    const decision = frames.find((f) => f.type === "decision") as DecisionFrame | undefined;
    expect(decision).toBeDefined();
    expect(decision!.intent_id).toBe("ev-001");
    expect(decision!.decision).toBe("approve");
  });

  it("rejects intent that violates max_order_size", async () => {
    const frames = await runWithFrames([
      makeInitFrame({ risk_limits: makeLimits({ max_order_size: 3 }) }),
      makeEvaluateFrame({
        intent: makeIntent({ quantity: 10, intent_id: "ev-002" }),
        intent_id: "ev-002",
      }),
      { type: "shutdown" },
    ]);
    const decision = frames.find((f) => f.type === "decision") as DecisionFrame | undefined;
    expect(decision!.decision).toBe("reject");
    expect(decision!.reason).toContain("max_order_size");
  });

  it("rejects when portfolio is halted", async () => {
    const haltedState: PortfolioState = {
      ...makeEmptyState("test-portfolio", 100000),
      halted: true,
      halt_reason: "daily loss limit",
    };
    const snapshotFrame: SnapshotFrame = { type: "snapshot", state: haltedState };
    const frames = await runWithFrames([
      makeInitFrame(),
      snapshotFrame,
      makeEvaluateFrame(),
      { type: "shutdown" },
    ]);
    const decision = frames.find((f) => f.type === "decision") as DecisionFrame | undefined;
    expect(decision!.decision).toBe("reject");
    expect(decision!.reason).toContain("portfolio_halted");
  });

  it("evaluates with null risk_limits (no limits → always approve)", async () => {
    const frames = await runWithFrames([
      makeInitFrame({ risk_limits: null }),
      makeEvaluateFrame(),
      { type: "shutdown" },
    ]);
    const decision = frames.find((f) => f.type === "decision") as DecisionFrame | undefined;
    expect(decision!.decision).toBe("approve");
  });

  it("does not emit decision when evaluate arrives before init", async () => {
    const frames = await runWithFrames([makeEvaluateFrame(), { type: "shutdown" }]);
    const decisions = frames.filter((f) => f.type === "decision");
    expect(decisions).toHaveLength(0);
  });
});

describe("run — fill", () => {
  it("applies fill to internal state so subsequent evaluate uses updated positions", async () => {
    // Fill to 19 Long SPY, then evaluate 5 more → should breach concentration cap of 20
    const fillFrame: FillFrame = {
      type: "fill",
      fill: makeFill({
        symbol: "EQ:SPY",
        direction: "Long",
        quantity: 19,
        price: 500,
        fill_id: "f1",
      }),
    };
    const frames = await runWithFrames([
      makeInitFrame({ risk_limits: makeLimits({ max_symbol_concentration: 20 }) }),
      fillFrame,
      makeEvaluateFrame({
        intent_id: "ev-conc",
        intent: makeIntent({
          intent_id: "ev-conc",
          quantity: 5,
          direction: "Long",
          symbol: "EQ:SPY",
        }),
      }),
      { type: "shutdown" },
    ]);
    const decision = frames.find((f) => f.type === "decision") as DecisionFrame | undefined;
    expect(decision!.decision).toBe("reject");
    expect(decision!.reason).toContain("max_symbol_concentration");
  });
});

describe("run — snapshot", () => {
  it("replaces internal state with snapshot before evaluate", async () => {
    const haltedState: PortfolioState = {
      ...makeEmptyState("test-portfolio", 100000),
      halted: true,
    };
    const snapshotFrame: SnapshotFrame = { type: "snapshot", state: haltedState };
    const frames = await runWithFrames([
      makeInitFrame(),
      snapshotFrame,
      makeEvaluateFrame(),
      { type: "shutdown" },
    ]);
    const decision = frames.find((f) => f.type === "decision") as DecisionFrame | undefined;
    expect(decision!.decision).toBe("reject");
  });

  it("can snapshot before init (implicit init)", async () => {
    const state = makeEmptyState("test-portfolio", 100000);
    const snapshotFrame: SnapshotFrame = { type: "snapshot", state };
    const frames = await runWithFrames([snapshotFrame, makeEvaluateFrame(), { type: "shutdown" }]);
    // No init_ok (no init was sent), but evaluation should still work
    const decision = frames.find((f) => f.type === "decision") as DecisionFrame | undefined;
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe("approve");
  });
});

describe("run — shutdown", () => {
  it("exits cleanly on shutdown frame", async () => {
    const shutdownFrame: ShutdownFrame = { type: "shutdown" };
    // No exception means clean return
    await expect(runWithFrames([makeInitFrame(), shutdownFrame])).resolves.toBeDefined();
  });
});

describe("run — malformed input", () => {
  it("skips invalid JSON lines and continues", async () => {
    const input = makeReadable([
      "not valid json",
      JSON.stringify(makeInitFrame()),
      JSON.stringify({ type: "shutdown" }),
    ]);
    const { writable, frames } = makeWritable();
    await run(input, writable, "test-hash");
    // init_ok should still arrive despite bad first line
    expect(frames().find((f) => f.type === "init_ok")).toBeDefined();
  });

  it("skips frames missing a type field", async () => {
    const input = makeReadable([
      JSON.stringify({ notAType: "init" }),
      JSON.stringify(makeInitFrame()),
      JSON.stringify({ type: "shutdown" }),
    ]);
    const { writable, frames } = makeWritable();
    await run(input, writable, "test-hash");
    expect(frames().find((f) => f.type === "init_ok")).toBeDefined();
  });

  it("ignores empty lines", async () => {
    const input = makeReadable([
      "",
      "   ",
      JSON.stringify(makeInitFrame()),
      "",
      JSON.stringify({ type: "shutdown" }),
    ]);
    const { writable, frames } = makeWritable();
    await run(input, writable, "test-hash");
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.type).toBe("init_ok");
  });
});

describe("run — stdin EOF without shutdown", () => {
  it("returns cleanly when stdin closes", async () => {
    const input = makeReadable([JSON.stringify(makeInitFrame())]);
    const { writable, frames } = makeWritable();
    await expect(run(input, writable, "test-hash")).resolves.toBeUndefined();
    expect(frames().find((f) => f.type === "init_ok")).toBeDefined();
  });
});
