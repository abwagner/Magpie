#!/usr/bin/env node
// ── Gate Evaluator CLI ─────────────────────────────────────────────
// NDJSON subprocess interface for QO's BacktestEngine.
// Defined in: docs/tdd/backtest-gate.md §3
//
// stdin  — one JSON request frame per line (QO → CLI)
// stdout — one JSON reply frame per line   (CLI → QO)
// stderr — structured log frames (JSON, same logger contract as QF)

import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { createStderrLogger } from "../server/logger.js";
import { evaluate } from "../server/portfolio/evaluator.js";
import type { OrderIntent, Fill } from "../src/types/order.js";
import type { PortfolioState, RiskLimits } from "../src/types/portfolio.js";

// ── Version constants ──────────────────────────────────────────────

// Bump when the evaluator's input/output JSON shape changes (see §7).
export const EVALUATOR_SCHEMA_VERSION = 1;

// ── Frame type definitions ─────────────────────────────────────────

// Inbound frames (QO → CLI)

export interface InitFrame {
  type: "init";
  risk_limits: RiskLimits | null;
  portfolio_id: string;
  initial_cash: number;
  replay_start?: string;
  replay_end?: string;
}

export interface EvaluateFrame {
  type: "evaluate";
  intent_id: string;
  intent: OrderIntent;
}

export interface FillFrame {
  type: "fill";
  fill: Fill;
}

export interface SnapshotFrame {
  type: "snapshot";
  state: PortfolioState;
}

export interface ShutdownFrame {
  type: "shutdown";
}

export type InboundFrame = InitFrame | EvaluateFrame | FillFrame | SnapshotFrame | ShutdownFrame;

// Outbound frames (CLI → QO)

export interface InitOkFrame {
  type: "init_ok";
  evaluator_schema_version: number;
  commit_hash: string;
}

export interface InitErrorFrame {
  type: "init_error";
  reason: string;
}

export interface DecisionFrame {
  type: "decision";
  intent_id: string;
  decision: "approve" | "reject";
  reason: string;
  envelope_id?: string;
}

export type OutboundFrame = InitOkFrame | InitErrorFrame | DecisionFrame;

// ── Replay state ───────────────────────────────────────────────────

export function makeEmptyState(portfolioId: string, initialCash: number): PortfolioState {
  return {
    portfolio_id: portfolioId,
    cash: initialCash,
    positions: [],
    net_delta: 0,
    net_vega: 0,
    total_realized_pnl: 0,
    total_unrealized_pnl: 0,
    daily_realized_pnl: 0,
    equity: initialCash,
    peak_equity: initialCash,
    drawdown: 0,
    halted: false,
    data_stale: false,
  };
}

function recomputeAggregates(state: PortfolioState): void {
  let netDelta = 0;
  let netVega = 0;
  let totalUnrealized = 0;

  for (const pos of state.positions) {
    const sign = pos.direction === "Long" ? 1 : -1;
    netDelta += pos.delta * pos.quantity * sign;
    netVega += pos.vega * pos.quantity * sign;
    totalUnrealized += pos.unrealized_pnl;
  }

  state.net_delta = netDelta;
  state.net_vega = netVega;
  state.total_unrealized_pnl = totalUnrealized;
  state.equity = state.cash + totalUnrealized;

  if (state.equity > state.peak_equity) {
    state.peak_equity = state.equity;
  }
  state.drawdown = state.peak_equity - state.equity;
}

// Mirrors engine.ts applyFill without the logger / snapshot callbacks.
export function applyFillToState(state: PortfolioState, fill: Fill): void {
  const oppositeIdx = state.positions.findIndex(
    (p) => p.symbol === fill.symbol && p.direction !== fill.direction,
  );

  if (oppositeIdx !== -1) {
    const pos = state.positions[oppositeIdx]!;
    const pnl =
      (fill.price - pos.entry_price) * fill.quantity * (pos.direction === "Long" ? 1 : -1);
    state.total_realized_pnl += pnl - fill.fees;
    state.daily_realized_pnl += pnl - fill.fees;
    state.cash += fill.price * fill.quantity * (pos.direction === "Short" ? -1 : 1) - fill.fees;

    if (fill.quantity >= pos.quantity) {
      state.positions.splice(oppositeIdx, 1);
    } else {
      pos.quantity -= fill.quantity;
    }
  } else {
    // Derive underlying by stripping exchange prefix ("EQ:SPY" → "SPY").
    const underlying = fill.symbol.includes(":") ? fill.symbol.split(":")[1]! : fill.symbol;
    state.positions.push({
      position_id: fill.fill_id,
      symbol: fill.symbol,
      underlying,
      direction: fill.direction as "Long" | "Short",
      quantity: fill.quantity,
      entry_price: fill.price,
      entry_date: fill.filled_at,
      current_price: fill.price,
      unrealized_pnl: 0,
      delta: 1,
      gamma: 0,
      theta: 0,
      vega: 0,
    });
    state.cash -= fill.price * fill.quantity + fill.fees;
  }

  recomputeAggregates(state);
}

