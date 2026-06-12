// ── Margin Estimation ────────────────────────────────────────────────────
// Estimates buying power / margin requirements for options positions.
// Tier 1: Schwab previewOrder (if connected)
// Tier 2: IBKR reqMargin (if connected)
// Tier 3: SPAN approximation (futures) or Reg-T (equities)
//
// SPAN approximation calibrated from ToS/ThinkorSwim screenshots for /CL.

// ── Types ──────────────────────────────────────────────────────────────────

export type OptionTypeLabel = "Call" | "Put";

export interface MarginLeg {
  side?: "call" | "put" | string;
  type?: string;
  direction?: string;
  qty?: number;
  quantity?: number;
  strike: number;
  premium?: number;
  mid?: number;
  last?: number;
  multiplier?: number;
}

export interface MarginPerPosition {
  label: string;
  strike: number;
  type?: string;
  direction?: string;
  qty: number;
  margin: number;
  premium: number;
  spanCharge: number;
}

export interface MarginEstimate {
  totalMargin: number;
  perPosition: MarginPerPosition[];
  source: string;
}

// ── Long Options ────────────────────────────────────────────────────────

// Long options: buying power = premium paid
export function longOptionBP(premium: number, qty: number, multiplier: number): number {
  return premium * qty * multiplier;
}

// ── Short Options (Futures — SPAN) ──────────────────────────────────────

// SPAN charge scales with proximity to ATM — closer = higher charge
export function shortOptionBP(
  strike: number,
  underlyingPrice: number,
  premium: number,
  qty: number,
  multiplier: number,
): number {
  const otmDist = Math.abs(underlyingPrice - strike);
  const otmPct = Math.max(otmDist / underlyingPrice, 0);

  // Calibrated from ToS: CL 80P at $97 underlying
  // $4,829 total BP / $4,210 premium = $619 SPAN charge at ~17.5% OTM
  const baseSPANCharge = 620;
  const otmRef = 0.175;

  const itm = underlyingPrice <= strike; // for puts; adjust for calls below
  const spanCharge = itm
    ? 6500 // approximately full futures margin when ITM
    : baseSPANCharge * (otmRef / Math.max(otmPct, 0.02));

  const premiumPerContract = premium * multiplier;
  const bpPerContract = premiumPerContract + spanCharge;
  return bpPerContract * qty;
}

// ── Short Options (Equity — Reg-T) ──────────────────────────────────────

// Standard Reg-T naked option margin:
//   Call: max(20% × spot - OTM amount, 10% × spot) + premium
//   Put:  max(20% × spot - OTM amount, 10% × strike) + premium
export function equityShortOptionBP(
  strike: number,
  spot: number,
  premium: number,
  qty: number,
  multiplier: number,
  type: OptionTypeLabel,
): number {
  const otmAmount = type === "Call" ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  const minBase = type === "Call" ? 0.1 * spot : 0.1 * strike;
  const bpPerShare = Math.max(0.2 * spot - otmAmount, minBase) + premium;
  return bpPerShare * qty * multiplier;
}

// ── Spread Margin ───────────────────────────────────────────────────────

// Vertical spread margin: max loss = width between strikes
export function spreadBP(
  longStrike: number,
  shortStrike: number,
  multiplier: number,
  qty: number,
): number {
  const maxRisk = Math.abs(longStrike - shortStrike) * multiplier * qty;
  return maxRisk;
}

// ── Candidate Margin ────────────────────────────────────────────────────

// Compute per-candidate margin for the LP solver.
// Long: premium paid. Short: naked margin (equity Reg-T or futures SPAN).
export function candidateMargin(
  strike: number,
  spot: number,
  premium: number,
  multiplier: number,
  type: string,
  direction: string,
  assetClass: string,
): number {
  if (direction === "long") return premium * multiplier;
  if (assetClass === "futures") return shortOptionBP(strike, spot, premium, 1, multiplier);
  return equityShortOptionBP(strike, spot, premium, 1, multiplier, type === "call" ? "Call" : "Put");
}

// ── Portfolio Margin ────────────────────────────────────────────────────

