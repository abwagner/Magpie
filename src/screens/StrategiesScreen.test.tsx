// Focused tests for the LineageBadge subcomponent (QF-179).
// The wider StrategiesScreen pulls in WebSocket state, so we test
// the new piece in isolation via its named export.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ExitRulesSection, ExitRuleTripHistory, LineageBadge } from "./StrategiesScreen.js";
import { StateContext, type ExitRuleTrip, type StateContextValue } from "../state/StateProvider.js";
import type { ParamsProvenance, Strategy } from "../types/strategy.js";

afterEach(cleanup);

function strategy(over: Partial<Strategy> = {}): Strategy {
  return {
    id: "straddle-spy",
    label: "Short straddle SPY",
    state: "running",
    registered_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-20T00:00:00Z",
    history: [],
    ...over,
  };
}

function withTrips(node: ReactNode, exitRuleTrips: ExitRuleTrip[]) {
  const value: StateContextValue = {
    state: null,
    connected: true,
    reconnecting: false,
    outstandingQuoteAlerts: new Map(),
    exitRuleTrips,
  };
  return <StateContext.Provider value={value}>{node}</StateContext.Provider>;
}

const VALID_PROV: ParamsProvenance = {
  lineage_id: "11111111-2222-3333-4444-555555555555",
  selected_params: { stop_loss_dollars: 1700, bullish_threshold: 80 },
  selector_rule: "last_fold",
  selected_at: "2026-05-13T16:00:00Z",
};

describe("LineageBadge", () => {
  it("renders nothing when provenance is undefined", () => {
    const { container } = render(<LineageBadge provenance={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the short lineage_id when provenance is present", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    // First 8 chars of the UUID.
    expect(screen.getByText("11111111")).toBeDefined();
  });

  it("surfaces the full lineage_id + selector_rule + selected_at via tooltip", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    const chip = screen.getByLabelText(/Params provenance lineage/i);
    const tooltip = chip.getAttribute("title") ?? "";
    expect(tooltip).toContain(VALID_PROV.lineage_id);
    expect(tooltip).toContain("last_fold");
    expect(tooltip).toContain("2026-05-13T16:00:00Z");
  });

  it("renders selector_rule + selected_at inline alongside the chip", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    expect(screen.getByText("last_fold")).toBeDefined();
    expect(screen.getByText(/2026-05-13T16:00:00Z/)).toBeDefined();
  });

  it("toggles the params JSON expander on button click", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    const toggle = screen.getByRole("button", { name: /Show params/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Pre-click: JSON expander absent.
    expect(screen.queryByText(/stop_loss_dollars/)).toBeNull();

    fireEvent.click(toggle);

    // Post-click: aria-expanded flips + JSON content visible.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/stop_loss_dollars/)).toBeDefined();
    expect(screen.getByText(/1700/)).toBeDefined();
    expect(screen.getByText(/Hide params/i)).toBeDefined();
  });

  it("renders an empty selected_params expander without throwing", () => {
    const empty: ParamsProvenance = { ...VALID_PROV, selected_params: {} };
    render(<LineageBadge provenance={empty} />);
    fireEvent.click(screen.getByRole("button", { name: /Show params/i }));
    // Pre / textContent should be "{}", trimmed.
    const pre = document.getElementById("lineage-params-json");
    expect(pre).not.toBeNull();
    expect(pre!.textContent?.trim()).toBe("{}");
  });
});

// QF-322 — per-strategy exit-rule panel.
describe("ExitRulesSection", () => {
  it("shows a dormant note when no rules have been evaluated", () => {
    render(<ExitRulesSection strategy={strategy()} />);
    expect(screen.getByText(/No framework-enforced exits evaluated yet/i)).toBeDefined();
  });

  it("renders each armed rule with its values and headroom", () => {
    const s = strategy({
      exit_rules: [{ rule: "stop_loss", threshold: -0.05, actual: -0.032, headroom_pct: 0.36 }],
    });
    render(<ExitRulesSection strategy={s} />);
    expect(screen.getByText("Stop loss")).toBeDefined();
    expect(screen.getByText("-3.2% / -5.0%")).toBeDefined();
    expect(screen.getByText("36.0% headroom")).toBeDefined();
  });

  it("flags a tripped rule with the 'tripped' headroom phrase", () => {
    const s = strategy({
      exit_rules: [{ rule: "target", threshold: 0.5, actual: 0.6, headroom_pct: -0.2 }],
    });
    render(<ExitRulesSection strategy={s} />);
    expect(screen.getByText("tripped")).toBeDefined();
  });

  it("renders multiple distinct rules together (pct + duration)", () => {
    const s = strategy({
      exit_rules: [
        { rule: "stop_loss", threshold: -0.05, actual: -0.032, headroom_pct: 0.36 },
        { rule: "target", threshold: 0.5, actual: 0.45, headroom_pct: 0.1 },
        { rule: "max_hold", actual: 7200, threshold: 21600, headroom_pct: 0.67 },
      ],
    });
    render(<ExitRulesSection strategy={s} />);
    // All three labels render.
    expect(screen.getByText("Stop loss")).toBeDefined();
    expect(screen.getByText("Target")).toBeDefined();
    expect(screen.getByText("Max hold")).toBeDefined();
    // Percentage rules render their actual / threshold as percentages.
    expect(screen.getByText("-3.2% / -5.0%")).toBeDefined();
    expect(screen.getByText("45.0% / 50.0%")).toBeDefined();
    // max_hold renders durations, not percentages.
    expect(screen.getByText("2h 0m / 6h 0m")).toBeDefined();
    // Per-rule headroom phrases are all present.
    expect(screen.getByText("36.0% headroom")).toBeDefined();
    expect(screen.getByText("10.0% headroom")).toBeDefined();
    expect(screen.getByText("67.0% headroom")).toBeDefined();
  });
});

// QF-322 — per-strategy trip history sourced from the shell trip ring.
describe("ExitRuleTripHistory", () => {
  const TRIP: ExitRuleTrip = {
    position_id: "pos-1",
    rule: "stop_loss",
    closing_intent_id: "intent-1",
    strategy_id: "straddle-spy",
    ts: "2026-05-20T12:00:00Z",
  };

  it("shows an empty note when there are no trips for the strategy", () => {
    render(withTrips(<ExitRuleTripHistory strategyId="straddle-spy" />, []));
    expect(screen.getByText(/No trips in this session/i)).toBeDefined();
  });

  it("lists trips that match the strategy id", () => {
    render(withTrips(<ExitRuleTripHistory strategyId="straddle-spy" />, [TRIP]));
    expect(screen.getByText("Stop loss")).toBeDefined();
    expect(screen.getByText("pos-1")).toBeDefined();
    expect(screen.getByText(/intent-1/)).toBeDefined();
  });

  it("filters out trips for other strategies", () => {
    const other: ExitRuleTrip = { ...TRIP, strategy_id: "iron-condor-qqq" };
    render(withTrips(<ExitRuleTripHistory strategyId="straddle-spy" />, [other]));
    expect(screen.getByText(/No trips in this session/i)).toBeDefined();
  });
});