// ── Commit hash resolution ─────────────────────────────────────────

export function resolveCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ── I/O helpers ────────────────────────────────────────────────────

export function writeFrame(frame: OutboundFrame, out: NodeJS.WritableStream): void {
  out.write(JSON.stringify(frame) + "\n");
}

// ── Main loop ──────────────────────────────────────────────────────

export async function run(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  commitHash: string,
): Promise<void> {
  // All log levels route to stderr; stdout is the NDJSON protocol channel.
  const log = createStderrLogger("gate-evaluator-cli");

  let state: PortfolioState | null = null;
  let riskLimits: RiskLimits | null = null;
  let pendingOrders = 0;
  let initialized = false;

  const rl = createInterface({ input, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let frame: unknown;
    try {
      frame = JSON.parse(trimmed) as unknown;
    } catch (err) {
      log.error("frame.parse_error", { line: trimmed, err: String(err) });
      continue;
    }

    if (typeof frame !== "object" || frame === null || !("type" in frame)) {
      log.error("frame.invalid", { line: trimmed });
      continue;
    }

    const inbound = frame as InboundFrame;

    switch (inbound.type) {
      case "init": {
        if (initialized) {
          log.warn("init.duplicate", {});
          break;
        }
        riskLimits = inbound.risk_limits;
        state = makeEmptyState(inbound.portfolio_id, inbound.initial_cash);
        initialized = true;

        const ok: InitOkFrame = {
          type: "init_ok",
          evaluator_schema_version: EVALUATOR_SCHEMA_VERSION,
          commit_hash: commitHash,
        };
        writeFrame(ok, output);
        log.info("init.ok", {
          portfolio_id: inbound.portfolio_id,
          evaluator_schema_version: EVALUATOR_SCHEMA_VERSION,
          commit_hash: commitHash,
        });
        break;
      }

      case "evaluate": {
        if (!initialized || state === null) {
          log.error("evaluate.before_init", { intent_id: inbound.intent_id });
          break;
        }
        const result = evaluate(inbound.intent, state, riskLimits, pendingOrders);
        const decision: DecisionFrame = {
          type: "decision",
          intent_id: inbound.intent_id,
          decision: result.ok ? "approve" : "reject",
          reason: result.ok ? "approved" : result.violations.map((v) => v.limit).join(", "),
        };
        writeFrame(decision, output);
        if (result.ok) {
          pendingOrders += 1;
        }
        log.debug("evaluate.decision", {
          intent_id: inbound.intent_id,
          decision: decision.decision,
          violations: result.violations.length,
        });
        break;
      }

      case "fill": {
        if (!initialized || state === null) {
          log.error("fill.before_init", {});
          break;
        }
        applyFillToState(state, inbound.fill);
        // Decrement pending count when a fill settles an approved intent.
        if (pendingOrders > 0) pendingOrders -= 1;
        log.debug("fill.applied", {
          fill_id: inbound.fill.fill_id,
          symbol: inbound.fill.symbol,
        });
        break;
      }

      case "snapshot": {
        if (!initialized) {
          // Snapshot before init implies implicit init with the snapshot's portfolio.
          initialized = true;
          log.info("snapshot.implicit_init", {
            portfolio_id: inbound.state.portfolio_id,
          });
        }
        state = inbound.state;
        log.debug("snapshot.applied", {
          portfolio_id: state.portfolio_id,
          positions: state.positions.length,
        });
        break;
      }

      case "shutdown": {
        log.info("shutdown", {});
        return;
      }

      default: {
        // Exhaustiveness guard: `inbound` should be `never` here at compile time.
        const _exhaustive = inbound as never;
        log.warn("frame.unknown_type", { frame: JSON.stringify(_exhaustive) });
        break;
      }
    }
  }

  // stdin EOF without a shutdown frame — treat as clean exit.
  log.info("stdin.closed", {});
}

// ── CLI entry ──────────────────────────────────────────────────────

const commitHash = resolveCommitHash();
run(process.stdin, process.stdout, commitHash).then(() => process.exit(0));
