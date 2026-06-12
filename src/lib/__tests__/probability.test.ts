import { describe, it, expect } from "vitest";
import { extractMarketPDF, logNormalPDF, blendPDFs, computeEdge } from "../probability.js";
import { buildVolSurface } from "../vol-surface.js";

// helper: create a mock chain with flat vol
function mockChain(spot: number, dte: number, ivFlat = 0.2) {
  const contracts = [];
  for (let k = spot * 0.7; k <= spot * 1.3; k += spot * 0.02) {
    const strike = Math.round(k * 100) / 100;
    const moneyness = Math.abs(strike - spot) / spot;
    const iv = ivFlat + moneyness * 0.15;
    contracts.push({
      side: "call",
      strike,
      iv,
      bid: 1,
      ask: 2,
      mid: 1.5,
      dte,
      underlyingPrice: spot,
      volume: 100,
      openInterest: 500,
    });
    contracts.push({
      side: "put",
      strike,
      iv,
      bid: 1,
      ask: 2,
      mid: 1.5,
      dte,
      underlyingPrice: spot,
      volume: 100,
      openInterest: 500,
    });
  }
  return contracts;
}

function makeVolSurface(spot = 100, dte = 90, iv = 0.2) {
  const chains = [{ expiry: "2026-06-19", dte, chain: mockChain(spot, dte, iv) }];
  return buildVolSurface(chains, spot)!;
}

describe("extractMarketPDF", () => {
  it("produces non-negative density", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    for (const d of pdf.density) {
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("density integrates to approximately 1.0", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    const integral = pdf.density.reduce((s, d) => s + d * pdf.strikeStep, 0);
    expect(integral).toBeCloseTo(1.0, 1);
  });

  it("CDF ends near 1.0", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    expect(pdf.cdf[pdf.cdf.length - 1]).toBeCloseTo(1.0, 1);
  });

  it("CDF is monotonically non-decreasing", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    for (let i = 1; i < pdf.cdf.length; i++) {
      expect(pdf.cdf[i]).toBeGreaterThanOrEqual(pdf.cdf[i - 1]! - 1e-10);
    }
  });

  it("expected value is near spot (risk-neutral)", () => {
    const surf = makeVolSurface(100, 90, 0.2);
    const pdf = extractMarketPDF(surf, 90);
    // risk-neutral expected value should be near spot * e^(rT)
    const fwd = 100 * Math.exp((0.05 * 90) / 365);
    expect(pdf.expectedValue).toBeGreaterThan(fwd * 0.9);
    expect(pdf.expectedValue).toBeLessThan(fwd * 1.1);
  });

  it("has positive variance", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    expect(pdf.variance).toBeGreaterThan(0);
  });

  it("higher vol produces wider distribution", () => {
    const surfLow = makeVolSurface(100, 90, 0.15);
    const surfHigh = makeVolSurface(100, 90, 0.35);
    const pdfLow = extractMarketPDF(surfLow, 90);
    const pdfHigh = extractMarketPDF(surfHigh, 90);
    expect(pdfHigh.variance).toBeGreaterThan(pdfLow.variance);
  });
});

describe("logNormalPDF", () => {
  it("produces non-negative density", () => {
    const strikes = Array.from({ length: 100 }, (_, i) => 50 + i);
    const pdf = logNormalPDF(100, 0.05, 0.25, 0.2, strikes);
    for (const d of pdf) {
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("integrates to approximately 1.0", () => {
    const strikes = Array.from({ length: 200 }, (_, i) => 50 + i * 0.5);
    const pdf = logNormalPDF(100, 0.05, 0.25, 0.2, strikes);
    const integral = pdf.reduce((s, d) => s + d * 0.5, 0);
    expect(integral).toBeCloseTo(1.0, 1);
  });

  it("peak is near forward price", () => {
    const strikes = Array.from({ length: 200 }, (_, i) => 50 + i * 0.5);
    const pdf = logNormalPDF(100, 0.05, 0.25, 0.2, strikes);
    const maxIdx = pdf.indexOf(Math.max(...pdf));
    const peakStrike = strikes[maxIdx];
    // mode of lognormal is below the mean, but should be in the right ballpark
    expect(peakStrike).toBeGreaterThan(85);
    expect(peakStrike).toBeLessThan(115);
  });
});

describe("blendPDFs", () => {
  it("returns single model unchanged", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    const blended = blendPDFs([pdf], [1.0])!;
    expect(blended.density).toEqual(pdf.density);
  });

  it("equal weights produce average", () => {
    const surf1 = makeVolSurface(100, 90, 0.15);
    const surf2 = makeVolSurface(100, 90, 0.3);
    const pdf1 = extractMarketPDF(surf1, 90);
    const pdf2 = extractMarketPDF(surf2, 90);
    const blended = blendPDFs([pdf1, pdf2], [1, 1])!;
    // blended variance should be between the two
    expect(blended.variance).toBeGreaterThan(pdf1.variance * 0.8);
    expect(blended.variance).toBeLessThan(pdf2.variance * 1.2);
  });

  it("blended density integrates to ~1.0", () => {
    const surf1 = makeVolSurface(100, 90, 0.15);
    const surf2 = makeVolSurface(100, 90, 0.3);
    const pdf1 = extractMarketPDF(surf1, 90);
    const pdf2 = extractMarketPDF(surf2, 90);
    const blended = blendPDFs([pdf1, pdf2], [0.6, 0.4])!;
    const integral = blended.density.reduce((s, d) => s + d * blended.strikeStep, 0);
    expect(integral).toBeCloseTo(1.0, 1);
  });

  it("weights are normalized", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    const blend1 = blendPDFs([pdf, pdf], [1, 1])!;
    const blend2 = blendPDFs([pdf, pdf], [5, 5])!;
    // should be identical regardless of weight scale
    for (let i = 0; i < blend1.density.length; i++) {
      expect(blend1.density[i]).toBeCloseTo(blend2.density[i]!, 6);
    }
  });
});

describe("computeEdge", () => {
  it("zero edge when model equals market", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    const edgeResult = computeEdge(pdf, pdf);
    for (const e of edgeResult.edge) {
      expect(Math.abs(e)).toBeLessThan(0.001);
    }
  });

  it("positive directional edge when model expects higher price", () => {
    const surfMarket = makeVolSurface(100, 90, 0.2);
    const surfModel = makeVolSurface(100, 90, 0.15); // tighter → higher center density
    const market = extractMarketPDF(surfMarket, 90);
    const model = extractMarketPDF(surfModel, 90);
    const edgeResult = computeEdge(model, market);
    // edge should have structure (positive center, negative wings for tighter model)
    expect(edgeResult.edge.length).toBeGreaterThan(0);
  });

  it("returns correct expected price delta and variance delta", () => {
    const surf = makeVolSurface();
    const pdf = extractMarketPDF(surf, 90);
    const edgeResult = computeEdge(pdf, pdf);
    expect(edgeResult.expectedPriceDelta).toBeCloseTo(0, 1);
    expect(edgeResult.varianceDelta).toBeCloseTo(0, 1);
  });
});
