import { BS, Black76 } from "./bs.js";

// ── Cubic Spline Interpolation ──────────────────────────────────────────
// Natural cubic spline through (x, y) points. Returns a function that
// interpolates at any x value with C2 continuity.
export function cubicSpline(xs, ys) {
  const n = xs.length;
  if (n < 2) return () => ys[0] || 0;
  if (n === 2) {
    const slope = (ys[1] - ys[0]) / (xs[1] - xs[0]);
    return (x) => ys[0] + slope * (x - xs[0]);
  }

  const h = new Float64Array(n - 1);
  const alpha = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) h[i] = xs[i + 1] - xs[i];

  for (let i = 1; i < n - 1; i++) {
    alpha[i] = (3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1]);
  }

  const l = new Float64Array(n);
  const mu = new Float64Array(n);
  const z = new Float64Array(n);
  l[0] = 1;

  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }

  l[n - 1] = 1;
  const c = new Float64Array(n);
  const b = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);

  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }

  return function interpolate(x) {
    // clamp to range
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    // binary search for interval
    let lo = 0,
      hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }

    const dx = x - xs[lo];
    return ys[lo] + b[lo] * dx + c[lo] * dx * dx + d[lo] * dx * dx * dx;
  };
}

// ── Vol Smile Fitting (per expiry) ──────────────────────────────────────
// Fits IV data in delta space using cubic spline.
// Delta space handles changing ATM levels better than strike space.
// pricingModel: BS (equity) or Black76 (futures). Defaults to BS.
function fitSmile(contracts, spot, rfr, dte, pricingModel = BS) {
  const T = Math.max(dte / 365, 1 / 365);

  // collect (delta, iv) pairs, sorted by delta
  const points = [];
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
  const deduped = [];
  for (let i = 0; i < points.length; i++) {
    if (deduped.length && Math.abs(deduped[deduped.length - 1].delta - points[i].delta) < 0.001) {
      const last = deduped[deduped.length - 1];
      last.iv = (last.iv + points[i].iv) / 2;
    } else {
      deduped.push({ ...points[i] });
    }
  }

  if (deduped.length < 3) return null;

  const deltas = deduped.map((p) => p.delta);
  const ivs = deduped.map((p) => p.iv);
  const spline = cubicSpline(deltas, ivs);

  return {
    spline,
    minDelta: deltas[0],
    maxDelta: deltas[deltas.length - 1],
    points: deduped,
    // get IV at a given strike
    ivAtStrike(strike) {
      const callDelta = pricingModel.delta(spot, strike, rfr, T, this.ivAtDelta(0.5), "Call");
      const absDelta = Math.abs(callDelta);
      return this.ivAtDelta(absDelta);
    },
    // get IV at a given absolute delta
    ivAtDelta(d) {
      const clamped = Math.max(this.minDelta, Math.min(this.maxDelta, d));
      return Math.max(0.01, spline(clamped));
    },
  };
}

// ── Vol Surface (across expiries) ───────────────────────────────────────
// Builds a full vol surface from chain data across multiple expirations.
// Uses flat forward variance interpolation between expiries.
// options.pricingModel: BS (equity) or Black76 (futures). Defaults to BS.
export function buildVolSurface(chainsByExpiry, spot, rfr = 0.05, { pricingModel = BS } = {}) {
  // chainsByExpiry: [{ expiry, dte, chain }]
  const pm = pricingModel;
  const smiles = [];
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
    iv(strike, dte) {
      if (!smiles.length) return 0.2; // fallback
      const T = Math.max(dte / 365, 1 / 365);

      // find bracketing expiries
      if (dte <= smiles[0].dte) {
        return smiles[0].smile.ivAtStrike(strike);
      }
      if (dte >= smiles[smiles.length - 1].dte) {
        return smiles[smiles.length - 1].smile.ivAtStrike(strike);
      }

      // interpolate using flat forward variance
      let lo = 0;
      for (let i = 0; i < smiles.length - 1; i++) {
        if (smiles[i].dte <= dte && smiles[i + 1].dte >= dte) {
          lo = i;
          break;
        }
      }

      const s0 = smiles[lo],
        s1 = smiles[lo + 1];
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
    callPrice(strike, dte) {
      const T = Math.max(dte / 365, 1 / 365);
      const sigma = this.iv(strike, dte);
      return pm.call(spot, strike, rfr, T, sigma);
    },

    // Get put price at any (strike, dte)
    putPrice(strike, dte) {
      const T = Math.max(dte / 365, 1 / 365);
      const sigma = this.iv(strike, dte);
      return pm.put(spot, strike, rfr, T, sigma);
    },

    // Generate a grid of IVs for visualization
    ivGrid(strikeRange, dteRange, strikeStep = 1, dteStep = 5) {
      const grid = [];
      for (let dte = dteRange[0]; dte <= dteRange[1]; dte += dteStep) {
        const row = [];
        for (let k = strikeRange[0]; k <= strikeRange[1]; k += strikeStep) {
          row.push({ strike: k, dte, iv: this.iv(k, dte) });
        }
        grid.push(row);
      }
      return grid;
    },
  };
}
