// ── SABR Model ──────────────────────────────────────────────────────────
// Hagan et al. (2002) SABR implied volatility approximation.
// Parameters: α (vol level), β (backbone), ρ (correlation/skew), ν (vol-of-vol)

// Hagan formula for SABR implied vol
export function sabrImpliedVol(F, K, T, alpha, beta, rho, nu) {
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

export function calibrateSABR(marketStrikes, marketIVs, forward, T, options = {}) {
  const { beta = 0.5, maxIter = 500, tol = 1e-8 } = options;

  // objective: sum of squared errors between SABR and market IVs
  function objective([alpha, rho, nu]) {
    if (alpha <= 0 || nu <= 0 || rho <= -1 || rho >= 1) return 1e10;
    let sse = 0;
    for (let i = 0; i < marketStrikes.length; i++) {
      const modelIV = sabrImpliedVol(forward, marketStrikes[i], T, alpha, beta, rho, nu);
      if (!isFinite(modelIV) || modelIV <= 0) return 1e10;
      sse += (modelIV - marketIVs[i]) ** 2;
    }
    return sse;
  }

  // initial guess
  const atmIdx = marketStrikes.reduce(
    (best, k, i) => (Math.abs(k - forward) < Math.abs(marketStrikes[best] - forward) ? i : best),
    0,
  );
  const atmIV = marketIVs[atmIdx];
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

  const [alpha, rho, nu] = result.x;

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
    iv(strike) {
      return sabrImpliedVol(forward, strike, T, alpha, beta, rho, nu);
    },
  };
}

// ── Nelder-Mead Simplex Optimizer ───────────────────────────────────────
// Simple unconstrained optimization. Bounds enforced via penalty.
function nelderMead(fn, x0, options = {}) {
  const { maxIter = 500, tol = 1e-8, bounds } = options;
  const n = x0.length;

  function penalizedFn(x) {
    if (bounds) {
      for (let i = 0; i < n; i++) {
        if (x[i] < bounds[i][0] || x[i] > bounds[i][1]) return 1e15;
      }
    }
    return fn(x);
  }

  // initialize simplex
  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += Math.abs(p[i]) * 0.1 + 0.01;
    simplex.push(p);
  }

  const fvals = simplex.map((p) => penalizedFn(p));

  for (let iter = 0; iter < maxIter; iter++) {
    // sort by function value
    const order = Array.from({ length: n + 1 }, (_, i) => i);
    order.sort((a, b) => fvals[a] - fvals[b]);

    const sorted = order.map((i) => simplex[i].slice());
    const sortedF = order.map((i) => fvals[i]);

    for (let i = 0; i <= n; i++) {
      simplex[i] = sorted[i];
      fvals[i] = sortedF[i];
    }

    // check convergence
    if (Math.abs(fvals[n] - fvals[0]) < tol) break;

    // centroid (excluding worst)
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
      centroid.forEach((_, j) => {
        if (i === n - 1) centroid[j] /= n;
      });
    }
    // fix: compute centroid properly
    for (let j = 0; j < n; j++) {
      centroid[j] = 0;
      for (let i = 0; i < n; i++) centroid[j] += simplex[i][j];
      centroid[j] /= n;
    }

    // reflection
    const reflected = centroid.map((c, j) => 2 * c - simplex[n][j]);
    const fr = penalizedFn(reflected);

    if (fr < fvals[0]) {
      // expansion
      const expanded = centroid.map((c, j) => 3 * c - 2 * simplex[n][j]);
      const fe = penalizedFn(expanded);
      if (fe < fr) {
        simplex[n] = expanded;
        fvals[n] = fe;
      } else {
        simplex[n] = reflected;
        fvals[n] = fr;
      }
    } else if (fr < fvals[n - 1]) {
      simplex[n] = reflected;
      fvals[n] = fr;
    } else {
      // contraction
      const contracted = centroid.map((c, j) => (c + simplex[n][j]) / 2);
      const fc = penalizedFn(contracted);
      if (fc < fvals[n]) {
        simplex[n] = contracted;
        fvals[n] = fc;
      } else {
        // shrink
        for (let i = 1; i <= n; i++) {
          for (let j = 0; j < n; j++) {
            simplex[i][j] = (simplex[0][j] + simplex[i][j]) / 2;
          }
          fvals[i] = penalizedFn(simplex[i]);
        }
      }
    }
  }

  // find best
  let bestIdx = 0;
  for (let i = 1; i <= n; i++) if (fvals[i] < fvals[bestIdx]) bestIdx = i;

  return { x: simplex[bestIdx], fx: fvals[bestIdx] };
}
