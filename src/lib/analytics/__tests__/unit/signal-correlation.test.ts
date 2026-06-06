import { describe, it, expect } from "vitest";
import {
  pearsonCorrelation,
  spearmanCorrelation,
  computeInformationCoefficient,
  computeICStability,
  computeTurnover,
  computeSignalCorrelation,
} from "../../signal-correlation.js";

describe("signal-correlation", () => {
  describe("pearsonCorrelation", () => {
    it("returns 1 for perfectly correlated data", () => {
      const x = [1, 2, 3, 4, 5];
      const y = [2, 4, 6, 8, 10];
      expect(pearsonCorrelation(x, y)).toBeCloseTo(1, 5);
    });

    it("returns -1 for perfectly inverse data", () => {
      const x = [1, 2, 3, 4, 5];
      const y = [10, 8, 6, 4, 2];
      expect(pearsonCorrelation(x, y)).toBeCloseTo(-1, 5);
    });

    it("returns 0 for insufficient data", () => {
      expect(pearsonCorrelation([1], [2])).toBe(0); // < 3 points
      expect(pearsonCorrelation([], [])).toBe(0);
    });
  });

  describe("spearmanCorrelation", () => {
    it("returns 1 for monotonically increasing", () => {
      expect(spearmanCorrelation([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 5);
    });

    it("handles non-linear but monotonic relationship", () => {
      const x = [1, 2, 3, 4, 5];
      const y = [1, 4, 9, 16, 25]; // x^2
      expect(spearmanCorrelation(x, y)).toBeCloseTo(1, 5);
    });
  });

  describe("computeInformationCoefficient", () => {
    it("returns high IC for good predictions", () => {
      const predictions = [0.1, 0.5, 0.2, 0.8, 0.3, 0.9, 0.4, 0.7, 0.6, 0.15];
      const outcomes = [0.12, 0.48, 0.19, 0.82, 0.31, 0.87, 0.41, 0.72, 0.58, 0.14];
      const result = computeInformationCoefficient(predictions, outcomes);
      expect(result.ic).toBeGreaterThan(0.5);
      expect(result.n).toBe(10);
    });

    it("returns 0 for random/insufficient data", () => {
      expect(computeInformationCoefficient([1], [2]).ic).toBe(0);
    });
  });

  describe("computeICStability", () => {
    it("returns low std for stable IC", () => {
      const n = 100;
      const predictions = Array.from({ length: n }, (_, i) => i * 0.01);
      const outcomes = predictions.map((v) => v + 0.001);
      const result = computeICStability(predictions, outcomes, 20);
      expect(result.mean_ic).toBeGreaterThan(0);
      expect(result.n_windows).toBeGreaterThan(0);
    });
  });

  describe("computeTurnover", () => {
    it("returns 0 for constant signals", () => {
      expect(computeTurnover([1, 1, 1, 1])).toBe(0);
    });

    it("returns 1 for alternating signals", () => {
      expect(computeTurnover([1, 2, 1, 2, 1])).toBe(1);
    });

    it("returns correct fraction", () => {
      expect(computeTurnover([1, 1, 2, 2, 1])).toBe(0.5);
    });
  });

  describe("computeSignalCorrelation", () => {
    it("returns correct structure", () => {
      const result = computeSignalCorrelation(
        [1, 2, 3, 4, 5],
        [2, 4, 6, 8, 10],
        "model-a",
        "model-b",
      );
      expect(result.model_a).toBe("model-a");
      expect(result.model_b).toBe("model-b");
      expect(result.coefficient).toBeCloseTo(1, 3);
      expect(result.method).toBe("spearman");
    });
  });
});
