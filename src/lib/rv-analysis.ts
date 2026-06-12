// ── Realized Volatility Analysis ────────────────────────────────────────
// Compute realized vol from historical returns and compare with implied vol.

export interface HighLowBar {
  high: number;
  low: number;
}

export interface WindowAnalysis {
  rv: number;
  ivRvRatio: number | null;
  vrp: number;
}

export interface IvRvAnalysisResult {
  currentIV: number;
  windows: Record<string, WindowAnalysis>;
  avgRV: number | null;
}

export interface RvAdjustedVolResult {
  adjustedVol: number;
  ratio: number;
  vrp: number;
  adjustIV(iv: number): number;
}

// Close-to-close realized volatility
export function realizedVolCC(returns: number[], annualizationFactor = 252): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * annualizationFactor);
}

// Parkinson (high-low) realized volatility estimator
// More efficient than close-to-close: uses intraday range information.
// Input: array of { high, low } (prices, not returns)
export function realizedVolParkinson(bars: HighLowBar[], annualizationFactor = 252): number {
  if (bars.length < 1) return 0;
  const sumSq = bars.reduce((s, bar) => {
    if (bar.high <= 0 || bar.low <= 0 || bar.high < bar.low) return s;
    const logHL = Math.log(bar.high / bar.low);
    return s + logHL * logHL;
  }, 0);
  return Math.sqrt((annualizationFactor / (4 * bars.length * Math.LN2)) * sumSq);
}

// Compute returns from price series
export function computeReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (prev !== undefined && curr !== undefined && prev > 0) {
      returns.push(Math.log(curr / prev));
    }
  }
  return returns;
}

// Compute realized vol across multiple lookback windows
export function realizedVolMultiWindow(
  prices: number[],
  windows: number[] = [10, 20, 30, 60, 90],
): Record<number, number> {
  const allReturns = computeReturns(prices);
  const result: Record<number, number> = {};
  for (const w of windows) {
    if (allReturns.length >= w) {
      result[w] = realizedVolCC(allReturns.slice(-w));
    }
  }
  return result;
}

// IV/RV ratio and percentile analysis
export function ivRvAnalysis(
  currentATMIV: number,
  prices: number[],
  windows: number[] = [10, 20, 30, 60, 90],
): IvRvAnalysisResult {
  const rvByWindow = realizedVolMultiWindow(prices, windows);

  const analysis: Record<string, WindowAnalysis> = {};
  for (const [window, rv] of Object.entries(rvByWindow)) {
    analysis[window] = {
      rv,
      ivRvRatio: rv > 0 ? currentATMIV / rv : null,
      vrp: currentATMIV - rv, // vol risk premium (positive = IV > RV)
    };
  }

  return {
    currentIV: currentATMIV,
    windows: analysis,
    // simple summary: average RV across windows
    avgRV: Object.values(rvByWindow).length
      ? Object.values(rvByWindow).reduce((s, v) => s + v, 0) / Object.values(rvByWindow).length
      : null,
  };
}

// Generate an RV-adjusted probability distribution
// Uses realized vol instead of implied vol as the vol input,
// capturing the vol risk premium
export function rvAdjustedVol(currentATMIV: number, estimatedRV: number): RvAdjustedVolResult {
  // the adjustment ratio
  const ratio = estimatedRV / currentATMIV;
  return {
    adjustedVol: estimatedRV,
    ratio,
    vrp: currentATMIV - estimatedRV,
    // function to adjust any IV by the same ratio
    adjustIV(iv: number): number {
      return iv * ratio;
    },
  };
}
