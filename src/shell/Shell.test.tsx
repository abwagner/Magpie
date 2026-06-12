// QF-322 — ExitRuleClosingBanner. The banner is fed by the shell-wide
// exit-rule trip ring (StateProvider); these tests render it through a
// StateContext provider with controlled trips and assert the empty
// state, lead-trip copy, singular/plural "more" suffix, timestamp
// formatting, and the "View strategies" action.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ExitRuleClosingBanner } from "./Shell.js";
import { StateContext, type ExitRuleTrip, type StateContextValue } from "../state/StateProvider.js";
import { useUI } from "../state/ui-store.js";

afterEach(cleanup);

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

function trip(over: Partial<ExitRuleTrip> = {}): ExitRuleTrip {
  return {
    position_id: "pos-1",
    rule: "stop_loss",
    closing_intent_id: "intent-1",
    strategy_id: "straddle-spy",
    ts: "2026-05-20T12:34:56Z",
    ...over,
  };
}

describe("ExitRuleClosingBanner", () => {
  it("returns null when there are no trips", () => {
    const { container } = render(withTrips(<ExitRuleClosingBanner />, []));
    expect(container.firstChild).toBeNull();
  });

  it("renders the lead trip's rule, strategy, and position", () => {
    render(withTrips(<ExitRuleClosingBanner />, [trip()]));
    const detail = screen.getByText(/tripped for/);
    expect(detail.textContent).toContain("Stop loss");
    expect(detail.textContent).toContain("straddle-spy");
    expect(detail.textContent).toContain("pos-1");
  });

  it("omits the 'more' suffix for a single trip", () => {
    render(withTrips(<ExitRuleClosingBanner />, [trip()]));
    expect(screen.queryByText(/more position/)).toBeNull();
  });

  it("uses singular '1 more position' for exactly two trips", () => {
    render(
      withTrips(<ExitRuleClosingBanner />, [
        trip(),
        trip({ position_id: "pos-2", closing_intent_id: "intent-2" }),
      ]),
    );
    expect(screen.getByText(/· 1 more position closing/)).toBeDefined();
  });

  it("uses plural '2 more positions' for three trips", () => {
    render(
      withTrips(<ExitRuleClosingBanner />, [
        trip(),
        trip({ position_id: "pos-2", closing_intent_id: "intent-2" }),
        trip({ position_id: "pos-3", closing_intent_id: "intent-3" }),
      ]),
    );
    expect(screen.getByText(/· 2 more positions closing/)).toBeDefined();
  });

  it("formats the trip timestamp via toLocaleTimeString", () => {
    render(withTrips(<ExitRuleClosingBanner />, [trip()]));
    const expected = new Date("2026-05-20T12:34:56Z").toLocaleTimeString();
    expect(
      screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
    ).toBeDefined();
  });

  it("'View strategies' button switches the workspace to strategies", () => {
    const spy = vi.spyOn(useUI.getState(), "setWorkspace");
    render(withTrips(<ExitRuleClosingBanner />, [trip()]));
    fireEvent.click(screen.getByRole("button", { name: /View strategies/i }));
    expect(spy).toHaveBeenCalledWith("strategies");
    spy.mockRestore();
  });
});
