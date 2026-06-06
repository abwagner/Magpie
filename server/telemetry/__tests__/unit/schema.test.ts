import { describe, it, expect } from "vitest";
import { validateEvent, validateBatch } from "../../schema.js";

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-06-01T12:00:00.000000Z",
    level: "info",
    event: "order-ticket.submitted",
    payload: { symbol: "SPY" },
    ...overrides,
  };
}

describe("validateEvent", () => {
  it("accepts a minimal valid event (no correlation_id or payload)", () => {
    expect(
      validateEvent({ ts: "2026-06-01T00:00:00Z", level: "warn", event: "nav.error" }),
    ).toBeNull();
  });

  it("accepts all valid levels", () => {
    for (const level of ["trace", "debug", "info", "warn", "error"]) {
      expect(validateEvent(validEvent({ level }))).toBeNull();
    }
  });

  it("rejects null", () => {
    expect(validateEvent(null)).not.toBeNull();
  });

  it("rejects an array", () => {
    expect(validateEvent([])).not.toBeNull();
  });

  it("rejects a missing ts", () => {
    const { ts: _ts, ...rest } = validEvent();
    expect(validateEvent(rest)).toMatch(/ts/);
  });

  it("rejects an invalid level", () => {
    expect(validateEvent(validEvent({ level: "verbose" }))).toMatch(/level/);
  });

  it("rejects a missing event field", () => {
    const { event: _e, ...rest } = validEvent();
    expect(validateEvent(rest)).toMatch(/event/);
  });

  it("rejects empty correlation_id when present", () => {
    expect(validateEvent(validEvent({ correlation_id: "" }))).toMatch(/correlation_id/);
  });

  it("rejects non-object payload", () => {
    expect(validateEvent(validEvent({ payload: [1, 2] }))).toMatch(/payload/);
  });
});

describe("validateBatch", () => {
  it("accepts a valid single-event array", () => {
    const { valid, error } = validateBatch([validEvent()]);
    expect(error).toBeNull();
    expect(valid).toHaveLength(1);
  });

  it("accepts a multi-event array", () => {
    const { valid, error } = validateBatch([validEvent(), validEvent({ event: "b" })]);
    expect(error).toBeNull();
    expect(valid).toHaveLength(2);
  });

  it("rejects a non-array", () => {
    expect(validateBatch({ event: "x" }).error).toMatch(/array/);
  });

  it("rejects an empty array", () => {
    expect(validateBatch([]).error).toMatch(/at least one/);
  });

  it("rejects a batch larger than 200", () => {
    const big = Array.from({ length: 201 }, () => validEvent());
    expect(validateBatch(big).error).toMatch(/200/);
  });

  it("returns an error naming the offending event index", () => {
    const events = [validEvent(), { ts: "x", level: "BAD", event: "e" }];
    const { error } = validateBatch(events);
    expect(error).toMatch(/event\[1\]/);
  });
});
