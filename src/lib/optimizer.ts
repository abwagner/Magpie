import { evalPortfolio } from "./eval.js";
import type { EvalPosition, EvalScenario, EvalResult } from "./eval.js";
import { log } from "./log.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChainOption {
  side: "call" | "put" | string;
  strike: number;
  bid?: number;
  ask?: number;
  mid?: number;
  last?: number;
  iv?: number;
  dte?: number;
  underlyingPrice?: number;
  volume?: number;
  openInterest?: number;
}

export interface OptimizerLeg extends EvalPosition {
  id: number;
  label: string;
  // makePosition always populates these, so narrow from EvalPosition's
  // optional option-fields to concrete numbers.
  type: "Call" | "Put";
  direction: "Long" | "Short";
  strike: number;
  entryPrice: number;
  dte: number;
  iv: number;
}

export interface Strategy {
  name: string;
  description: string;
  generate(chain: ChainOption[], spot: number): OptimizerLeg[][];
}

export interface OptimizeTarget {
  strategies: string[];
  optimizeFor?: "ev" | "probability" | string;
  maxDebit: number;
  maxLossPct: number;
  minReturnPct: number;
}

export interface OptimizeConfig {
  chain: ChainOption[];
  scenarios: EvalScenario[];
  spot: number;
  rfr: number;
  hold: number;
  existingPositions?: EvalPosition[];
  target: OptimizeTarget;
}

export interface OptimizeProgress {
  evaluated: number;
  total: number;
  phase: string;
}

export interface OptimizeResult {
  strategyKey: string;
  strategyName: string;
  legs: OptimizerLeg[];
  result: EvalResult;
  netDebit: number;
  returnProb: number;
  score: number;
}

function makePosition(
  opt: ChainOption,
  direction: "Long" | "Short",
  spot: number,
  dte?: number,
): OptimizerLeg {
  return {
    id: 0,
    type: opt.side === "call" ? "Call" : "Put",
    direction,
    qty: 1,
    multiplier: 100,
    entryPrice: spot,
    strike: opt.strike,
    premium:
      direction === "Long"
        ? opt.ask || opt.mid || opt.last || 0
        : opt.bid || opt.mid || opt.last || 0,
    dte: opt.dte || (dte as number),
    iv: opt.iv || 0.3,
    label: `${opt.strike}${opt.side === "call" ? "C" : "P"}`,
  };
}

export const STRATEGIES = {
  bull_call_spread: {
    name: "Bull Call Spread",
    description: "Long lower call + short higher call",
    generate(chain, spot) {
      const calls = chain
        .filter((c) => c.side === "call" && (c.bid ?? 0) > 0)
        .sort((a, b) => a.strike - b.strike);
      const candidates: OptimizerLeg[][] = [];
      for (let i = 0; i < calls.length; i++)
        for (let j = i + 1; j < calls.length; j++)
          candidates.push([
            makePosition(calls[i] as ChainOption, "Long", spot),
            makePosition(calls[j] as ChainOption, "Short", spot),
          ]);
      return candidates;
    },
  },
  bear_put_spread: {
    name: "Bear Put Spread",
    description: "Long higher put + short lower put",
    generate(chain, spot) {
      const puts = chain
        .filter((c) => c.side === "put" && (c.bid ?? 0) > 0)
        .sort((a, b) => a.strike - b.strike);
      const candidates: OptimizerLeg[][] = [];
      for (let i = 0; i < puts.length; i++)
        for (let j = i + 1; j < puts.length; j++)
          candidates.push([
            makePosition(puts[i] as ChainOption, "Short", spot),
            makePosition(puts[j] as ChainOption, "Long", spot),
          ]);
      return candidates;
    },
  },
  iron_condor: {
    name: "Iron Condor",
    description: "Short OTM put + long further OTM put + short OTM call + long further OTM call",
    generate(chain, spot) {
      const puts = chain
        .filter((c) => c.side === "put" && c.strike < spot && (c.bid ?? 0) > 0)
        .sort((a, b) => a.strike - b.strike);
      const calls = chain
        .filter((c) => c.side === "call" && c.strike > spot && (c.bid ?? 0) > 0)
        .sort((a, b) => a.strike - b.strike);
      const candidates: OptimizerLeg[][] = [];
      for (let pi = 0; pi < puts.length; pi++)
        for (let pj = pi + 1; pj < puts.length; pj++)
          for (let ci = 0; ci < calls.length; ci++)
            for (let cj = ci + 1; cj < calls.length; cj++) {
              candidates.push([
                makePosition(puts[pi] as ChainOption, "Long", spot), // long OTM put wing
                makePosition(puts[pj] as ChainOption, "Short", spot), // short OTM put
                makePosition(calls[ci] as ChainOption, "Short", spot), // short OTM call
                makePosition(calls[cj] as ChainOption, "Long", spot), // long OTM call wing
              ]);
              if (candidates.length > 5000) return candidates; // cap to avoid explosion
            }
      return candidates;
    },
  },
  long_call: {
    name: "Long Call",
    description: "Single long call",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "call" && (c.ask ?? 0) > 0)
        .map((c) => [makePosition(c, "Long", spot)]);
    },
  },
  long_put: {
    name: "Long Put",
    description: "Single long put",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "put" && (c.ask ?? 0) > 0)
        .map((c) => [makePosition(c, "Long", spot)]);
    },
  },
  short_call: {
    name: "Short Call",
    description: "Single short call (naked)",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "call" && (c.bid ?? 0) > 0)
        .map((c) => [makePosition(c, "Short", spot)]);
    },
  },
  short_put: {
    name: "Short Put",
    description: "Single short put (naked)",
    generate(chain, spot) {
      return chain
        .filter((c) => c.side === "put" && (c.bid ?? 0) > 0)
        .map((c) => [makePosition(c, "Short", spot)]);
    },
  },
  straddle: {
    name: "Long Straddle",
    description: "Long call + long put at same strike",
    generate(chain, spot) {
      const byStrike = new Map<number, Partial<Record<string, ChainOption>>>();
      chain.forEach((c) => {
        if (!byStrike.has(c.strike)) byStrike.set(c.strike, {});
        (byStrike.get(c.strike) as Record<string, ChainOption>)[c.side] = c;
      });
      const candidates: OptimizerLeg[][] = [];
      for (const [, opts] of byStrike) {
        if ((opts.call?.ask ?? 0) > 0 && (opts.put?.ask ?? 0) > 0) {
          candidates.push([
            makePosition(opts.call as ChainOption, "Long", spot),
            makePosition(opts.put as ChainOption, "Long", spot),
          ]);
        }
      }
      return candidates;
    },
  },
} satisfies Record<string, Strategy>;

