// ── Option strategy model ────────────────────────────────────────────
// Operator-built multi-leg option structures (verticals, calendars/
// diagonals, straddles/strangles, condors/butterflies). A StrategyTemplate
// declares legs as *relative* selectors (strike + expiration) so one
// template parameterises to a concrete set of chain contracts; calendars
// and diagonals are first-class because each leg picks its own expiration.
//
// Stage 1 (this file + src/lib/strategies/) is pure analysis — no order or
// broker concerns. Multi-leg orders come in a later stage.

import type { Contract } from "./market-data.js";

export type OptionRight = "call" | "put";
export type LegSide = "buy" | "sell";

// Which expiration a leg binds to, relative to the operator's selected
// expirations (sorted near→far). `front`/`back` are the first/last; `index`
// picks the nth; `absolute` pins a specific expiration string.
export type ExpirationSelector =
  | { kind: "front" }
  | { kind: "back" }
  | { kind: "index"; index: number }
  | { kind: "absolute"; expiration: string };

// Which strike a leg binds to. `atm` = nearest to spot; `offset` = N strike
// steps from ATM (sign = direction); `delta` = nearest to a target |delta|;
// `absolute` = a specific strike.
export type StrikeSelector =
  | { kind: "atm" }
  | { kind: "offset"; steps: number }
  | { kind: "delta"; target: number }
  | { kind: "absolute"; strike: number };

export interface LegTemplate {
  right: OptionRight;
  side: LegSide;
  ratio: number; // contracts per unit of the strategy (e.g. 1, or 2 for the body of a butterfly)
  strike: StrikeSelector;
  expiration: ExpirationSelector;
}

export type OptionStrategyKind =
  | "vertical-call-debit"
  | "vertical-call-credit"
  | "vertical-put-debit"
  | "vertical-put-credit"
  | "calendar-call"
  | "calendar-put"
  | "diagonal-call"
  | "diagonal-put"
  | "straddle"
  | "strangle"
  | "iron-condor"
  | "iron-butterfly"
  | "call-butterfly"
  | "put-butterfly";

export interface StrategyTemplate {
  kind: OptionStrategyKind;
  label: string;
  // Distinct expirations the operator must supply (1 for single-expiration
  // structures; 2 for calendars/diagonals).
  expirationsRequired: 1 | 2;
  legs: LegTemplate[];
}

// A template leg bound to a concrete chain contract.
export interface ResolvedLeg {
  right: OptionRight;
  side: LegSide;
  ratio: number;
  contract: Contract;
}

export interface PayoffPoint {
  underlying: number;
  pnl: number; // P/L of the whole structure at expiration, per 1 unit (×100 share multiplier applied)
}

export interface StrategyAnalytics {
  // Net greeks (signed by side, scaled by ratio). Sum of per-leg chain greeks.
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  // Net cost: positive = net debit paid, negative = net credit received
  // (per 1 unit, ×100 multiplier). Uses leg mid prices.
  netDebit: number;
  maxProfit: number | null; // null = theoretically unbounded
  maxLoss: number | null; // null = theoretically unbounded
  breakevens: number[];
  payoff: PayoffPoint[];
}

export interface BuiltStrategy {
  kind: OptionStrategyKind;
  label: string;
  underlying: string;
  legs: ResolvedLeg[];
  analytics: StrategyAnalytics;
}

// Contracts grouped by expiration (near→far), the input to the builder.
export type ChainsByExpiration = Map<string, Contract[]>;

export class StrategyBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyBuildError";
  }
}
