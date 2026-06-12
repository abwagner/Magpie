import { describe, it, expect } from "vitest";
import { sabrImpliedVol, calibrateSABR } from "../sabr.js";

describe("sabrImpliedVol", () => {
  const F = 100,
    T = 0.5,
    alpha = 0.3,
    beta = 0.5,
    rho = -0.25,
    nu = 0.4;

  it("ATM vol is positive", () => {
    const vol = sabrImpliedVol(F, F, T, alpha, beta, rho, nu);
    expect(vol).toBeGreaterThan(0);
  });

  it("returns finite values for ITM and OTM", () => {
    expect(sabrImpliedVol(F, 80, T, alpha, beta, rho, nu)).toBeGreaterThan(0);
    expect(sabrImpliedVol(F, 120, T, alpha, beta, rho, nu)).toBeGreaterThan(0);
    expect(isFinite(sabrImpliedVol(F, 80, T, alpha, beta, rho, nu))).toBe(true);
  });

  it("negative rho produces downside skew (put IV > call IV)", () => {
    const ivOTMPut = sabrImpliedVol(F, 85, T, alpha, beta, -0.5, nu);
    const ivOTMCall = sabrImpliedVol(F, 115, T, alpha, beta, -0.5, nu);
    expect(ivOTMPut).toBeGreaterThan(ivOTMCall);
  });

  it("positive rho produces upside skew", () => {
    const ivOTMPut = sabrImpliedVol(F, 85, T, alpha, beta, 0.5, nu);
    const ivOTMCall = sabrImpliedVol(F, 115, T, alpha, beta, 0.5, nu);
    expect(ivOTMCall).toBeGreaterThan(ivOTMPut);
  });

  it("higher nu produces more smile curvature", () => {
    const ivWingLowNu = sabrImpliedVol(F, 80, T, alpha, beta, rho, 0.1);
    const ivWingHighNu = sabrImpliedVol(F, 80, T, alpha, beta, rho, 0.8);
    const ivATMLowNu = sabrImpliedVol(F, F, T, alpha, beta, rho, 0.1);
    const ivATMHighNu = sabrImpliedVol(F, F, T, alpha, beta, rho, 0.8);
    const curveLow = ivWingLowNu - ivATMLowNu;
    const curveHigh = ivWingHighNu - ivATMHighNu;
    expect(curveHigh).toBeGreaterThan(curveLow);
  });

  it("returns a value for T=0 (instantaneous vol)", () => {
    const vol = sabrImpliedVol(F, F, 0, alpha, beta, rho, nu);
    // T=0 returns alpha or 0 depending on implementation; just check it's non-negative
    expect(vol).toBeGreaterThanOrEqual(0);
  });

  it("beta=1 (lognormal) gives reasonable values", () => {
    const vol = sabrImpliedVol(100, 100, 0.5, 0.2, 1.0, -0.3, 0.3);
    expect(vol).toBeGreaterThan(0.1);
    expect(vol).toBeLessThan(0.5);
  });
});

describe("calibrateSABR", () => {
  it("calibrates to synthetic SABR data", () => {
    // generate synthetic data from known SABR params
    const F = 100,
      T = 0.5;
    const trueAlpha = 0.25,
      trueBeta = 0.5,
      trueRho = -0.3,
      trueNu = 0.4;
    const strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
    const ivs = strikes.map((K) => sabrImpliedVol(F, K, T, trueAlpha, trueBeta, trueRho, trueNu));

    const result = calibrateSABR(strikes, ivs, F, T, { beta: trueBeta });

    expect(result.rmse).toBeLessThan(0.005);
    expect(result.alpha).toBeCloseTo(trueAlpha, 1);
    expect(result.rho).toBeCloseTo(trueRho, 1);
    expect(result.nu).toBeCloseTo(trueNu, 1);
  });

  it("fitted IVs match market IVs closely", () => {
    const F = 100,
      T = 0.25;
    const strikes = [90, 95, 100, 105, 110];
    const ivs = [0.25, 0.22, 0.2, 0.19, 0.195]; // typical equity skew

    const result = calibrateSABR(strikes, ivs, F, T);

    for (let i = 0; i < strikes.length; i++) {
      expect(result.fittedIVs[i]).toBeCloseTo(ivs[i]!, 1);
    }
  });

  it("iv() function works for interpolation", () => {
    const F = 100,
      T = 0.5;
    const strikes = [85, 90, 95, 100, 105, 110, 115];
    const ivs = strikes.map((K) => 0.2 + (0.002 * (K - 100) ** 2) / 100);

    const result = calibrateSABR(strikes, ivs, F, T);
    const interpIV = result.iv(97.5); // between strikes
    expect(interpIV).toBeGreaterThan(0.1);
    expect(interpIV).toBeLessThan(0.4);
  });

  it("returns valid params", () => {
    const F = 100,
      T = 0.5;
    const strikes = [90, 95, 100, 105, 110];
    const ivs = [0.24, 0.22, 0.2, 0.19, 0.2];

    const result = calibrateSABR(strikes, ivs, F, T);
    expect(result.alpha).toBeGreaterThan(0);
    expect(result.nu).toBeGreaterThan(0);
    expect(result.rho).toBeGreaterThan(-1);
    expect(result.rho).toBeLessThan(1);
  });
});
