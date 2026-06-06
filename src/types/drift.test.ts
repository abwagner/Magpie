// QF-328 — drift types: N_MIN_DEFAULTS constant.

import { describe, it, expect } from "vitest";
import { N_MIN_DEFAULTS } from "./drift.js";

describe("N_MIN_DEFAULTS", () => {
  it("has the five expected metrics", () => {
    const metrics = ["realized_pnl", "hit_rate", "slippage", "signal_fill_latency", "realized_vol"];
    for (const m of metrics) {
      expect(N_MIN_DEFAULTS).toHaveProperty(m);
    }
  });

  it("uses the doc-specified defaults (drift-detector.md §3.1)", () => {
    expect(N_MIN_DEFAULTS["realized_pnl"]).toBe(20);
    expect(N_MIN_DEFAULTS["hit_rate"]).toBe(30);
    expect(N_MIN_DEFAULTS["slippage"]).toBe(30);
    expect(N_MIN_DEFAULTS["signal_fill_latency"]).toBe(20);
    expect(N_MIN_DEFAULTS["realized_vol"]).toBe(30);
  });

  it("all values are positive integers", () => {
    for (const [, v] of Object.entries(N_MIN_DEFAULTS)) {
      expect(v).toBeGreaterThan(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
