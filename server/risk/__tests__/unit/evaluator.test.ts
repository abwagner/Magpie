// QF-317 — cross-strategy aggregate evaluator (pure function).
//
// Covers each RejectionReason path:
//   - portfolio.halted        → limit_exceeded_portfolio
//   - strategy.state='halted' → strategy_halted
//   - missing snapshots       → config_invalid
//   - per-strategy max_quantity / max_notional / max_delta
//   - aggregate max_aggregate_delta (sums settled + pending + proposed)
//   - aggregate max_aggregate_notional
//   - concentration max_underlying_concentration
//   - approve path when all checks pass
//   - canonicalToUnderlying helper for OPT / FUT / equity symbols

import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  canonicalToUnderlying,
  type EvaluatorInput,
  type PortfolioSnapshot,
  type StrategySnapshot,
  type StrategyLimits,
  type PortfolioLimits,
} from "../../evaluator.js";
import type { GateRequest } from "../../gate-handler.js";
import type { PendingIntent } from "../../pending-intents.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    intent: {
      intent_id: "WILL_BE_REPLACED",
      portfolio: "main",
      strategy_id: "s-1",
      action: "open",
      symbol: "SPY",
      direction: "Long",
      quantity: 10,
      reason: "strategy_signal",
      signal_ids: [],
      created_at: "2026-05-29T17:00:00Z",
    },
    strategy_id: "s-1",
    portfolio_id: "main",
    current_position: null,
    account_balance: 100_000,
    asof: "2026-05-29T17:00:00Z",
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    portfolio_id: "main",
    halted: false,
    net_delta: 0,
    net_vega: 0,
    net_notional: 0,
    delta_by_underlying: {},
    ...overrides,
  };
}

