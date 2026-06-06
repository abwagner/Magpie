// ── Greek-Constrained LP Optimizer ──────────────────────────────────────
// Builds the Greek Builder LP model from a chain, then hands the model to
// a caller-injected solver (the qf-optimizer WASM module from QF-133 is
// the only consumer today; see src/lib/greek-builder-worker.ts). The
// solver shape matches javascript-lp-solver's `.Solve(model)` contract so
// the worker's WASM adapter is a thin shim.
//
// QF-135 dropped javascript-lp-solver from the dependencies; `solveLP` and
// `optimizePortfolio` from the original file are also gone (no live
// callers — they were superseded by the Web Worker path).
//
// QF-344 fixed the mode-min LP objective bug: "min" mode is now a
// near-zero constraint (same bounds as "flat"), not a negative objective
// weight. Only "max" contributes to the LP objective.

import { BS, Black76 } from "./bs.js";
import { log } from "./log.js";
import {
  candidateMargin as candidateMarginFn,
  computePortfolioMargin as computePortfolioMarginFn,
} from "./margin.js";

// ── Types ───────────────────────────────────────────────────────────────

export type GreekMode = "max" | "min" | "flat" | "bound" | "any";
export type AssetClass = "equity" | "futures";

export interface GreekModes {
  delta: GreekMode;
  gamma: GreekMode;
  theta: GreekMode;
  vega: GreekMode;
}

export interface GreekBounds {
  deltaMin?: number;
  deltaMax?: number;
  gammaMin?: number;
  gammaMax?: number;
  thetaMin?: number;
  thetaMax?: number;
  vegaMin?: number;
  vegaMax?: number;
}

export interface ChainContract {
  side: "call" | "put";
  strike: number;
  bid?: number;
  ask?: number;
  mid?: number;
  last?: number;
  iv: number;
  dte?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  underlyingPrice?: number;
}

export interface Candidate {
  id: string;
  label: string;
  type: "Call" | "Put";
  direction: "Long" | "Short";
  strike: number;
  premium: number;
  dte: number;
  iv: number;
  multiplier: number;
  assetClass: AssetClass;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  expectedPnL: number;
  cost: number;
  maxLoss: number;
}

export interface GreekBuilderCandidate {
  id: string;
  side: "call" | "put";
  strike: number;
  direction: "long" | "short";
  premium: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rawDelta: number;
  rawGamma: number;
  rawTheta: number;
  rawVega: number;
  cost: number;
  margin: number;
}

export interface Position extends GreekBuilderCandidate {
  qty: number;
}

export interface ModelPDF {
  strikes: number[];
  density: number[];
  strikeStep?: number;
}

export interface GenerateCandidatesOptions {
  multiplier?: number;
  assetClass?: AssetClass;
}

export interface SolveGreekBuilderOptions {
  modes?: GreekModes;
  bounds?: GreekBounds;
  maxBudget?: number;
  maxLegs?: number;
  spot?: number | null;
  assetClass?: AssetClass;
}

export interface SolveGreekBuilderResult {
  positions: Position[];
  totals?: GreekTotals;
  feasible: boolean;
  reason?: string;
  strategyLabel?: string;
}

export interface GreekTotals {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  cost: number;
  margin: number;
  perLegMargin: number;
  contracts: number;
}

// Solver interface (javascript-lp-solver shape)
export interface LpModel {
  optimize: string;
  opType: "max";
  constraints: Record<string, { min?: number; max?: number }>;
  variables: Record<string, Record<string, number>>;
  ints: Record<string, number>;
}

export interface LpResult {
  feasible: boolean;
  result?: number;
  bounded?: boolean;
  [varName: string]: number | boolean | undefined;
}

export interface Solver {
  Solve(model: LpModel): LpResult;
}

export interface StrategyLeg {
  type: "Call" | "Put";
  direction: "Long" | "Short";
  strike: number;
  qty: number;
}

export interface ScenarioProfile {
  direction: "bullish" | "bearish" | "neutral";
  volView: "rising" | "falling" | "neutral";
}

export interface ConstraintsFromProfile {
  deltaTolerance: number;
  vegaTolerance: number;
  targetGamma: null;
  gammaTolerance: null;
  targetTheta: null;
  thetaTolerance: null;
  targetDelta: number;
  targetVega: number;
}

