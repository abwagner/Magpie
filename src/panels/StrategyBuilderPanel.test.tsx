import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Contract } from "../types/market-data.js";

// CurveChart pulls in Plotly (no jsdom canvas); stub it.
vi.mock("../components/CurveChart.js", () => ({
  default: () => <div data-testid="payoff-chart" />,
}));

const EXPS = ["2026-07-17", "2026-08-21"];

function synthChain(exp: string): Contract[] {
  const strikes = [90, 95, 100, 105, 110];
  const spot = 100;
  return strikes.flatMap((k): Contract[] =>
    (["call", "put"] as const).map((side) => {
      const intrinsic = side === "call" ? Math.max(spot - k, 0) : Math.max(k - spot, 0);
      const mid = intrinsic + Math.max(0, 3 - Math.abs(k - spot) / 10);
      return {
        symbol: `SPY_${exp}_${side}${k}`,
        underlying: "SPY",
        expiration: exp,
        side,
        strike: k,
        dte: 30,
        bid: mid - 0.05,
        ask: mid + 0.05,
        mid,
        last: mid,
        volume: 10,
        openInterest: 10,
        underlyingPrice: spot,
        iv: 0.2,
        delta: side === "call" ? 0.5 : -0.5,
        gamma: 0.02,
        theta: -0.04,
        vega: 0.1,
      };
    }),
  );
}

vi.mock("../lib/api.js", () => ({
  expirations: vi.fn(async () => EXPS),
  chain: vi.fn(async (_sym: string, exp: string) => synthChain(exp)),
}));

afterEach(cleanup);

describe("StrategyBuilderPanel", () => {
  it("loads expirations, builds the default vertical, and shows legs + analytics", async () => {
    const { StrategyBuilderPanel } = await import("./StrategyBuilderPanel.js");
    render(<StrategyBuilderPanel />);

    // expirations populate the front select
    await waitFor(() => expect(screen.getByDisplayValue(EXPS[0]!)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /build/i }));

    // bull call spread = 2 legs; net debit stat + payoff chart render
    await waitFor(() => {
      expect(screen.getByText("Net debit")).toBeTruthy();
      expect(screen.getByTestId("payoff-chart")).toBeTruthy();
    });
    // two leg rows (buy 100C, sell 105C)
    const rows = screen.getAllByRole("row");
    // header + 2 leg rows
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it("shows two expiration selectors for a calendar", async () => {
    const { StrategyBuilderPanel } = await import("./StrategyBuilderPanel.js");
    render(<StrategyBuilderPanel />);
    await waitFor(() => expect(screen.getByDisplayValue(EXPS[0]!)).toBeTruthy());

    fireEvent.change(screen.getByDisplayValue("Bull Call Spread"), {
      target: { value: "calendar-call" },
    });
    // "Front" + "Back" labels appear for the 2-expiration structure
    await waitFor(() => {
      expect(screen.getByText("Front")).toBeTruthy();
      expect(screen.getByText("Back")).toBeTruthy();
    });
  });
});
