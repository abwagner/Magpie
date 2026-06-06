/**
 * Integration test: Analytics — signal correlation on realistic data.
 *
 * Strategy-metrics integration coverage was removed in QF-226 alongside
 * the strategy-metrics module. Signal correlation is the only analytics
 * surface that still has live consumers (analyze-signals.ts).
 */
import { describe, it, expect } from "vitest";
import { pearsonCorrelation, computeInformationCoefficient } from "../../signal-correlation.js";

describe("analytics integration", () => {
  describe("signal correlation on realistic data", () => {
    it("detects high correlation between similar signals", () => {
      // Two signals that move together with slight noise
      const a = Array.from({ length: 100 }, (_, i) => Math.sin(i / 10));
      const b = Array.from({ length: 100 }, (_, i) => Math.sin(i / 10) + Math.random() * 0.1);

      const corr = pearsonCorrelation(a, b);
      expect(corr).toBeGreaterThan(0.9);
    });

    it("detects low correlation between independent signals", () => {
      const a = Array.from({ length: 100 }, () => Math.random());
      const b = Array.from({ length: 100 }, () => Math.random());

      const corr = Math.abs(pearsonCorrelation(a, b));
      expect(corr).toBeLessThan(0.3);
    });

    it("computes meaningful IC for a predictive signal", () => {
      // Signal predicts forward returns with noise
      const signals = Array.from({ length: 200 }, () => Math.random() - 0.5);
      const returns = signals.map((s) => s * 0.5 + (Math.random() - 0.5) * 0.3);

      const result = computeInformationCoefficient(signals, returns);
      expect(result.ic).toBeGreaterThan(0.2);
    });

    it("computes near-zero IC for random signal", () => {
      const signals = Array.from({ length: 200 }, () => Math.random());
      const returns = Array.from({ length: 200 }, () => Math.random() - 0.5);

      const result = computeInformationCoefficient(signals, returns);
      expect(Math.abs(result.ic)).toBeLessThan(0.15);
    });
  });
});
