import { describe, it, expect } from "vitest";
import { formatTime, formatDate, formatDateTime, APP_TIMEZONE } from "../time.js";

describe("time", () => {
  it("uses America/New_York as default timezone", () => {
    expect(APP_TIMEZONE).toBe("America/New_York");
  });

  describe("formatTime", () => {
    it("converts UTC to Eastern Time", () => {
      // 2026-04-15 20:01:35 UTC = 16:01:35 ET (EDT, -4)
      const result = formatTime("2026-04-15T20:01:35Z");
      expect(result).toBe("16:01:35");
    });

    it("handles winter time (EST, -5)", () => {
      // 2026-01-15 20:00:00 UTC = 15:00:00 ET (EST, -5)
      const result = formatTime("2026-01-15T20:00:00Z");
      expect(result).toBe("15:00:00");
    });

    it("returns empty string for null", () => {
      expect(formatTime(null)).toBe("");
    });

    it("returns empty string for undefined", () => {
      expect(formatTime(undefined)).toBe("");
    });

    it("returns empty string for invalid date", () => {
      expect(formatTime("not-a-date")).toBe("");
    });

    it("accepts Date objects", () => {
      const d = new Date("2026-04-15T20:01:35Z");
      const result = formatTime(d);
      expect(result).toBe("16:01:35");
    });
  });

  describe("formatDate", () => {
    it("renders YYYY-MM-DD in Eastern Time", () => {
      // Late UTC (23:00 on Apr 15) → still Apr 15 in ET (19:00)
      expect(formatDate("2026-04-15T23:00:00Z")).toBe("2026-04-15");
    });

    it("handles date rollover (early UTC → previous day in ET)", () => {
      // 2026-04-16 03:00 UTC = 2026-04-15 23:00 ET
      expect(formatDate("2026-04-16T03:00:00Z")).toBe("2026-04-15");
    });

    it("returns empty for null", () => {
      expect(formatDate(null)).toBe("");
    });
  });

  describe("formatDateTime", () => {
    it("renders YYYY-MM-DD HH:MM:SS in Eastern Time", () => {
      const result = formatDateTime("2026-04-15T20:01:35Z");
      expect(result).toBe("2026-04-15 16:01:35");
    });

    it("returns empty for null", () => {
      expect(formatDateTime(null)).toBe("");
    });
  });
});
