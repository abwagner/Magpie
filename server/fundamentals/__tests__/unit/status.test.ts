import { describe, it, expect } from "vitest";
import { classifyFreshness } from "../../status.js";

describe("fundamentals.classifyFreshness", () => {
  const now = Date.parse("2026-05-16T12:00:00Z");

  it("returns missing when the parquet does not exist", () => {
    expect(classifyFreshness("2026-05-15T12:00:00Z", 240, false, now)).toEqual({
      freshness_status: "missing",
      freshness_age_hours: null,
    });
  });

  it("returns stale when the parquet exists but has no data_through", () => {
    expect(classifyFreshness(null, 240, true, now)).toEqual({
      freshness_status: "stale",
      freshness_age_hours: null,
    });
  });

  it("returns stale when data_through is unparseable", () => {
    expect(classifyFreshness("not-a-date", 240, true, now)).toEqual({
      freshness_status: "stale",
      freshness_age_hours: null,
    });
  });

  it("returns fresh when age is within the threshold", () => {
    const result = classifyFreshness("2026-05-15T12:00:00Z", 30, true, now);
    expect(result.freshness_status).toBe("fresh");
    expect(result.freshness_age_hours).toBeCloseTo(24);
  });

  it("returns stale when age exceeds the threshold", () => {
    const result = classifyFreshness("2026-05-10T12:00:00Z", 24, true, now);
    expect(result.freshness_status).toBe("stale");
    expect(result.freshness_age_hours).toBeCloseTo(144);
  });

  it("treats age exactly at threshold as fresh", () => {
    const isoOneDayAgo = "2026-05-15T12:00:00Z";
    const result = classifyFreshness(isoOneDayAgo, 24, true, now);
    expect(result.freshness_status).toBe("fresh");
  });
});
