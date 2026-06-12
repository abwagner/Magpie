// ── SABR Model ──────────────────────────────────────────────────────────
// Hagan et al. (2002) SABR implied volatility approximation.
// Parameters: α (vol level), β (backbone), ρ (correlation/skew), ν (vol-of-vol)

export interface CalibrateSABROptions {
  beta?: number;
  maxIter?: number;
  tol?: number;
}

export interface SABRCalibration {
  alpha: number;
  beta: number;
  rho: number;
  nu: number;
  rmse: number;
  fittedIVs: number[];
  forward: number;
  T: number;
  iv(strike: number): number;
}

interface NelderMeadOptions {
  maxIter?: number;
  tol?: number;
  bounds?: [number, number][];
}

interface NelderMeadResult {
  x: number[];
  fx: number;
}

// Hagan formula for SABR implied vol
export function sabrImpliedVol(
  F: number,
  K: number,
  T: number,
  alpha: number,
  beta: number,
  rho: number,
  nu: number,
): number {
  if (T <= 0 || alpha <= 0) return alpha || 0;
  if (Math.abs(F - K) < 1e-10) {
    // ATM case
    const FK_mid = Math.pow(F, 1 - beta);
    const term1 = ((1 - beta) ** 2 / 24) * (alpha ** 2 / FK_mid ** 2);
    const term2 = (rho * beta * nu * alpha) / (4 * FK_mid);
    const term3 = ((2 - 3 * rho ** 2) / 24) * nu ** 2;
    return (alpha / FK_mid) * (1 + (term1 + term2 + term3) * T);
  }

  const FK = F * K;
  const FK_beta = Math.pow(FK, (1 - beta) / 2);
  const logFK = Math.log(F / K);

  const z = (nu / alpha) * FK_beta * logFK;
  const x = Math.log((Math.sqrt(1 - 2 * rho * z + z * z) + z - rho) / (1 - rho));

  if (Math.abs(x) < 1e-10) return alpha / FK_beta;

  const prefix =
    alpha /
    (FK_beta * (1 + ((1 - beta) ** 2 / 24) * logFK ** 2 + ((1 - beta) ** 4 / 1920) * logFK ** 4));
  const zOverX = z / x;

  const term1 = ((1 - beta) ** 2 / 24) * (alpha ** 2 / Math.pow(FK, 1 - beta));
  const term2 = (rho * beta * nu * alpha) / (4 * FK_beta);
  const term3 = ((2 - 3 * rho ** 2) / 24) * nu ** 2;

  return prefix * zOverX * (1 + (term1 + term2 + term3) * T);
}

// ── Calibration ─────────────────────────────────────────────────────────
// Fit SABR parameters to market implied vols using Nelder-Mead optimization.
// β is fixed (default 0.5 for equities, 1.0 for rates).

export function calibrateSABR(
  marketStrikes: number[],
  marketIVs: number[],
  forward: number,
  T: number,
  options: CalibrateSABROptions = {},
): SABRCalibration {
  const { beta = 0.5, maxIter = 500, tol = 1e-8 } = options;

  // objective: sum of squared errors between SABR and market IVs
  function objective(params: number[]): number {
    const alpha = params[0] as number;
    const rho = params[1] as number;
    const nu = params[2] as number;
    if (alpha <= 0 || nu <= 0 || rho <= -1 || rho >= 1) return 1e10;
    let sse = 0;
    for (let i = 0; i < marketStrikes.length; i++) {
      const modelIV = sabrImpliedVol(forward, marketStrikes[i] as number, T, alpha, beta, rho, nu);
      if (!isFinite(modelIV) || modelIV <= 0) return 1e10;
      sse += (modelIV - (marketIVs[i] as number)) ** 2;
    }
    return sse;
  }

  // initial guess
  const atmIdx = marketStrikes.reduce(
    (best, k, i) =>
      Math.abs(k - forward) < Math.abs((marketStrikes[best] as number) - forward) ? i : best,
    0,
  );
  const atmIV = marketIVs[atmIdx] as number;
  const FK_beta = Math.pow(forward, 1 - beta);
  const alpha0 = atmIV * FK_beta;

  const result = nelderMead(objective, [alpha0, -0.3, 0.3], {
    maxIter,
    tol,
    bounds: [
      [0.001, 5],
      [-0.999, 0.999],
      [0.001, 5],
    ],
  });

  const alpha = result.x[0] as number;
  const rho = result.x[1] as number;
  const nu = result.x[2] as number;

  // compute fitted IVs
  const fittedIVs = marketStrikes.map((K) => sabrImpliedVol(forward, K, T, alpha, beta, rho, nu));
  const rmse = Math.sqrt(result.fx / marketStrikes.length);

  return {
    alpha,
    beta,
    rho,
    nu,
    rmse,
    fittedIVs,
    forward,
    T,
    // get IV at any strike
    iv(strike: number): number {
      return sabrImpliedVol(forward, strike, T, alpha, beta, rho, nu);
    },
  };
}

