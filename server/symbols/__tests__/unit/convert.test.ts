import { describe, it, expect } from "vitest";
import {
  contractToCanonical,
  canonicalToContractFields,
  canonicalToUnderlying,
} from "../../convert.js";

describe("convert", () => {
  describe("contractToCanonical", () => {
    it("converts option contract to canonical", () => {
      expect(
        contractToCanonical({
          underlying: "SPY",
          strike: 500,
          side: "call",
          expiration: "2026-01-16",
        }),
      ).toBe("OPT:SPY:2026-01-16:C:500");
    });

    it("converts put contract to canonical", () => {
      expect(
        contractToCanonical({
          underlying: "SPY",
          strike: 500,
          side: "put",
          expiration: "2026-01-16",
        }),
      ).toBe("OPT:SPY:2026-01-16:P:500");
    });

    it("converts equity-only contract to EQ", () => {
      expect(contractToCanonical({ underlying: "SPY" })).toBe("EQ:SPY");
    });
  });

  describe("canonicalToContractFields", () => {
    it("converts OPT canonical to contract fields", () => {
      const result = canonicalToContractFields("OPT:SPY:2026-01-16:C:500");
      expect(result).toEqual({
        underlying: "SPY",
        strike: 500,
        side: "call",
        expiration: "2026-01-16",
      });
    });

    it("converts EQ canonical to contract fields", () => {
      expect(canonicalToContractFields("EQ:SPY")).toEqual({ underlying: "SPY" });
    });

    it("converts FUT canonical to contract fields", () => {
      expect(canonicalToContractFields("FUT:ES:2026-06")).toEqual({ underlying: "ES" });
    });

    it("round-trips OPT", () => {
      const canonical = "OPT:SPY:2026-01-16:C:500";
      const fields = canonicalToContractFields(canonical);
      expect(contractToCanonical(fields)).toBe(canonical);
    });
  });

  describe("canonicalToUnderlying", () => {
    it("EQ → ticker", () => expect(canonicalToUnderlying("EQ:SPY")).toBe("SPY"));
    it("OPT → root", () => expect(canonicalToUnderlying("OPT:SPY:2026-01-16:C:500")).toBe("SPY"));
    it("FUT → root", () => expect(canonicalToUnderlying("FUT:ES:2026-06")).toBe("ES"));
    it("FOP → root", () =>
      expect(canonicalToUnderlying("FOP:ES:2026-06:2026-05-23:C:5000")).toBe("ES"));
    it("V → label", () => expect(canonicalToUnderlying("V:regime-spx-vol")).toBe("regime-spx-vol"));
  });
});
