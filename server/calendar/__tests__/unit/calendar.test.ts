import { describe, it, expect } from "vitest";
import { createCalendar, type Calendar } from "../../index.js";

const CONFIG = {
  exchanges: {
    US_EQUITY: {
      regular_hours: { open: "09:30", close: "16:00", tz: "America/New_York" },
      half_days: ["2026-11-27", "2026-12-24"],
      half_day_close: "13:00",
      holidays: [
        "2026-01-01",
        "2026-01-19",
        "2026-04-03",
        "2026-07-03",
        "2026-11-26",
        "2026-12-25",
      ],
    },
  },
};

function cal(): Calendar {
  return createCalendar(CONFIG);
}

// Helper to create a Date in UTC
function utc(iso: string): Date {
  return new Date(iso);
}

describe("calendar", () => {
  describe("isTradingDay", () => {
    it("returns true for a regular weekday", () => {
      expect(cal().isTradingDay("US_EQUITY", utc("2026-04-15T14:00:00Z"))).toBe(true);
    });

    it("returns false for Saturday", () => {
      expect(cal().isTradingDay("US_EQUITY", utc("2026-04-18T14:00:00Z"))).toBe(false);
    });

    it("returns false for Sunday", () => {
      expect(cal().isTradingDay("US_EQUITY", utc("2026-04-19T14:00:00Z"))).toBe(false);
    });

    it("returns false for a holiday", () => {
      // Good Friday 2026-04-03
      expect(cal().isTradingDay("US_EQUITY", utc("2026-04-03T14:00:00Z"))).toBe(false);
    });

    it("returns true for a half day", () => {
      // 2026-11-27 is a half day, still a trading day
      expect(cal().isTradingDay("US_EQUITY", utc("2026-11-27T14:00:00Z"))).toBe(true);
    });
  });

  describe("isMarketOpen", () => {
    it("returns true during regular session", () => {
      // Wed 2026-04-15 at 10:30 ET = 14:30 UTC
      expect(cal().isMarketOpen("US_EQUITY", utc("2026-04-15T14:30:00Z"))).toBe(true);
    });

    it("returns false before open", () => {
      // Wed 2026-04-15 at 09:00 ET = 13:00 UTC
      expect(cal().isMarketOpen("US_EQUITY", utc("2026-04-15T13:00:00Z"))).toBe(false);
    });

    it("returns false at close (16:00 ET = 20:00 UTC)", () => {
      expect(cal().isMarketOpen("US_EQUITY", utc("2026-04-15T20:00:00Z"))).toBe(false);
    });

    it("returns false on weekends", () => {
      expect(cal().isMarketOpen("US_EQUITY", utc("2026-04-18T14:30:00Z"))).toBe(false);
    });

    it("returns false on holidays", () => {
      expect(cal().isMarketOpen("US_EQUITY", utc("2026-04-03T14:30:00Z"))).toBe(false);
    });

    it("respects half-day close time", () => {
      // Half day 2026-11-27, close at 13:00 ET = 18:00 UTC
      // At 12:30 ET = 17:30 UTC → should be open
      expect(cal().isMarketOpen("US_EQUITY", utc("2026-11-27T17:30:00Z"))).toBe(true);
      // At 13:00 ET = 18:00 UTC → should be closed
      expect(cal().isMarketOpen("US_EQUITY", utc("2026-11-27T18:00:00Z"))).toBe(false);
    });
  });

  describe("nextOpen", () => {
    it("returns today open when before session start", () => {
      // Wed 2026-04-15 at 08:00 ET = 12:00 UTC
      const next = cal().nextOpen("US_EQUITY", utc("2026-04-15T12:00:00Z"));
      expect(next.toISOString()).toContain("2026-04-15");
    });

    it("skips over weekend", () => {
      // Friday 2026-04-17 at 17:00 ET = 21:00 UTC (after close)
      const next = cal().nextOpen("US_EQUITY", utc("2026-04-17T21:00:00Z"));
      // Should be Monday 2026-04-20
      expect(next.toISOString()).toContain("2026-04-20");
    });

    it("skips holidays", () => {
      // Thursday 2026-04-02 at 17:00 ET (Good Friday 2026-04-03 is a holiday)
      const next = cal().nextOpen("US_EQUITY", utc("2026-04-02T21:00:00Z"));
      // Should skip Friday → Monday 2026-04-06
      expect(next.toISOString()).toContain("2026-04-06");
    });
  });

  describe("hoursSinceLastClose", () => {
    it("returns hours since most recent close on same day", () => {
      // Wed 2026-04-15 at 18:00 ET = 22:00 UTC (2h after 16:00 close)
      const hours = cal().hoursSinceLastClose("US_EQUITY", utc("2026-04-15T22:00:00Z"));
      expect(hours).toBeCloseTo(2, 0);
    });

    it("spans weekends correctly", () => {
      // Monday 2026-04-20 at 08:00 ET = 12:00 UTC
      // Last close was Friday 2026-04-17 at 16:00 ET = 20:00 UTC → 64h
      const hours = cal().hoursSinceLastClose("US_EQUITY", utc("2026-04-20T12:00:00Z"));
      expect(hours).toBeCloseTo(64, 0);
    });
  });

  describe("tradingDaysBetween", () => {
    it("counts weekdays excluding holidays", () => {
      // Week of 2026-04-06 to 2026-04-10 — 5 trading days, no holidays
      const days = cal().tradingDaysBetween(
        "US_EQUITY",
        utc("2026-04-06T12:00:00Z"),
        utc("2026-04-10T12:00:00Z"),
      );
      expect(days).toHaveLength(5);
    });

    it("excludes Good Friday", () => {
      // Week with Good Friday 2026-04-03
      const days = cal().tradingDaysBetween(
        "US_EQUITY",
        utc("2026-03-30T12:00:00Z"),
        utc("2026-04-03T12:00:00Z"),
      );
      // Mon Mar 30, Tue Mar 31, Wed Apr 1, Thu Apr 2 = 4 (Fri is holiday)
      expect(days).toHaveLength(4);
    });
  });

  it("throws on unknown exchange", () => {
    expect(() => cal().isMarketOpen("FAKE", new Date())).toThrow(/Unknown exchange/);
  });
});
