// ── Black-Scholes & Black-76 pricing (display surface) ────────────
// The browser/Node side of QF's options pricing. Quantitative
// backtesting and live trading use the Rust quantfoundry-quant crate
// (via PyO3 or WASM) — this file is the display surface (PayoffDiag,
// vol-surface curves, edge→Greeks, Greek Builder LP, etc.).
//
// Phase 1.5 of the polyglot migration corrected the math in qf-quant
// (cdf → cdf_correct, see core/qf-quant/src/normal.rs). QF-185 lands
// the same correction here so the GUI matches what the math actually
// says.

// ── Types ─────────────────────────────────────────────────────────

export type OptionType = "Call" | "Put";

export interface OptionApi {
  N: (x: number) => number;
  call: (S: number, K: number, r: number, T: number, v: number) => number;
  put: (S: number, K: number, r: number, T: number, v: number) => number;
  delta: (S: number, K: number, r: number, T: number, v: number, t: OptionType) => number;
  gamma: (S: number, K: number, r: number, T: number, v: number) => number;
  theta: (S: number, K: number, r: number, T: number, v: number, t: OptionType) => number;
  vega: (S: number, K: number, r: number, T: number, v: number) => number;
  impliedVol: (
    S: number,
    K: number,
    r: number,
    T: number,
    marketPrice: number,
    type?: OptionType,
  ) => number | null;
}

// ── erf via Abramowitz & Stegun 7.1.26 ────────────────────────────
// |error| < 7.5e-8 for any input. Same approximation the Rust
// quantfoundry-quant crate uses (`erf_as_7_1_26` in
// core/qf-quant/src/normal.rs), so JS↔Rust pricing diverges only
// at floating-point ULP scale.

const A1 = 0.254829592;
const A2 = -0.284496736;
const A3 = 1.421413741;
const A4 = -1.453152027;
const A5 = 1.061405429;
const P = 0.3275911;

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + P * absX);
  const poly = ((((A5 * t + A4) * t + A3) * t + A2) * t + A1) * t;
  return sign * (1 - poly * Math.exp(-absX * absX));
}

// ── Standard normal CDF & PDF ─────────────────────────────────────
// `N(x) = ½·(1 + erf(x/√2))` — composition of A&S 7.1.26 with the
// change of variable from erf to the standard normal CDF. The
// pre-Phase-1.5 form applied the A&S polynomial directly to `x` and
// kept the `exp(-x²/2)` from Φ, mixing the two parameterizations
// and biasing every Φ call in the body of the distribution by up to
// ~5%. See polyglot-migration-tdd.md §8.1.1.1 for the full
// archaeology and core/qf-quant/src/normal.rs for the Rust mirror.
const N = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

// Standard normal PDF (needed for gamma, theta, vega).
const n = (x: number): number => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);

// ── Black-Scholes helpers ─────────────────────────────────────────

