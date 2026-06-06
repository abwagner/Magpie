import { describe, it, expect } from "vitest";
import { parse, format, toSubjectTokens, toFilename, fromFilename } from "../../symbol.js";

describe("symbol", () => {
  describe("parse + format round-trip", () => {
    const cases = [
      "EQ:SPY",
      "OPT:SPY:2026-01-16:C:500",
      "OPT:SPY:2026-01-16:P:4787.5",
      "FUT:ES:2026-06",
      "FOP:ES:2026-06:2026-05-23:C:5000",
      "V:regime-spx-vol",
    ];

    for (const sym of cases) {
      it(`round-trips "${sym}"`, () => {
        expect(format(parse(sym))).toBe(sym);
      });
    }
  });

  describe("parse", () => {
    it("parses EQ symbol", () => {
      const result = parse("EQ:SPY");
      expect(result).toEqual({ class: "EQ", ticker: "SPY" });
    });

    it("parses OPT symbol", () => {
      const result = parse("OPT:SPY:2026-01-16:C:500");
      expect(result).toEqual({
        class: "OPT",
        root: "SPY",
        expiry: "2026-01-16",
        right: "C",
        strike: 500,
      });
    });

    it("parses FUT symbol", () => {
      const result = parse("FUT:ES:2026-06");
      expect(result).toEqual({ class: "FUT", root: "ES", contract: "2026-06" });
    });

    it("parses FOP symbol", () => {
      const result = parse("FOP:ES:2026-06:2026-05-23:C:5000");
      expect(result).toEqual({
        class: "FOP",
        root: "ES",
        contract: "2026-06",
        expiry: "2026-05-23",
        right: "C",
        strike: 5000,
      });
    });

    it("parses V symbol", () => {
      const result = parse("V:regime-spx-vol");
      expect(result).toEqual({ class: "V", label: "regime-spx-vol" });
    });

    it("throws on empty string", () => {
      expect(() => parse("")).toThrow();
    });

    it("throws on unknown class", () => {
      expect(() => parse("STOCK:SPY")).toThrow("Unknown symbol class");
    });

    it("throws on malformed OPT (wrong part count)", () => {
      expect(() => parse("OPT:SPY:2026-01-16:C")).toThrow();
    });

    it("throws on invalid strike", () => {
      expect(() => parse("OPT:SPY:2026-01-16:C:abc")).toThrow("Invalid strike");
    });

    it("throws on invalid right", () => {
      expect(() => parse("OPT:SPY:2026-01-16:X:500")).toThrow("Invalid right");
    });

    it("handles decimal strikes without trailing zeros", () => {
      const result = parse("OPT:SPY:2026-01-16:P:4787.5");
      expect(result.class).toBe("OPT");
      if (result.class === "OPT") {
        expect(result.strike).toBe(4787.5);
      }
    });
  });

  describe("toSubjectTokens", () => {
    it("EQ → [EQ, ticker]", () => {
      expect(toSubjectTokens(parse("EQ:SPY"))).toEqual(["EQ", "SPY"]);
    });

    it("OPT → [OPT, root, expiry, right, strike]", () => {
      expect(toSubjectTokens(parse("OPT:SPY:2026-01-16:C:500"))).toEqual([
        "OPT",
        "SPY",
        "2026-01-16",
        "C",
        "500",
      ]);
    });

    it("FUT → [FUT, root, contract]", () => {
      expect(toSubjectTokens(parse("FUT:ES:2026-06"))).toEqual(["FUT", "ES", "2026-06"]);
    });

    it("V → [V, label]", () => {
      expect(toSubjectTokens(parse("V:regime-spx-vol"))).toEqual(["V", "regime-spx-vol"]);
    });
  });

  describe("toFilename / fromFilename", () => {
    it("converts colons to dashes", () => {
      expect(toFilename("EQ:SPY")).toBe("EQ-SPY");
      expect(toFilename("OPT:SPY:2026-01-16:C:500")).toBe("OPT-SPY-2026-01-16-C-500");
    });

    it("round-trips EQ", () => {
      expect(fromFilename(toFilename("EQ:SPY"))).toBe("EQ:SPY");
    });

    it("round-trips OPT", () => {
      expect(fromFilename(toFilename("OPT:SPY:2026-01-16:C:500"))).toBe("OPT:SPY:2026-01-16:C:500");
    });

    it("round-trips V", () => {
      expect(fromFilename(toFilename("V:regime-spx-vol"))).toBe("V:regime-spx-vol");
    });
  });
});
