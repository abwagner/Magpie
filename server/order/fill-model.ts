// ── Fill Price Model ──────────────────────────────────────────────
// Computes realistic fill prices for paper trading and backtesting.
// Uses bid/ask spread + liquidity scoring (volume/OI) to determine
// slippage. Degrades gracefully when volume/OI data is unavailable.
//
// Shared by: paper adapter (live), backtest engine (historical).
// Calibration: tune the constants below against real execution data
// once live trading produces fills to compare against.

// ── Tunable Parameters ───────────────────────────────────────────

/** Slippage when liquidity score = 1 (very liquid ATM). */
const MIN_SLIPPAGE = 0.5;

/** Additional slippage when liquidity score = 0 (illiquid OTM). */
const ILLIQUIDITY_PENALTY = 0.4;

/** Extra slippage per log10(quantity/10) for large orders. */
const SIZE_IMPACT_COEFF = 0.05;

/** Assumed liquidity score when volume/OI are unavailable. */
const DEFAULT_LIQUIDITY = 0.5;

/** log10 divisor for volume — volume of 10,000 → score 1.0. */
const VOLUME_LOG_DIVISOR = 4;

/** log10 divisor for OI — OI of 10,000 → score 1.0. */
const OI_LOG_DIVISOR = 4;

// ── Types ────────────────────────────────────────────────────────

export interface FillPriceParams {
  bid: number;
  ask: number;
  direction: "buy" | "sell";
  /** Today's volume at this strike/symbol. Optional — omit for degraded mode. */
  volume?: number;
  /** Open interest at this strike. Optional — omit for degraded mode. */
  openInterest?: number;
  /** Order quantity (contracts or shares). Default 1. */
  quantity?: number;
}

export interface FillPriceResult {
  price: number;
  mid: number;
  spread: number;
  slippageFraction: number;
  liquidityScore: number;
}

// ── Implementation ───────────────────────────────────────────────

export function computeFillPrice(params: FillPriceParams): FillPriceResult {
  const { bid, ask, direction, quantity = 1 } = params;
  const spread = Math.max(0, ask - bid);
  const mid = (bid + ask) / 2;

  // Liquidity score: geometric mean of volume and OI scores, each
  // scaled by log10. When data is missing, use DEFAULT_LIQUIDITY.
  const volScore =
    params.volume != null
      ? Math.min(1, Math.log10(Math.max(1, params.volume)) / VOLUME_LOG_DIVISOR)
      : DEFAULT_LIQUIDITY;
  const oiScore =
    params.openInterest != null
      ? Math.min(1, Math.log10(Math.max(1, params.openInterest)) / OI_LOG_DIVISOR)
      : DEFAULT_LIQUIDITY;
  const liquidityScore = volScore * oiScore;

  // Base slippage: liquid fills near mid, illiquid fills near natural side
  const baseSlippage = MIN_SLIPPAGE + ILLIQUIDITY_PENALTY * (1 - liquidityScore);

  // Size impact: larger orders get worse fills
  const sizeImpact = quantity > 10 ? SIZE_IMPACT_COEFF * Math.log10(quantity / 10) : 0;

  const slippageFraction = Math.min(1, baseSlippage + sizeImpact);

  // Final price: buy above mid, sell below mid
  const price =
    direction === "buy"
      ? mid + slippageFraction * (spread / 2)
      : mid - slippageFraction * (spread / 2);

  return {
    price: Math.round(price * 100) / 100, // round to cents
    mid,
    spread,
    slippageFraction,
    liquidityScore,
  };
}