// Compute portfolio-level margin with spread netting.
// Matches short legs with long legs of the same type to form vertical spreads.
// Spread margin = max loss = strike width × multiplier.
// Unmatched shorts keep naked margin. Longs = premium.
export function computePortfolioMargin(
  positions: MarginLeg[],
  spot: number,
  assetClass = "equity",
): number {
  // Separate by type (call/put)
  const calls = positions.filter((p) => (p.side || p.type?.toLowerCase()) === "call");
  const puts = positions.filter((p) => (p.side || p.type?.toLowerCase()) === "put");

  let totalMargin = 0;
  for (const group of [calls, puts]) {
    totalMargin += computeGroupMargin(group, spot, assetClass);
  }
  return totalMargin;
}

// Match shorts with longs within a single type (all calls or all puts)
function computeGroupMargin(legs: MarginLeg[], spot: number, assetClass: string): number {
  const type = legs[0]?.side || legs[0]?.type?.toLowerCase() || "call";

  // Expand by qty: each unit is a separate entry for matching
  const longs: MarginLeg[] = [];
  const shorts: MarginLeg[] = [];
  for (const leg of legs) {
    const dir = leg.direction === "long" || leg.direction === "Long" ? "long" : "short";
    const qty = leg.qty || Math.abs(leg.quantity ?? 0) || 1;
    for (let i = 0; i < qty; i++) {
      (dir === "long" ? longs : shorts).push({ ...leg, qty: 1 });
    }
  }

  // Sort longs by strike ascending, shorts by strike ascending
  longs.sort((a, b) => a.strike - b.strike);
  shorts.sort((a, b) => a.strike - b.strike);

  let margin = 0;
  const usedLongs = new Set<number>();

  // Match each short with the nearest long to form a spread
  for (const s of shorts) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < longs.length; i++) {
      if (usedLongs.has(i)) continue;
      const dist = Math.abs((longs[i] as MarginLeg).strike - s.strike);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      // Matched: spread margin = max loss = strike width × multiplier
      usedLongs.add(bestIdx);
      const mult = s.multiplier || 100;
      margin += Math.abs((longs[bestIdx] as MarginLeg).strike - s.strike) * mult;
    } else {
      // Unmatched short: naked margin
      const prem = s.premium || s.mid || s.last || 0;
      const mult = s.multiplier || 100;
      margin += candidateMargin(s.strike, spot, prem, mult, type, "short", assetClass);
    }
  }

  // Longs not matched: margin = premium
  for (let i = 0; i < longs.length; i++) {
    if (!usedLongs.has(i)) {
      const leg = longs[i] as MarginLeg;
      const prem = leg.premium || leg.mid || leg.last || 0;
      const mult = leg.multiplier || 100;
      margin += prem * mult;
    }
  }

  return margin;
}

// Estimate margin for a portfolio of positions
export function estimateMargin(
  positions: MarginLeg[],
  underlyingPrice: number,
  defaultMultiplier = 100,
): MarginEstimate {
  const perPosition: MarginPerPosition[] = [];
  let totalMargin = 0;

  // Group by strike to detect spreads (same type, different directions)
  // For now, calculate each position independently (conservative)
  for (const p of positions) {
    const mult = p.multiplier || defaultMultiplier;
    const premium = p.premium || p.mid || p.last || 0;
    const qty = p.qty || 1;
    let bp: number;

    if (p.direction === "Long") {
      bp = longOptionBP(premium, qty, mult);
    } else {
      bp = shortOptionBP(p.strike, underlyingPrice, premium, qty, mult);
    }

    perPosition.push({
      label: `${p.direction === "Long" ? "+" : "-"}${qty} ${p.strike}${p.type === "Call" ? "C" : "P"}`,
      strike: p.strike,
      type: p.type,
      direction: p.direction,
      qty,
      margin: bp,
      premium: premium * qty * mult,
      spanCharge: p.direction === "Short" ? bp - premium * qty * mult : 0,
    });

    totalMargin += bp;
  }

  return {
    totalMargin,
    perPosition,
    source: "estimate",
  };
}

// Format margin for display
export function formatMargin(margin: number): string {
  return `$${margin.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
