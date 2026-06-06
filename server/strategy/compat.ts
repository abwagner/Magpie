// ── Legacy Strategy Wrapper ────────────────────────────────────────
// Wraps shouldEnter/shouldExit interface into canonical evaluate().
// Defined in: docs/tdd/strategy-layer.md, §2

// ── Types ──────────────────────────────────────────────────────────

export interface LegacyStrategy {
  name: string;
  shouldEnter(ctx: StrategyContext): LegacyEntry[];
  shouldExit(ctx: StrategyContext, openPositions: LegacyPosition[]): Array<string | number>;
  [key: string]: unknown;
}

export interface CanonicalStrategy {
  name: string;
  dependencies: StrategyDependencies;
  evaluate(ctx: StrategyContext): StrategyAction[];
}

export interface StrategyDependencies {
  signals?: string[];
  symbols?: string[];
}

export interface StrategyContext {
  spot: number;
  chain: ChainContract[];
  date: string;
  positions: ContextPosition[];
  cash: number;
  equity: number;
  mode: "live" | "backtest";
  signals?: Map<string, unknown>;
  [key: string]: unknown;
}

interface ChainContract {
  strike: number;
  side: "call" | "put";
  expiration: string;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  [key: string]: unknown;
}

interface LegacyEntry {
  strike: number;
  type: "Call" | "Put";
  direction: "Long" | "Short";
  qty: number;
  expiration: string;
}

interface LegacyPosition {
  id: string | number;
  strike: number;
  type: "Call" | "Put";
  direction: "Long" | "Short";
  expiration: string;
  [key: string]: unknown;
}

interface ContextPosition {
  position_id: string;
  symbol: string;
  strike?: number;
  type?: string;
  direction: string;
  expiration?: string;
  [key: string]: unknown;
}

// StrategyAction is now the canonical type defined in
// src/types/strategy.ts. Re-exported here so existing imports from
// server/strategy/compat.js keep working.
import type { StrategyAction } from "../../src/types/strategy.js";
export type { StrategyAction };

// ── Wrapper ────────────────────────────────────────────────────────

export function wrapLegacyStrategy(strategy: LegacyStrategy): CanonicalStrategy {
  return {
    name: strategy.name,
    dependencies: { signals: [], symbols: [] },

    evaluate(ctx: StrategyContext): StrategyAction[] {
      const actions: StrategyAction[] = [];

      // Close before open (matching backtest engine order)
      const legacyPositions: LegacyPosition[] = ctx.positions.map((p) => ({
        id: p.position_id,
        strike: p.strike ?? 0,
        type: (p.type as "Call" | "Put") ?? "Call",
        direction: p.direction as "Long" | "Short",
        expiration: p.expiration ?? "",
      }));

      const toClose = strategy.shouldExit(ctx, legacyPositions);
      for (const posId of toClose) {
        actions.push({
          action: "close",
          position_id: String(posId),
          reason: "strategy exit signal",
        });
      }

      // Open new positions
      const entries = strategy.shouldEnter(ctx);
      for (const entry of entries) {
        actions.push({
          action: "open",
          strike: entry.strike,
          type: entry.type,
          direction: entry.direction,
          qty: entry.qty,
          expiration: entry.expiration,
          reason: "strategy entry signal",
        });
      }

      return actions;
    },
  };
}

// ── Detection ──────────────────────────────────────────────────────

export function isLegacyStrategy(strategy: unknown): strategy is LegacyStrategy {
  if (typeof strategy !== "object" || strategy === null) return false;
  const s = strategy as Record<string, unknown>;
  return typeof s.shouldEnter === "function" && typeof s.shouldExit === "function";
}

export function isCanonicalStrategy(strategy: unknown): strategy is CanonicalStrategy {
  if (typeof strategy !== "object" || strategy === null) return false;
  const s = strategy as Record<string, unknown>;
  return typeof s.evaluate === "function";
}
