import { describe, expect, it } from "vitest";
import { fmpBackfillHandler } from "../../handlers/fmp-backfill.js";

describe("fmp-backfill handler", () => {
  it("declares the canonical kind name", () => {
    expect(fmpBackfillHandler.kind).toBe("fmp-backfill");
  });

  it("accepts an empty params object", () => {
    expect(fmpBackfillHandler.validate?.({})).toEqual([]);
  });

  it("rejects non-object params", () => {
    expect(fmpBackfillHandler.validate?.(null)?.length ?? 0).toBeGreaterThan(0);
    expect(fmpBackfillHandler.validate?.("oops")?.length ?? 0).toBeGreaterThan(0);
  });

  it("accepts a string universe_parquet override", () => {
    expect(
      fmpBackfillHandler.validate?.({ universe_parquet: "fundamentals/sox/u.parquet" }),
    ).toEqual([]);
  });

  it("rejects a non-string universe_parquet", () => {
    const errs = fmpBackfillHandler.validate?.({ universe_parquet: 42 }) ?? [];
    expect(errs.some((e) => e.includes("universe_parquet"))).toBe(true);
  });

  it("rejects a non-positive rate_limit_per_sec", () => {
    expect(fmpBackfillHandler.validate?.({ rate_limit_per_sec: 0 })?.length ?? 0).toBeGreaterThan(
      0,
    );
    expect(fmpBackfillHandler.validate?.({ rate_limit_per_sec: -5 })?.length ?? 0).toBeGreaterThan(
      0,
    );
    expect(
      fmpBackfillHandler.validate?.({ rate_limit_per_sec: "fast" })?.length ?? 0,
    ).toBeGreaterThan(0);
  });

  it("accepts a positive rate_limit_per_sec", () => {
    expect(fmpBackfillHandler.validate?.({ rate_limit_per_sec: 12 })).toEqual([]);
  });
});
