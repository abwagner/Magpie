import { BS } from "./bs.js";
import type { OptionApi } from "./bs.js";

// ── Types ────────────────────────────────────────────────────────────────

export type SplineFn = (x: number) => number;

export interface SmileContract {
  iv?: number | null;
  strike: number;
  side: "call" | "put" | string;
}

export interface SmilePoint {
  delta: number;
  iv: number;
  strike: number;
}

export interface Smile {
  spline: SplineFn;
  minDelta: number;
  maxDelta: number;
  points: SmilePoint[];
  ivAtStrike(strike: number): number;
  ivAtDelta(d: number): number;
}

export interface SmileEntry {
  expiry: string;
  dte: number;
  smile: Smile;
  T: number;
}

export interface ExpiryChain {
  expiry: string;
  dte: number;
  chain: SmileContract[];
}

export interface IvGridCell {
  strike: number;
  dte: number;
  iv: number;
}

export interface VolSurface {
  smiles: SmileEntry[];
  spot: number;
  rfr: number;
  iv(strike: number, dte: number): number;
  callPrice(strike: number, dte: number): number;
  putPrice(strike: number, dte: number): number;
  ivGrid(
    strikeRange: [number, number],
    dteRange: [number, number],
    strikeStep?: number,
    dteStep?: number,
  ): IvGridCell[][];
}

export interface BuildVolSurfaceOptions {
  pricingModel?: OptionApi;
}

// ── Cubic Spline Interpolation ──────────────────────────────────────────
// Natural cubic spline through (x, y) points. Returns a function that
// interpolates at any x value with C2 continuity.
export function cubicSpline(xs: number[], ys: number[]): SplineFn {
  const n = xs.length;
  if (n < 2) return () => ys[0] || 0;
  if (n === 2) {
    const slope = ((ys[1] as number) - (ys[0] as number)) / ((xs[1] as number) - (xs[0] as number));
    return (x) => (ys[0] as number) + slope * (x - (xs[0] as number));
  }

  const h = new Float64Array(n - 1);
  const alpha = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) h[i] = (xs[i + 1] as number) - (xs[i] as number);

  for (let i = 1; i < n - 1; i++) {
    alpha[i] =
      (3 / (h[i] as number)) * ((ys[i + 1] as number) - (ys[i] as number)) -
      (3 / (h[i - 1] as number)) * ((ys[i] as number) - (ys[i - 1] as number));
  }

  const l = new Float64Array(n);
  const mu = new Float64Array(n);
  const z = new Float64Array(n);
  l[0] = 1;

  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * ((xs[i + 1] as number) - (xs[i - 1] as number)) - (h[i - 1] as number) * (mu[i - 1] as number);
    mu[i] = (h[i] as number) / (l[i] as number);
    z[i] = ((alpha[i] as number) - (h[i - 1] as number) * (z[i - 1] as number)) / (l[i] as number);
  }

  l[n - 1] = 1;
  const c = new Float64Array(n);
  const b = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);

  for (let j = n - 2; j >= 0; j--) {
    c[j] = (z[j] as number) - (mu[j] as number) * (c[j + 1] as number);
    b[j] =
      ((ys[j + 1] as number) - (ys[j] as number)) / (h[j] as number) -
      ((h[j] as number) * ((c[j + 1] as number) + 2 * (c[j] as number))) / 3;
    d[j] = ((c[j + 1] as number) - (c[j] as number)) / (3 * (h[j] as number));
  }

  return function interpolate(x: number): number {
    // clamp to range
    if (x <= (xs[0] as number)) return ys[0] as number;
    if (x >= (xs[n - 1] as number)) return ys[n - 1] as number;

    // binary search for interval
    let lo = 0,
      hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if ((xs[mid] as number) <= x) lo = mid;
      else hi = mid;
    }

    const dx = x - (xs[lo] as number);
    return (
      (ys[lo] as number) +
      (b[lo] as number) * dx +
      (c[lo] as number) * dx * dx +
      (d[lo] as number) * dx * dx * dx
    );
  };
}

