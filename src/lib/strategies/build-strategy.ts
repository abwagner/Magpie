// ── Strategy builder ─────────────────────────────────────────────────
// Resolve a StrategyTemplate's relative leg selectors against live chains
// into concrete contracts, then attach combined analytics. Pure: no I/O.

import type { Contract } from "../../types/market-data.js";
import type {
  BuiltStrategy,
  ChainsByExpiration,
  ExpirationSelector,
  LegTemplate,
  ResolvedLeg,
  StrategyTemplate,
  StrikeSelector,
} from "../../types/option-strategy.js";
import { StrategyBuildError } from "../../types/option-strategy.js";
import { computeAnalytics } from "./strategy-analytics.js";

export interface BuildOptions {
  // Operator-selected expirations, near → far. Must have at least
  // template.expirationsRequired entries.
  expirations: string[];
  // Optional per-leg absolute strike override, keyed by leg index. The
  // nearest available strike on that leg's chain is used.
  strikeOverrides?: Record<number, number>;
  // Contract multiplier for P/L (default 100; CL futures options = 1000).
  multiplier?: number;
}

function resolveExpiration(sel: ExpirationSelector, expirations: string[]): string {
  switch (sel.kind) {
    case "front":
      return expirations[0]!;
    case "back":
      return expirations[expirations.length - 1]!;
    case "index": {
      const e = expirations[sel.index];
      if (e === undefined) {
        throw new StrategyBuildError(`expiration index ${sel.index} out of range`);
      }
      return e;
    }
    case "absolute":
      return sel.expiration;
  }
}

// Sorted unique strike ladder for a single right within one expiration.
function strikeLadder(contracts: Contract[]): number[] {
  return [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);
}

function nearestIndex(ladder: number[], target: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(ladder[i]! - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function resolveStrike(
  sel: StrikeSelector,
  contracts: Contract[],
  override: number | undefined,
): number {
  const ladder = strikeLadder(contracts);
  if (ladder.length === 0) throw new StrategyBuildError("no strikes available for leg");
  const spot = contracts[0]!.underlyingPrice;

  if (override !== undefined) return ladder[nearestIndex(ladder, override)]!;

  switch (sel.kind) {
    case "absolute":
      return ladder[nearestIndex(ladder, sel.strike)]!;
    case "atm":
      return ladder[nearestIndex(ladder, spot)]!;
    case "offset": {
      const atmIdx = nearestIndex(ladder, spot);
      const idx = Math.max(0, Math.min(ladder.length - 1, atmIdx + sel.steps));
      return ladder[idx]!;
    }
    case "delta": {
      // Nearest |delta| to target among this right's contracts.
      let best = contracts[0]!;
      let bestDist = Infinity;
      for (const c of contracts) {
        const d = Math.abs(Math.abs(c.delta) - Math.abs(sel.target));
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      return best.strike;
    }
  }
}

function pickContract(contracts: Contract[], right: LegTemplate["right"], strike: number): Contract {
  const match = contracts.find((c) => c.side === right && c.strike === strike);
  if (!match) {
    throw new StrategyBuildError(`no ${right} contract at strike ${strike}`);
  }
  return match;
}

export function buildStrategy(
  template: StrategyTemplate,
  chains: ChainsByExpiration,
  opts: BuildOptions,
): BuiltStrategy {
  if (opts.expirations.length < template.expirationsRequired) {
    throw new StrategyBuildError(
      `${template.label} needs ${template.expirationsRequired} expiration(s), got ${opts.expirations.length}`,
    );
  }

  const legs: ResolvedLeg[] = template.legs.map((lt, i) => {
    const expiration = resolveExpiration(lt.expiration, opts.expirations);
    const chain = chains.get(expiration);
    if (!chain || chain.length === 0) {
      throw new StrategyBuildError(`no chain for expiration ${expiration}`);
    }
    const ofRight = chain.filter((c) => c.side === lt.right);
    if (ofRight.length === 0) {
      throw new StrategyBuildError(`no ${lt.right} contracts for ${expiration}`);
    }
    const strike = resolveStrike(lt.strike, ofRight, opts.strikeOverrides?.[i]);
    return { right: lt.right, side: lt.side, ratio: lt.ratio, contract: pickContract(ofRight, lt.right, strike) };
  });

  const underlying = legs[0]!.contract.underlying;
  return {
    kind: template.kind,
    label: template.label,
    underlying,
    legs,
    analytics: computeAnalytics(legs, opts.multiplier),
  };
}