export interface Preset {
  name: string;
  direction: ScenarioProfile["direction"];
  volView: ScenarioProfile["volView"];
  description: string;
}

export interface GreekBuilderPreset {
  label: string;
  modes: GreekModes;
  bounds: GreekBounds;
}

// ── Candidate Generation ────────────────────────────────────────────────
// Generate all candidate positions from chain data.
// Each candidate is a single contract (long or short) with pre-computed Greeks and P&L.
// options.multiplier: contract multiplier (100 for equities, 1000 for /CL, etc.)
// options.assetClass: "equity" or "futures" — determines pricing model
export function generateCandidates(
  chain: ChainContract[],
  spot: number,
  rfr: number,
  dte: number,
  modelPDF: ModelPDF | null | undefined,
  { multiplier = 100, assetClass = "equity" as AssetClass }: GenerateCandidatesOptions = {},
): Candidate[] {
  const T = Math.max(dte / 365, 1 / 365);
  const pm = assetClass === "futures" ? Black76 : BS;
  const mult = multiplier;
  const candidates: Candidate[] = [];

  for (const contract of chain) {
    if (!contract.iv || contract.iv <= 0) continue;
    const type = contract.side === "call" ? "Call" : ("Put" as "Call" | "Put");

    for (const direction of ["Long", "Short"] as const) {
      const dir = direction === "Long" ? 1 : -1;
      const premium =
        direction === "Long"
          ? contract.ask || contract.mid || contract.last || 0
          : contract.bid || contract.mid || contract.last || 0;

      if (premium <= 0) continue;

      const delta = dir * pm.delta(spot, contract.strike, rfr, T, contract.iv, type);
      const gamma = dir * pm.gamma(spot, contract.strike, rfr, T, contract.iv);
      const theta = dir * pm.theta(spot, contract.strike, rfr, T, contract.iv, type);
      const vega = dir * pm.vega(spot, contract.strike, rfr, T, contract.iv);

      // compute expected P&L using model PDF
      let expectedPnL = 0;
      if (modelPDF?.strikes?.length) {
        const step = modelPDF.strikeStep || 0.5;
        for (let i = 0; i < modelPDF.strikes.length; i++) {
          const futureSpot = modelPDF.strikes[i] ?? 0;
          const prob = (modelPDF.density[i] ?? 0) * step;
          const intrinsic =
            type === "Call"
              ? Math.max(0, futureSpot - contract.strike)
              : Math.max(0, contract.strike - futureSpot);
          const pnl = dir * (intrinsic - premium) * mult;
          expectedPnL += prob * pnl;
        }
      }

      // max loss for this single contract
      const maxLoss =
        direction === "Long"
          ? -premium * mult
          : type === "Call"
            ? -Infinity
            : -(contract.strike - premium) * mult;

      candidates.push({
        id: `${direction[0]}_${type[0]}_${contract.strike}`,
        label: `${direction === "Long" ? "+" : "-"}${contract.strike}${type[0]}`,
        type,
        direction,
        strike: contract.strike,
        premium,
        dte,
        iv: contract.iv,
        multiplier: mult,
        assetClass,
        delta: delta * mult,
        gamma: gamma * mult,
        theta: theta * mult,
        vega: vega * mult,
        expectedPnL,
        cost: dir * premium * mult,
        maxLoss,
      });
    }
  }

  return candidates;
}