// ── Vol Smile Fitting (per expiry) ──────────────────────────────────────
// Fits IV data in delta space using cubic spline.
// Delta space handles changing ATM levels better than strike space.
// pricingModel: BS (equity) or Black76 (futures). Defaults to BS.
function fitSmile(
  contracts: SmileContract[],
  spot: number,
  rfr: number,
  dte: number,
  pricingModel: OptionApi = BS,
): Smile | null {
  const T = Math.max(dte / 365, 1 / 365);

  // collect (delta, iv) pairs, sorted by delta
  const points: SmilePoint[] = [];
  for (const c of contracts) {
    if (c.iv == null || c.iv <= 0.01 || c.iv > 3) continue;
    const d = pricingModel.delta(spot, c.strike, rfr, T, c.iv, c.side === "call" ? "Call" : "Put");
    // use absolute delta for puts (so everything is 0 to 1)
    const absDelta = Math.abs(d);
    if (absDelta < 0.01 || absDelta > 0.99) continue; // skip extreme wings
    points.push({ delta: absDelta, iv: c.iv, strike: c.strike });
  }

  if (points.length < 3) return null;

  // sort by delta
  points.sort((a, b) => a.delta - b.delta);

  // deduplicate by delta (average IVs at same delta)
  const deduped: SmilePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i] as SmilePoint;
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.delta - pt.delta) < 0.001) {
      last.iv = (last.iv + pt.iv) / 2;
    } else {
      deduped.push({ ...pt });
    }
  }

  if (deduped.length < 3) return null;

  const deltas = deduped.map((p) => p.delta);
  const ivs = deduped.map((p) => p.iv);
  const spline = cubicSpline(deltas, ivs);

  return {
    spline,
    minDelta: deltas[0] as number,
    maxDelta: deltas[deltas.length - 1] as number,
    points: deduped,
    // get IV at a given strike
    ivAtStrike(strike: number): number {
      const callDelta = pricingModel.delta(spot, strike, rfr, T, this.ivAtDelta(0.5), "Call");
      const absDelta = Math.abs(callDelta);
      return this.ivAtDelta(absDelta);
    },
    // get IV at a given absolute delta
    ivAtDelta(d: number): number {
      const clamped = Math.max(this.minDelta, Math.min(this.maxDelta, d));
      return Math.max(0.01, spline(clamped));
    },
  };
}

// ── Vol Surface (across expiries) ───────────────────────────────────────
// Builds a full vol surface from chain data across multiple expirations.
// Uses flat forward variance interpolation between expiries.
// options.pricingModel: BS (equity) or Black76 (futures). Defaults to BS.
export function buildVolSurface(
  chainsByExpiry: ExpiryChain[],
  spot: number,
  rfr = 0.05,
  { pricingModel = BS }: BuildVolSurfaceOptions = {},
): VolSurface | null {
  // chainsByExpiry: [{ expiry, dte, chain }]
  const pm = pricingModel;
  const smiles: SmileEntry[] = [];
  for (const { expiry, dte, chain } of chainsByExpiry) {
    if (!chain?.length || dte <= 0) continue;
    const smile = fitSmile(chain, spot, rfr, dte, pm);
    if (smile) {
      smiles.push({ expiry, dte, smile, T: Math.max(dte / 365, 1 / 365) });
    }
  }

  if (!smiles.length) return null;

  // sort by DTE
  smiles.sort((a, b) => a.dte - b.dte);

  return {
    smiles,
    spot,
    rfr,

    // Get IV at any (strike, dte) point
    iv(strike: number, dte: number): number {
      if (!smiles.length) return 0.2; // fallback
      const T = Math.max(dte / 365, 1 / 365);

      const firstSmile = smiles[0] as SmileEntry;
      const lastSmile = smiles[smiles.length - 1] as SmileEntry;

      // find bracketing expiries
      if (dte <= firstSmile.dte) {
        return firstSmile.smile.ivAtStrike(strike);
      }
      if (dte >= lastSmile.dte) {
        return lastSmile.smile.ivAtStrike(strike);
      }

      // interpolate using flat forward variance
      let lo = 0;
      for (let i = 0; i < smiles.length - 1; i++) {
        if ((smiles[i] as SmileEntry).dte <= dte && (smiles[i + 1] as SmileEntry).dte >= dte) {
          lo = i;
          break;
        }
      }

      const s0 = smiles[lo] as SmileEntry;
      const s1 = smiles[lo + 1] as SmileEntry;
      const iv0 = s0.smile.ivAtStrike(strike);
      const iv1 = s1.smile.ivAtStrike(strike);
      const var0 = iv0 * iv0 * s0.T;
      const var1 = iv1 * iv1 * s1.T;

      // linear interpolation in total variance space
      const w = (T - s0.T) / (s1.T - s0.T);
      const totalVar = var0 + w * (var1 - var0);

      // enforce non-negative forward variance (arbitrage-free)
      const interpVar = Math.max(totalVar, 0);
      return Math.sqrt(Math.max(interpVar / T, 0.0001));
    },

    // Get call price at any (strike, dte)
    callPrice(strike: number, dte: number): number {
      const T = Math.max(dte / 365, 1 / 365);
      const sigma = this.iv(strike, dte);
      return pm.call(spot, strike, rfr, T, sigma);
    },

    // Get put price at any (strike, dte)
    putPrice(strike: number, dte: number): number {
      const T = Math.max(dte / 365, 1 / 365);
      const sigma = this.iv(strike, dte);
      return pm.put(spot, strike, rfr, T, sigma);
    },

    // Generate a grid of IVs for visualization
    ivGrid(
      strikeRange: [number, number],
      dteRange: [number, number],
      strikeStep = 1,
      dteStep = 5,
    ): IvGridCell[][] {
      const grid: IvGridCell[][] = [];
      for (let dte = dteRange[0]; dte <= dteRange[1]; dte += dteStep) {
        const row: IvGridCell[] = [];
        for (let k = strikeRange[0]; k <= strikeRange[1]; k += strikeStep) {
          row.push({ strike: k, dte, iv: this.iv(k, dte) });
        }
        grid.push(row);
      }
      return grid;
    },
  };
}