const d1 = (S: number, K: number, r: number, T: number, v: number): number =>
  (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
const d2 = (S: number, K: number, r: number, T: number, v: number): number =>
  d1(S, K, r, T, v) - v * Math.sqrt(T);

// ── Black-76 (Futures Options) helpers ────────────────────────────
// F = futures price, K = strike, r = risk-free rate, T = time to expiry, v = vol

const f1 = (F: number, K: number, T: number, v: number): number =>
  (Math.log(F / K) + ((v * v) / 2) * T) / (v * Math.sqrt(T));
const f2 = (F: number, K: number, T: number, v: number): number =>
  f1(F, K, T, v) - v * Math.sqrt(T);

// ── Black-76 ──────────────────────────────────────────────────────

export const Black76: OptionApi = {
  N,
  call: (F, K, r, T, v) => {
    if (T <= 0) return Math.max(0, F - K);
    const disc = Math.exp(-r * T);
    return disc * (F * N(f1(F, K, T, v)) - K * N(f2(F, K, T, v)));
  },
  put: (F, K, r, T, v) => {
    if (T <= 0) return Math.max(0, K - F);
    const disc = Math.exp(-r * T);
    return disc * (K * N(-f2(F, K, T, v)) - F * N(-f1(F, K, T, v)));
  },
  delta: (F, K, r, T, v, t) => {
    if (T <= 0) return t === "Call" ? (F > K ? 1 : 0) : F < K ? -1 : 0;
    const disc = Math.exp(-r * T);
    return t === "Call" ? disc * N(f1(F, K, T, v)) : disc * (N(f1(F, K, T, v)) - 1);
  },
  gamma: (F, K, r, T, v) => {
    if (T <= 0) return 0;
    return (Math.exp(-r * T) * n(f1(F, K, T, v))) / (F * v * Math.sqrt(T));
  },
  theta: (F, K, r, T, v, t) => {
    if (T <= 0) return 0;
    const D1 = f1(F, K, T, v);
    const D2 = f2(F, K, T, v);
    const disc = Math.exp(-r * T);
    const common = (-F * disc * n(D1) * v) / (2 * Math.sqrt(T));
    if (t === "Call") {
      return (common + r * F * disc * N(D1) - r * K * disc * N(D2)) / 365;
    }
    return (common - r * F * disc * N(-D1) + r * K * disc * N(-D2)) / 365;
  },
  vega: (F, K, r, T, v) => {
    if (T <= 0) return 0;
    return (F * Math.exp(-r * T) * Math.sqrt(T) * n(f1(F, K, T, v))) / 100;
  },
  impliedVol: (F, K, r, T, marketPrice, type = "Call") => {
    if (T <= 0) return null;
    const disc = Math.exp(-r * T);
    const intrinsic = type === "Call" ? Math.max(0, disc * (F - K)) : Math.max(0, disc * (K - F));
    const maxPrice = disc * (type === "Call" ? F : K);
    const priceFn = (v: number): number =>
      type === "Call" ? Black76.call(F, K, r, T, v) : Black76.put(F, K, r, T, v);
    return impliedVolBisection(priceFn, marketPrice, intrinsic, maxPrice);
  },
};

// ── Implied Volatility Solver (Bisection) ─────────────────────────
// Finds the vol that makes the model price match the market price.
// Returns null if no valid IV (price below intrinsic or above bounds).
function impliedVolBisection(
  priceFn: (v: number) => number,
  marketPrice: number,
  intrinsic: number,
  maxPrice: number,
  tol = 1e-6,
  maxIter = 100,
): number | null {
  if (marketPrice <= intrinsic + tol || marketPrice <= 0) return null;
  if (marketPrice >= maxPrice) return null;
  let lo = 0.001;
  let hi = 5.0;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const price = priceFn(mid);
    if (Math.abs(price - marketPrice) < tol) return mid;
    if (price < marketPrice) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Standard Black-Scholes (Equity Options) ───────────────────────

export const BS: OptionApi = {
  N,
  call: (S, K, r, T, v) =>
    T <= 0
      ? Math.max(0, S - K)
      : S * N(d1(S, K, r, T, v)) - K * Math.exp(-r * T) * N(d2(S, K, r, T, v)),
  put: (S, K, r, T, v) => {
    if (T <= 0) return Math.max(0, K - S);
    const D1 = d1(S, K, r, T, v);
    const D2 = d2(S, K, r, T, v);
    return K * Math.exp(-r * T) * N(-D2) - S * N(-D1);
  },
  delta: (S, K, r, T, v, t) => {
    if (T <= 0) return t === "Call" ? (S > K ? 1 : 0) : S < K ? -1 : 0;
    return t === "Call" ? N(d1(S, K, r, T, v)) : N(d1(S, K, r, T, v)) - 1;
  },
  gamma: (S, K, r, T, v) => {
    if (T <= 0) return 0;
    const D1 = d1(S, K, r, T, v);
    return Math.exp((-D1 * D1) / 2) / (S * v * Math.sqrt(T) * Math.sqrt(2 * Math.PI));
  },
  theta: (S, K, r, T, v, t) => {
    if (T <= 0) return 0;
    const D1 = d1(S, K, r, T, v);
    const D2 = d2(S, K, r, T, v);
    const c = (-S * Math.exp((-D1 * D1) / 2) * v) / (2 * Math.sqrt(T) * Math.sqrt(2 * Math.PI));
    return t === "Call"
      ? (c - r * K * Math.exp(-r * T) * N(D2)) / 365
      : (c + r * K * Math.exp(-r * T) * N(-D2)) / 365;
  },
  vega: (S, K, r, T, v) => {
    if (T <= 0) return 0;
    const D1 = d1(S, K, r, T, v);
    return (S * Math.sqrt(T) * Math.exp((-D1 * D1) / 2)) / Math.sqrt(2 * Math.PI) / 100;
  },
  impliedVol: (S, K, r, T, marketPrice, type = "Call") => {
    if (T <= 0) return null;
    const intrinsic =
      type === "Call"
        ? Math.max(0, S - K * Math.exp(-r * T))
        : Math.max(0, K * Math.exp(-r * T) - S);
    const maxPrice = type === "Call" ? S : K * Math.exp(-r * T);
    const priceFn = (v: number): number =>
      type === "Call" ? BS.call(S, K, r, T, v) : BS.put(S, K, r, T, v);
    return impliedVolBisection(priceFn, marketPrice, intrinsic, maxPrice);
  },
};