// ── Pattern Labeling ────────────────────────────────────────────────────
// Identify known strategy patterns in LP results.
export function labelStrategy(positions: StrategyLeg[]): string {
  if (!positions.length) return "Empty";

  const legs = positions.map((p) => ({
    type: p.type,
    direction: p.direction,
    strike: p.strike,
    qty: p.qty,
  }));

  // sort by strike
  legs.sort((a, b) => a.strike - b.strike);

  if (legs.length === 1) {
    const l = legs[0]!;
    return `${l.direction} ${l.type}`;
  }

  if (legs.length === 2) {
    const [a, b] = legs as [StrategyLeg, StrategyLeg];
    // vertical spread
    if (a.type === b.type && a.direction !== b.direction) {
      if (a.type === "Call") {
        return a.direction === "Long" ? "Bull Call Spread" : "Bear Call Spread";
      } else {
        return b.direction === "Long" ? "Bear Put Spread" : "Bull Put Spread";
      }
    }
    // straddle
    if (a.strike === b.strike && a.type !== b.type && a.direction === b.direction) {
      return `${a.direction} Straddle`;
    }
    // strangle
    if (a.type !== b.type && a.direction === b.direction && a.strike !== b.strike) {
      return `${a.direction} Strangle`;
    }
  }

  if (legs.length === 4) {
    const puts = legs.filter((l) => l.type === "Put");
    const calls = legs.filter((l) => l.type === "Call");
    // iron condor: 2 puts + 2 calls, mixed directions
    if (puts.length === 2 && calls.length === 2) {
      const putDirs = new Set(puts.map((p) => p.direction));
      const callDirs = new Set(calls.map((p) => p.direction));
      if (putDirs.size === 2 && callDirs.size === 2) {
        return "Iron Condor";
      }
    }
    // butterfly: 3 same type with specific structure
    const types = new Set(legs.map((l) => l.type));
    if (types.size === 1) {
      return `${legs[0]!.type} Butterfly`;
    }
  }

  return `Custom (${legs.length} legs)`;
}

// ── Scenario Profiles ───────────────────────────────────────────────────
// Map human-readable views to LP constraints.
// direction: "bullish" | "bearish" | "neutral"
// volView: "rising" | "falling" | "neutral"
// These set delta and vega targets. Budget, maxLoss, maxPositions are user inputs.
export function profileToConstraints(profile: ScenarioProfile): ConstraintsFromProfile {
  const base = {
    deltaTolerance: 200,
    vegaTolerance: 200,
    targetGamma: null as null,
    gammaTolerance: null as null,
    targetTheta: null as null,
    thetaTolerance: null as null,
  };

  // Direction → delta target
  const deltaMap: Record<string, number> = {
    bullish: 300,
    bearish: -300,
    neutral: 0,
  };

  // Vol view → vega target
  const vegaMap: Record<string, number> = {
    rising: 300, // long vol
    falling: -300, // short vol
    neutral: 0,
  };

  return {
    ...base,
    targetDelta: deltaMap[profile.direction] ?? 0,
    targetVega: vegaMap[profile.volView] ?? 0,
  };
}

export const PROFILE_PRESETS: Record<string, Preset> = {
  "sell-premium-neutral": {
    name: "Sell Premium, Neutral",
    direction: "neutral",
    volView: "falling",
    description: "Iron condors, strangles — collect theta, neutral direction",
  },
  "bullish-defined-risk": {
    name: "Bullish, Defined Risk",
    direction: "bullish",
    volView: "neutral",
    description: "Bull call spreads, debit spreads — bounded downside",
  },
  "bearish-hedge": {
    name: "Bearish Hedge",
    direction: "bearish",
    volView: "neutral",
    description: "Put spreads, collars — protect against downside",
  },
  "long-vol": {
    name: "Long Volatility",
    direction: "neutral",
    volView: "rising",
    description: "Straddles, strangles — profit from big moves either way",
  },
  custom: {
    name: "Custom",
    direction: "neutral",
    volView: "neutral",
    description: "Set all Greek targets manually",
  },
};

// ── Greek Builder Constants ─────────────────────────────────────────────
// Default bounds for "flat" and "min" modes — constrains a greek near zero.
// Per-contract aggregate scale (matches staged NET row).
// Scaled by maxLegs/2 in the solver so larger positions get proportionally
// wider bounds (6 legs can have 3× the theta of 2 legs and still be "flat").
//
// "min" and "flat" use these same bounds (QF-344: "min" is a near-zero
// constraint, not a negative objective weight).
const FLAT_BOUNDS_PER_LOT: Record<string, { min: number; max: number }> = {
  delta: { min: -0.15, max: 0.15 },
  gamma: { min: -0.06, max: 0.06 },
  theta: { min: -0.06, max: 0.06 },
  vega: { min: -0.25, max: 0.25 },
};

