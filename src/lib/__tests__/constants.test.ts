import { describe, it, expect } from "vitest";
import { formatAge, pickDefault6mo, DFLT_SC } from "../constants.js";

describe("formatAge", () => {
  const now = Date.now();
  it("returns null for falsy ts", () => {
    expect(formatAge(null, now)).toBeNull();
    expect(formatAge(0, now)).toBeNull();
  });
  it("shows seconds for < 60s", () => {
    expect(formatAge(now - 30000, now)).toBe("30s ago");
  });
  it("shows minutes for < 60m", () => {
    expect(formatAge(now - 300000, now)).toBe("5m ago");
  });
  it("shows hours for < 24h", () => {
    expect(formatAge(now - 7200000, now)).toBe("2h ago");
  });
  it("shows days for >= 24h", () => {
    expect(formatAge(now - 172800000, now)).toBe("2d ago");
  });
});

describe("pickDefault6mo", () => {
  it("returns empty string for empty array", () => {
    expect(pickDefault6mo([])).toBe("");
  });
  it("picks date closest to 6 months from now", () => {
    const today = new Date();
    const target = new Date(today);
    target.setMonth(target.getMonth() + 6);
    const dates = ["2026-04-17", "2026-06-19", "2026-09-18", "2026-12-18"];
    const picked = pickDefault6mo(dates);
    // should be one of the dates
    expect(dates).toContain(picked);
  });
  it("returns only option when single date", () => {
    expect(pickDefault6mo(["2026-06-19"])).toBe("2026-06-19");
  });
});

describe("DFLT_SC", () => {
  it("has 5 default scenarios", () => {
    expect(DFLT_SC).toHaveLength(5);
  });
  it("probabilities sum to 1", () => {
    const sum = DFLT_SC.reduce((s, sc) => s + sc.prob, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
  it("each scenario has required fields", () => {
    for (const sc of DFLT_SC) {
      expect(sc).toHaveProperty("id");
      expect(sc).toHaveProperty("name");
      expect(sc).toHaveProperty("prob");
      expect(sc).toHaveProperty("priceMove");
      expect(sc).toHaveProperty("iv_shift");
    }
  });
  it("each scenario has unique id", () => {
    const ids = DFLT_SC.map((sc) => sc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