// ── Nelder-Mead Simplex Optimizer ───────────────────────────────────────
// Simple unconstrained optimization. Bounds enforced via penalty.
function nelderMead(
  fn: (x: number[]) => number,
  x0: number[],
  options: NelderMeadOptions = {},
): NelderMeadResult {
  const { maxIter = 500, tol = 1e-8, bounds } = options;
  const n = x0.length;

  function penalizedFn(x: number[]): number {
    if (bounds) {
      for (let i = 0; i < n; i++) {
        const b = bounds[i];
        if (b && (x[i]! < b[0] || x[i]! > b[1])) return 1e15;
      }
    }
    return fn(x);
  }

  // initialize simplex
  const simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] = (p[i] as number) + Math.abs(p[i] as number) * 0.1 + 0.01;
    simplex.push(p);
  }

  const fvals = simplex.map((p) => penalizedFn(p));

  for (let iter = 0; iter < maxIter; iter++) {
    // sort by function value
    const order = Array.from({ length: n + 1 }, (_, i) => i);
    order.sort((a, b) => (fvals[a] as number) - (fvals[b] as number));

    const sorted = order.map((i) => (simplex[i] as number[]).slice());
    const sortedF = order.map((i) => fvals[i] as number);

    for (let i = 0; i <= n; i++) {
      simplex[i] = sorted[i] as number[];
      fvals[i] = sortedF[i] as number;
    }

    // check convergence
    if (Math.abs((fvals[n] as number) - (fvals[0] as number)) < tol) break;

    // centroid (excluding worst)
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const row = simplex[i] as number[];
      for (let j = 0; j < n; j++) centroid[j] = (centroid[j] as number) + (row[j] as number);
      centroid.forEach((_, j) => {
        if (i === n - 1) centroid[j] = (centroid[j] as number) / n;
      });
    }
    // fix: compute centroid properly
    for (let j = 0; j < n; j++) {
      centroid[j] = 0;
      for (let i = 0; i < n; i++)
        centroid[j] = (centroid[j] as number) + ((simplex[i] as number[])[j] as number);
      centroid[j] = (centroid[j] as number) / n;
    }

    const worst = simplex[n] as number[];

    // reflection
    const reflected = centroid.map((c, j) => 2 * c - (worst[j] as number));
    const fr = penalizedFn(reflected);

    if (fr < (fvals[0] as number)) {
      // expansion
      const expanded = centroid.map((c, j) => 3 * c - 2 * (worst[j] as number));
      const fe = penalizedFn(expanded);
      if (fe < fr) {
        simplex[n] = expanded;
        fvals[n] = fe;
      } else {
        simplex[n] = reflected;
        fvals[n] = fr;
      }
    } else if (fr < (fvals[n - 1] as number)) {
      simplex[n] = reflected;
      fvals[n] = fr;
    } else {
      // contraction
      const contracted = centroid.map((c, j) => (c + (worst[j] as number)) / 2);
      const fc = penalizedFn(contracted);
      if (fc < (fvals[n] as number)) {
        simplex[n] = contracted;
        fvals[n] = fc;
      } else {
        // shrink
        const first = simplex[0] as number[];
        for (let i = 1; i <= n; i++) {
          const row = simplex[i] as number[];
          for (let j = 0; j < n; j++) {
            row[j] = ((first[j] as number) + (row[j] as number)) / 2;
          }
          fvals[i] = penalizedFn(row);
        }
      }
    }
  }

  // find best
  let bestIdx = 0;
  for (let i = 1; i <= n; i++) if ((fvals[i] as number) < (fvals[bestIdx] as number)) bestIdx = i;

  return { x: simplex[bestIdx] as number[], fx: fvals[bestIdx] as number };
}