// ── Greek Builder Presets ───────────────────────────────────────────────
// Modes: "max" | "min" | "flat" | "bound" | "any"
//   max   = LP objective, push positive
//   min   = constraint near zero (same as flat — QF-344 fix)
//   flat  = constraint near zero (auto-bounds from FLAT_BOUNDS)
//   bound = user-defined min/max constraint
//   any   = unconstrained (auto-constraints may upgrade)
export const GREEK_BUILDER_PRESETS: Record<string, GreekBuilderPreset> = {
  "max-gamma-neutral": {
    label: "Max Γ Neutral",
    modes: { delta: "flat", gamma: "max", theta: "flat", vega: "flat" },
    bounds: {},
  },
  "max-gamma-min-theta": {
    label: "Max Γ, Min Θ Drag",
    modes: { delta: "flat", gamma: "max", theta: "max", vega: "flat" },
    bounds: {},
  },
  "sell-premium": {
    label: "Sell Premium",
    modes: { delta: "flat", gamma: "flat", theta: "max", vega: "flat" },
    bounds: {},
  },
  "long-vol": {
    label: "Long Vol",
    modes: { delta: "flat", gamma: "flat", theta: "flat", vega: "max" },
    bounds: {},
  },
  bullish: {
    label: "Bullish",
    modes: { delta: "max", gamma: "flat", theta: "any", vega: "any" },
    bounds: {},
  },
};

// ── Auto-Constraints ───────────────────────────────────────────────────
// Apply sensible defaults when key greeks are left as "any".
export function applyAutoConstraints(
  modes: GreekModes,
  bounds: GreekBounds,
): { modes: GreekModes; bounds: GreekBounds } {
  const effModes = { ...modes };
  const effBounds = { ...bounds };

  const hasMaxOrMin = (["gamma", "theta", "vega"] as const).some(
    (g) => effModes[g] === "max" || effModes[g] === "min",
  );

  // Auto delta flat when optimizing non-delta greeks
  if (hasMaxOrMin && effModes.delta === "any") {
    effModes.delta = "flat";
  }

  // Auto gamma flat when selling premium
  if (effModes.theta === "max" && effModes.gamma === "any") {
    effModes.gamma = "flat";
  }

  // Auto gamma flat for directional delta
  if ((effModes.delta === "max" || effModes.delta === "min") && effModes.gamma === "any") {
    effModes.gamma = "flat";
  }

  return { modes: effModes, bounds: effBounds };
}