function netDebit(legs: OptimizerLeg[]): number {
  return legs.reduce(
    (s, l) => s + (l.direction === "Long" ? -1 : 1) * l.premium * l.qty * l.multiplier,
    0,
  );
}

function score(result: EvalResult, returnProb: number, target: OptimizeTarget): number {
  const evWeight = target.optimizeFor === "ev" ? 0.6 : 0.3;
  const probWeight = target.optimizeFor === "probability" ? 0.6 : 0.3;
  const riskWeight = 0.1;
  const ev = result.totalEV;
  const risk = result.maxLoss !== 0 ? ev / Math.abs(result.maxLoss) : 0;
  return ev * evWeight + returnProb * 1000 * probWeight + risk * 100 * riskWeight;
}

export async function optimize(
  config: OptimizeConfig,
  onProgress?: (p: OptimizeProgress) => void,
): Promise<OptimizeResult[]> {
  const { chain, scenarios, spot, rfr, hold, existingPositions = [], target } = config;
  if (!chain?.length || !scenarios?.length) return [];

  const enabledStrategies = Object.entries(STRATEGIES).filter(([key]) =>
    target.strategies.includes(key),
  );

  let totalCandidates = 0;
  let evaluated = 0;
  const results: OptimizeResult[] = [];
  const t0 = Date.now();

  log(
    "info",
    `Optimizer: ${enabledStrategies.length} strategies, spot=$${spot}, ${scenarios.length} scenarios`,
  );

  for (const [key, strategy] of enabledStrategies) {
    const candidates = strategy.generate(chain, spot);
    totalCandidates += candidates.length;
    log("info", `${strategy.name}: ${candidates.length} candidates`);

    for (const legs of candidates) {
      const positions = [...existingPositions, ...legs];
      const result = evalPortfolio(positions, scenarios, spot, rfr, hold);
      const nd = netDebit(legs);

      // hard constraints
      if (target.maxDebit > 0 && Math.abs(nd) > target.maxDebit) {
        evaluated++;
        continue;
      }
      if (target.maxLossPct > 0 && result.maxLoss < -((target.maxLossPct / 100) * spot * 100)) {
        evaluated++;
        continue;
      }

      // probability of meeting return target
      const returnProb = result.scResults
        .filter((r) => r.pnl >= (target.minReturnPct / 100) * Math.abs(nd || 1))
        .reduce((s, r) => s + r.prob, 0);

      results.push({
        strategyKey: key,
        strategyName: strategy.name,
        legs,
        result,
        netDebit: nd,
        returnProb,
        score: score(result, returnProb, target),
      });

      evaluated++;
      if (evaluated % 200 === 0 && onProgress) {
        onProgress({ evaluated, total: totalCandidates, phase: strategy.name });
        // yield to UI
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  log(
    "info",
    `Optimizer done: ${evaluated} evaluated, ${results.length} passed constraints, ${elapsed}s`,
  );

  return results.slice(0, 50);
}
