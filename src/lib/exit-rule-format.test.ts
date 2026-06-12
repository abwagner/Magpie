// Unit tests for the exit-rule display helpers (QF-322).

import { describe, expect, it } from "vitest";
import {
  exitRuleLabel,
  formatExitRuleValues,
  formatHeadroom,
  isTripped,
} from "./exit-rule-format.js";
import type { ExitRuleHeadroom } from "../types/strategy.js";

function ev(over: Partial<ExitRuleHeadroom> = {}): ExitRuleHeadroom {
  return { rule: "stop_loss", threshold: -0.05, actual: -0.032, headroom_pct: 0.36, ...over };
}

describe("exitRuleLabel", () => {
  it("maps each wire id to an operator label", () => {
    expect(exitRuleLabel("stop_loss")).toBe("Stop loss");
    expect(exitRuleLabel("target")).toBe("Target");
    expect(exitRuleLabel("max_hold")).toBe("Max hold");
    expect(exitRuleLabel("max_drawdown")).toBe("Max drawdown");
  });
});

describe("formatExitRuleValues", () => {
  it("renders actual / threshold as percentages for pct rules", () => {
    expect(formatExitRuleValues(ev())).toBe("-3.2% / -5.0%");
  });

  it("renders max_hold as a duration in hours and minutes", () => {
    const hold = ev({ rule: "max_hold", actual: 15120, threshold: 21600, headroom_pct: 0.3 });
    expect(formatExitRuleValues(hold)).toBe("4h 12m / 6h 0m");
  });

  it("renders sub-hour durations without an hours segment", () => {
    const hold = ev({ rule: "max_hold", actual: 720, threshold: 3000, headroom_pct: 0.76 });
    expect(formatExitRuleValues(hold)).toBe("12m / 50m");
  });

  it("guards non-finite values", () => {
    expect(formatExitRuleValues(ev({ actual: NaN }))).toBe("— / -5.0%");
  });
});

describe("formatHeadroom", () => {
  it("shows the percentage headroom while armed", () => {
    expect(formatHeadroom(ev({ headroom_pct: 0.018 }))).toBe("1.8% headroom");
  });

  it("shows 'tripped' at or below zero headroom", () => {
    expect(formatHeadroom(ev({ headroom_pct: 0 }))).toBe("tripped");
    expect(formatHeadroom(ev({ headroom_pct: -0.1 }))).toBe("tripped");
  });
});

describe("isTripped", () => {
  it("is true only when headroom is at or below zero", () => {
    expect(isTripped(ev({ headroom_pct: 0.01 }))).toBe(false);
    expect(isTripped(ev({ headroom_pct: 0 }))).toBe(true);
    expect(isTripped(ev({ headroom_pct: -0.5 }))).toBe(true);
  });
});