// ── Greek Builder Solver ───────────────────────────────────────────────
// Modes per greek:
//   max   → LP objective (only Max contributes to objective)
//   min   → constraint near zero (same bounds as "flat") — QF-344 fix
//   flat  → constraint near zero (FLAT_BOUNDS)
//   bound → user-provided min/max constraint
//   any   → unconstrained
// Uses margin-based budget and two-pass portfolio margin reconciliation.
//
// `solver` is required. Pass any object with a `.Solve(model)` method
// that returns `{ feasible, result, <varName>: <qty>, ... }` (the
// javascript-lp-solver shape). The Web Worker injects the qf-optimizer
// WASM module wrapped in such an adapter.
export function solveGreekBuilder(
  chain: ChainContract[],
  options: SolveGreekBuilderOptions = {},
  solver: Solver,
): SolveGreekBuilderResult {
  if (!solver || typeof solver.Solve !== "function") {
    throw new Error("solveGreekBuilder: `solver` is required (must implement .Solve(model))");
  }
  const {
    modes = { delta: "min", gamma: "max", theta: "min", vega: "min" },
    bounds = {},
    maxBudget = 5000,
    maxLegs = 6,
    spot = null,
    assetClass = "equity",
  } = options;

  // Validate: at least one greek must be "max" to define an LP objective.
  // "min" is now a near-zero constraint (QF-344 fix), not an objective.
  const hasObjective = Object.values(modes).some((m) => m === "max");
  if (!hasObjective) {
    return { positions: [], feasible: false, reason: "Set at least one greek to Max" };
  }

  const { modes: effModes, bounds: effBounds } = applyAutoConstraints(modes, bounds);

  // Derive spot from chain if not provided
  const effectiveSpot = spot ?? chain[0]?.underlyingPrice ?? 100;

  // Build candidates: long and short for each contract
  // Prune: skip options with negligible greeks (deep OTM/ITM waste solver time)
  const candidates: GreekBuilderCandidate[] = [];
  for (const opt of chain) {
    if (!opt.iv || opt.iv <= 0) continue;
    if (opt.delta == null && opt.gamma == null) continue;
    const mid = opt.mid || opt.last || 0;
    if (mid <= 0) continue;
    // Skip options with negligible gamma+vega (deep ITM/OTM)
    if (Math.abs(opt.gamma || 0) < 0.001 && Math.abs(opt.vega || 0) < 0.01) continue;

    for (const dir of [1, -1]) {
      const price = dir === 1 ? opt.ask || mid : opt.bid || mid;
      if (price <= 0) continue;

      const direction = dir > 0 ? "long" : ("short" as "long" | "short");
      const mult = 100;
      const margin = candidateMarginFn(
        opt.strike,
        effectiveSpot,
        price,
        mult,
        opt.side,
        direction,
        assetClass,
      );

      candidates.push({
        id: `${dir > 0 ? "L" : "S"}_${opt.side[0]}_${opt.strike}`,
        side: opt.side,
        strike: opt.strike,
        direction,
        premium: price,
        iv: opt.iv,
        delta: (opt.delta || 0) * dir,
        gamma: (opt.gamma || 0) * dir,
        theta: (opt.theta || 0) * dir,
        vega: (opt.vega || 0) * dir,
        rawDelta: opt.delta || 0,
        rawGamma: opt.gamma || 0,
        rawTheta: opt.theta || 0,
        rawVega: opt.vega || 0,
        cost: dir * price * mult,
        margin,
      });
    }
  }

  if (!candidates.length) {
    return { positions: [], feasible: false, reason: "No valid candidates in chain" };
  }

  // Pass 1: solve with per-leg margin
  const pass1 = solveGreekLP(candidates, effModes, effBounds, maxBudget, maxLegs, solver);
  if (!pass1.feasible) return pass1;

  // Pass 2: compute portfolio margin, check for freed capital
  const perLegMargin = pass1.positions.reduce((s, p) => s + p.margin * p.qty, 0);
  const portMargin = computePortfolioMarginFn(pass1.positions, effectiveSpot, assetClass);
  const freed = perLegMargin - portMargin;

  if (freed > perLegMargin * 0.1 && freed > 100) {
    const pass2 = solveGreekLP(candidates, effModes, effBounds, maxBudget + freed, maxLegs, solver);
    if (pass2.feasible) {
      const pm2 = computePortfolioMarginFn(pass2.positions, effectiveSpot, assetClass);
      if (pm2 <= maxBudget) {
        log("info", `Greek builder pass 2: freed $${freed.toFixed(0)} via spread netting`);
        return formatResult(pass2, pm2);
      }
    }
  }

  return formatResult(pass1, portMargin);
}

// ── LP Solve (single pass) ─────────────────────────────────────────────
interface SolvePassResult {
  positions: Position[];
  feasible: boolean;
  reason?: string;
}

