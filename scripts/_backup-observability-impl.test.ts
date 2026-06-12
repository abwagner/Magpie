import { describe, expect, it } from "vitest";
import { expiredSnapshots, parseArgs, snapshotDate } from "./_backup-observability-impl.js";

describe("parseArgs", () => {
  it("returns defaults for no args", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, retentionDays: 30 });
  });

  it("parses all flags", () => {
    expect(
      parseArgs([
        "--bucket",
        "obs-backups",
        "--endpoint-url",
        "https://s3.example.com",
        "--region",
        "us-west-2",
        "--retention-days",
        "7",
        "--dry-run",
      ]),
    ).toEqual({
      bucket: "obs-backups",
      endpointUrl: "https://s3.example.com",
      region: "us-west-2",
      retentionDays: 7,
      dryRun: true,
    });
  });

  it("rejects a negative retention-days", () => {
    expect(() => parseArgs(["--retention-days", "-5"])).toThrow(/positive integer/);
  });

  it("rejects a zero retention-days", () => {
    expect(() => parseArgs(["--retention-days", "0"])).toThrow(/positive integer/);
  });

  it("rejects a non-integer retention-days", () => {
    expect(() => parseArgs(["--retention-days", "1.5"])).toThrow(/positive integer/);
  });

  it("rejects a non-numeric retention-days", () => {
    expect(() => parseArgs(["--retention-days", "soon"])).toThrow(/positive integer/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown flag/);
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseArgs(["--bucket"])).toThrow(/requires a value/);
  });
});

describe("snapshotDate", () => {
  it("formats a UTC date as YYYY-MM-DD", () => {
    expect(snapshotDate(new Date("2026-06-06T03:00:00Z"))).toBe("2026-06-06");
  });

  it("uses the UTC day, not local", () => {
    expect(snapshotDate(new Date("2026-06-06T23:59:59Z"))).toBe("2026-06-06");
  });
});

describe("expiredSnapshots", () => {
  const now = new Date("2026-06-30T03:00:00Z");

  it("expires snapshots older than the retention window", () => {
    const existing = ["2026-05-01", "2026-05-31", "2026-06-29", "2026-06-30"];
    // 30-day cutoff from 2026-06-30 is 2026-05-31; strictly-older expires.
    expect(expiredSnapshots(existing, 30, now)).toEqual(["2026-05-01"]);
  });

  it("keeps everything when all snapshots are within the window", () => {
    expect(expiredSnapshots(["2026-06-15", "2026-06-29"], 30, now)).toEqual([]);
  });

  it("returns expired dates sorted ascending", () => {
    const existing = ["2026-01-10", "2025-12-01", "2026-02-02"];
    expect(expiredSnapshots(existing, 30, now)).toEqual(["2025-12-01", "2026-01-10", "2026-02-02"]);
  });

  it("ignores non-date-shaped entries", () => {
    expect(expiredSnapshots(["latest", "loki", "2025-01-01"], 30, now)).toEqual(["2025-01-01"]);
  });

  it("honors a custom retention window", () => {
    const existing = ["2026-06-20", "2026-06-25", "2026-06-29"];
    // 7-day cutoff from 2026-06-30 is 2026-06-23; 2026-06-20 expires.
    expect(expiredSnapshots(existing, 7, now)).toEqual(["2026-06-20"]);
  });

  it("returns nothing for an empty list", () => {
    expect(expiredSnapshots([], 30, now)).toEqual([]);
  });

  it("keeps a snapshot exactly at the 30-day boundary", () => {
    // 30-day cutoff from 2026-06-30 is 2026-05-31; only strictly-older
    // snapshots expire, so the boundary date itself is retained.
    expect(expiredSnapshots(["2026-05-31"], 30, now)).toEqual([]);
  });
});
