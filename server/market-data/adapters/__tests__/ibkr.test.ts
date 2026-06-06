import { describe, it, expect } from "vitest";
import {
  ibDateToIso,
  isoToIbDate,
  daysUntil,
  exchangeForRoot,
  windowStrikesAroundAtm,
} from "../ibkr.js";

describe("ibDateToIso", () => {
  it("converts IB YYYYMMDD to ISO", () => {
    expect(ibDateToIso("20260619")).toBe("2026-06-19");
  });
});

describe("isoToIbDate", () => {
  it("strips hyphens from ISO date", () => {
    expect(isoToIbDate("2026-06-19")).toBe("20260619");
  });

  it("is inverse of ibDateToIso", () => {
    expect(isoToIbDate(ibDateToIso("20260101"))).toBe("20260101");
  });
});

describe("daysUntil", () => {
  it("returns 0 for past dates", () => {
    expect(daysUntil("2020-01-01")).toBe(0);
  });

  it("returns positive count for future dates", () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    expect(daysUntil(future)).toBeGreaterThan(28);
    expect(daysUntil(future)).toBeLessThanOrEqual(30);
  });
});

describe("exchangeForRoot", () => {
  it("maps energy roots to NYMEX", () => {
    expect(exchangeForRoot("CL")).toBe("NYMEX");
    expect(exchangeForRoot("NG")).toBe("NYMEX");
  });

  it("maps index roots to CME", () => {
    expect(exchangeForRoot("ES")).toBe("CME");
    expect(exchangeForRoot("NQ")).toBe("CME");
  });

  it("maps metals to COMEX", () => {
    expect(exchangeForRoot("GC")).toBe("COMEX");
  });

  it("accepts lowercase input", () => {
    expect(exchangeForRoot("cl")).toBe("NYMEX");
  });

  it("defaults unknown roots to NYMEX", () => {
    expect(exchangeForRoot("UNKNOWN")).toBe("NYMEX");
  });
});

describe("windowStrikesAroundAtm", () => {
  it("returns empty when strike list is empty", () => {
    expect(windowStrikesAroundAtm([], 100)).toEqual([]);
  });

  it("sorts input ascending", () => {
    const result = windowStrikesAroundAtm([105, 100, 110, 95], 102, 10);
    expect(result).toEqual([95, 100, 105, 110]);
  });

  it("centers window on strike nearest spot", () => {
    const strikes = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const result = windowStrikesAroundAtm(strikes, 50, 5);
    expect(result).toEqual([45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);
  });

  it("clips at lower bound when ATM is near start", () => {
    const strikes = [10, 20, 30, 40, 50];
    const result = windowStrikesAroundAtm(strikes, 12, 2);
    expect(result).toEqual([10, 20, 30]);
  });

  it("clips at upper bound when ATM is near end", () => {
    const strikes = [10, 20, 30, 40, 50];
    const result = windowStrikesAroundAtm(strikes, 48, 2);
    expect(result).toEqual([30, 40, 50]);
  });
});