function solveGreekLP(
  candidates: GreekBuilderCandidate[],
  effModes: GreekModes,
  effBounds: GreekBounds,
  budget: number,
  maxLegs: number,
  solver: Solver,
): SolvePassResult {
  const greekNames = ["delta", "gamma", "theta", "vega"] as const;
  type GreekName = (typeof greekNames)[number];

  // Only "max" mode contributes to LP objective (QF-344 fix: "min" is a
  // constraint, not a negative objective weight).
  const objGreeks: Array<{ name: GreekName; sign: 1; scale: number }> = [];
  for (const name of greekNames) {
    if (effModes[name] === "max") objGreeks.push({ name, sign: 1, scale: 1 });
  }

  // Normalize scales so greeks contribute equally
  for (const og of objGreeks) {
    const maxVal = Math.max(...candidates.map((c) => Math.abs(c[og.name])));
    og.scale = maxVal > 0 ? 1 / maxVal : 1;
  }

  // Scale flat/min bounds by position size so larger accounts can hold larger positions
  const lotScale = Math.max(maxLegs / 2, 1);

  const model: LpModel = {
    optimize: "objValue",
    opType: "max",
    constraints: {},
    variables: {},
    ints: {},
  };

  // Greek constraints:
  //   "flat" and "min" → near-zero bounds from FLAT_BOUNDS_PER_LOT (QF-344 fix)
  //   "bound" → user-provided bounds
  for (const name of greekNames) {
    const bounds = FLAT_BOUNDS_PER_LOT[name];
    if (!bounds) continue;
    if (effModes[name] === "flat" || effModes[name] === "min") {
      // Both "flat" and "min" enforce a near-zero constraint.
      // Pre-QF-344, "min" was wired as a negative LP objective weight;
      // this was wrong — users expect "min delta" = "delta near zero."
      model.constraints[`${name}LB`] = { min: bounds.min * lotScale };
      model.constraints[`${name}UB`] = { max: bounds.max * lotScale };
    } else if (effModes[name] === "bound") {
      const boundsRecord = effBounds as Record<string, number | undefined>;
      if (boundsRecord[`${name}Min`] != null)
        model.constraints[`${name}LB`] = { min: boundsRecord[`${name}Min`] };
      if (boundsRecord[`${name}Max`] != null)
        model.constraints[`${name}UB`] = { max: boundsRecord[`${name}Max`] };
    }
  }

  // Margin budget and position count
  model.constraints["marginBudget"] = { max: budget };
  model.constraints["posCount"] = { max: maxLegs };

  for (const cand of candidates) {
    let objValue = 0;
    for (const og of objGreeks) {
      objValue += og.sign * cand[og.name] * og.scale;
    }

    const vars: Record<string, number> = {
      objValue,
      marginBudget: cand.margin,
      posCount: 1,
    };
    for (const name of greekNames) {
      if (model.constraints[`${name}LB`]) vars[`${name}LB`] = cand[name];
      if (model.constraints[`${name}UB`]) vars[`${name}UB`] = cand[name];
    }
    model.variables[cand.id] = vars;
    // No integer constraints — solve continuous LP (fast), round afterward
  }

  const result = solver.Solve(model);

  if (!result.feasible) {
    return {
      positions: [],
      feasible: false,
      reason: "No feasible solution — try relaxing bounds or increasing budget",
    };
  }

  // Round continuous solution to integers
  const positions: Position[] = [];
  for (const cand of candidates) {
    const raw = (result[cand.id] as number | undefined) ?? 0;
    const qty = Math.round(raw);
    if (qty > 0) positions.push({ ...cand, qty });
  }

  return { positions, feasible: true };
}

// ── Format Result ──────────────────────────────────────────────────────
function formatResult(
  solveResult: SolvePassResult,
  portfolioMargin: number,
): SolveGreekBuilderResult {
  const { positions } = solveResult;

  const totals: GreekTotals = {
    delta: positions.reduce((s, p) => s + p.delta * p.qty, 0),
    gamma: positions.reduce((s, p) => s + p.gamma * p.qty, 0),
    theta: positions.reduce((s, p) => s + p.theta * p.qty, 0),
    vega: positions.reduce((s, p) => s + p.vega * p.qty, 0),
    cost: positions.reduce((s, p) => s + p.cost * p.qty, 0),
    margin: portfolioMargin,
    perLegMargin: positions.reduce((s, p) => s + p.margin * p.qty, 0),
    contracts: positions.reduce((s, p) => s + p.qty, 0),
  };

  const strategyLabel = labelStrategy(
    positions.map((p) => ({
      type: p.side === "call" ? "Call" : ("Put" as "Call" | "Put"),
      direction: p.direction === "long" ? "Long" : ("Short" as "Long" | "Short"),
      strike: p.strike,
      qty: p.qty,
    })),
  );

  log(
    "info",
    `Greek builder: ${strategyLabel}, ${totals.contracts} contracts, ` +
      `Δ=${totals.delta.toFixed(3)}, Γ=${totals.gamma.toFixed(3)}, ` +
      `Θ=${totals.theta.toFixed(3)}, V=${totals.vega.toFixed(3)}, ` +
      `margin=$${totals.margin.toFixed(0)}`,
  );

  return { positions, totals, feasible: true, strategyLabel };
}