function makeStrategy(overrides: Partial<StrategySnapshot> = {}): StrategySnapshot {
  return {
    strategy_id: "s-1",
    state: "running",
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingIntent> = {}): PendingIntent {
  return {
    intent_id: "P-1",
    strategy_id: "s-1",
    portfolio_id: "main",
    broker: "schwab",
    symbol: "SPY",
    side: "buy",
    qty: 5,
    remaining_qty: 5,
    estimated_notional: 0,
    estimated_delta: 5,
    asof: "2026-05-29T17:00:00Z",
    status: "pending",
    envelope_id: "P-1",
    ...overrides,
  };
}

function defaultInput(overrides: Partial<EvaluatorInput> = {}): EvaluatorInput {
  return {
    request: makeRequest(),
    portfolio: makePortfolio(),
    strategy: makeStrategy(),
    strategyLimits: null,
    portfolioLimits: null,
    pendingIntents: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("evaluateGate (QF-317)", () => {
  it("portfolio.halted → limit_exceeded_portfolio", () => {
    const r = evaluateGate(defaultInput({ portfolio: makePortfolio({ halted: true }) }));
    expect(r.decision).toBe("reject");
    expect(r.reason).toBe("limit_exceeded_portfolio");
  });

  it("strategy.state='halted' → strategy_halted", () => {
    const r = evaluateGate(defaultInput({ strategy: makeStrategy({ state: "halted" }) }));
    expect(r.decision).toBe("reject");
    expect(r.reason).toBe("strategy_halted");
  });

  it("portfolio halt outranks strategy halt", () => {
    const r = evaluateGate(
      defaultInput({
        portfolio: makePortfolio({ halted: true }),
        strategy: makeStrategy({ state: "halted" }),
      }),
    );
    expect(r.reason).toBe("limit_exceeded_portfolio");
  });

  it("missing portfolio snapshot → config_invalid", () => {
    const r = evaluateGate(defaultInput({ portfolio: null }));
    expect(r.reason).toBe("config_invalid");
  });

  it("missing strategy snapshot → config_invalid", () => {
    const r = evaluateGate(defaultInput({ strategy: null }));
    expect(r.reason).toBe("config_invalid");
  });

  // ── Per-strategy ──────────────────────────────────────────────────

  it("per-strategy max_quantity exceeded → limit_exceeded_per_strategy", () => {
    const lim: StrategyLimits = { max_quantity: 5 };
    const r = evaluateGate(defaultInput({ strategyLimits: lim }));
    expect(r.reason).toBe("limit_exceeded_per_strategy");
  });

  it("per-strategy max_notional honored when limit_price present", () => {
    const lim: StrategyLimits = { max_notional: 100 };
    const req = makeRequest({
      intent: {
        ...makeRequest().intent,
        order_type: "limit",
        limit_price: 50,
        quantity: 10,
      },
    });
    const r = evaluateGate(defaultInput({ request: req, strategyLimits: lim }));
    expect(r.reason).toBe("limit_exceeded_per_strategy");
  });

  it("per-strategy max_notional skips check when no limit_price (market order)", () => {
    const lim: StrategyLimits = { max_notional: 100 };
    const r = evaluateGate(defaultInput({ strategyLimits: lim }));
    expect(r.decision).toBe("approve");
  });

  it("per-strategy max_delta exceeded → limit_exceeded_per_strategy", () => {
    const lim: StrategyLimits = { max_delta: 5 };
    const r = evaluateGate(defaultInput({ strategyLimits: lim }));
    expect(r.reason).toBe("limit_exceeded_per_strategy");
  });

  // ── Aggregates ────────────────────────────────────────────────────

  it("aggregate delta sums settled + pending + proposed", () => {
    const portfolio = makePortfolio({ net_delta: 4 });
    const pending = [makePending({ estimated_delta: 3 })];
    const portfolioLimits: PortfolioLimits = { max_aggregate_delta: 10 };
    // 4 + 3 + 10 (proposed) = 17 > 10 → reject
    const r = evaluateGate(defaultInput({ portfolio, pendingIntents: pending, portfolioLimits }));
    expect(r.reason).toBe("limit_exceeded_aggregate");
  });

  it("aggregate delta allows when sum is within budget", () => {
    const portfolio = makePortfolio({ net_delta: -5 });
    const pending = [makePending({ estimated_delta: -3 })];
    const portfolioLimits: PortfolioLimits = { max_aggregate_delta: 10 };
    // -5 + -3 + 10 (proposed Long) = 2; |2| <= 10 → approve
    const r = evaluateGate(defaultInput({ portfolio, pendingIntents: pending, portfolioLimits }));
    expect(r.decision).toBe("approve");
  });

  it("aggregate notional sums settled + pending + proposed", () => {
    const req = makeRequest({
      intent: {
        ...makeRequest().intent,
        order_type: "limit",
        limit_price: 100,
        quantity: 2,
      },
    });
    const portfolio = makePortfolio({ net_notional: 500 });
    const pending = [makePending({ estimated_notional: 300 })];
    const portfolioLimits: PortfolioLimits = { max_aggregate_notional: 900 };
    // 500 + 300 + 200 = 1000 > 900 → reject
    const r = evaluateGate(
      defaultInput({ request: req, portfolio, pendingIntents: pending, portfolioLimits }),
    );
    expect(r.reason).toBe("limit_exceeded_aggregate");
  });

  // ── Concentration ────────────────────────────────────────────────

  it("concentration trip on OPT underlying derived from canonical symbol", () => {
    const req = makeRequest({
      intent: {
        ...makeRequest().intent,
        symbol: "OPT:SPY:2026-06-19:C:500",
        direction: "Long",
        quantity: 6,
      },
    });
    const portfolio = makePortfolio({ delta_by_underlying: { SPY: 5 } });
    const portfolioLimits: PortfolioLimits = { max_underlying_concentration: 10 };
    // SPY settled = 5; proposed = +6 (long); total = 11 > 10 → reject
    const r = evaluateGate(defaultInput({ request: req, portfolio, portfolioLimits }));
    expect(r.reason).toBe("concentration");
  });

  it("concentration only sums same-underlying pending intents", () => {
    const req = makeRequest({
      intent: { ...makeRequest().intent, symbol: "QQQ", quantity: 6 },
    });
    const portfolio = makePortfolio({ delta_by_underlying: { QQQ: 0, SPY: 100 } });
    const pending = [makePending({ symbol: "SPY", remaining_qty: 50, side: "buy" })];
    const portfolioLimits: PortfolioLimits = { max_underlying_concentration: 10 };
    // QQQ settled=0, no QQQ pending, proposed=6; |6|<=10 → approve.
    // The SPY pending intent should not affect QQQ concentration.
    const r = evaluateGate(
      defaultInput({
        request: req,
        portfolio,
        pendingIntents: pending,
        portfolioLimits,
      }),
    );
    expect(r.decision).toBe("approve");
  });

  // ── Approve path ──────────────────────────────────────────────────

  it("returns approve when no limits configured and state is clean", () => {
    const r = evaluateGate(defaultInput());
    expect(r).toEqual({ decision: "approve", reason: null });
  });

  // ── Decision precedence ──────────────────────────────────────────

  it("per-strategy miss outranks aggregate miss (first miss wins)", () => {
    const strategyLimits: StrategyLimits = { max_quantity: 5 };
    const portfolioLimits: PortfolioLimits = { max_aggregate_delta: 0 };
    const r = evaluateGate(defaultInput({ strategyLimits, portfolioLimits }));
    expect(r.reason).toBe("limit_exceeded_per_strategy");
  });
});

describe("canonicalToUnderlying (QF-317)", () => {
  it("strips OPT canonical prefix", () => {
    expect(canonicalToUnderlying("OPT:SPY:2026-06-19:C:500")).toBe("SPY");
  });
  it("strips FUT canonical prefix", () => {
    expect(canonicalToUnderlying("FUT:ES:2026-06-19")).toBe("ES");
  });
  it("passes equity symbols through unchanged", () => {
    expect(canonicalToUnderlying("AAPL")).toBe("AAPL");
  });
});
