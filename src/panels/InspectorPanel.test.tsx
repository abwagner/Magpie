// QF-229 — InspectorPanel detail-view rendering tests. Mocks the
// inspectTrade API and asserts the 5-section render plus the
// multi-decision repeg case and the 404 friendly-message branch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InspectorPanel } from "./InspectorPanel.js";

vi.mock("../lib/api.js", () => ({
  inspectTrade: vi.fn(),
}));

import { inspectTrade } from "../lib/api.js";
const mockInspect = inspectTrade as unknown as ReturnType<typeof vi.fn>;

const baseResult = {
  fill: {
    fill_id: "01HW-FILL-1",
    order_id: "01HW-ORDER-1",
    price: 5.25,
    quantity: 3,
    fees: 0.65,
    filled_at: "2026-05-20T14:30:00Z",
    expected_price: 5.0,
    slippage: 0.25,
  },
  order: {
    order_id: "01HW-ORDER-1",
    intent_id: "01HW-INTENT-1",
    broker: "paper",
    execution_mode: "paper_local",
    status: "filled",
    created_at: "2026-05-20T14:29:50Z",
    risk_checked_at: "2026-05-20T14:29:51Z",
    approved_at: "2026-05-20T14:29:52Z",
    submitted_at: "2026-05-20T14:29:53Z",
    completed_at: "2026-05-20T14:30:00Z",
    broker_order_id: "BROKER-1",
    operator_edits: null,
    risk_violations: null,
    halt_reason: null,
    broker_rejection_reason: null,
  },
  intent: {
    intent_id: "01HW-INTENT-1",
    portfolio: "main",
    strategy_id: "short-straddle-spy",
    symbol: "OPT:SPY:2026-06-19:C:500",
    direction: "Short",
    quantity: 3,
    signal_ids: ["01HW-SIG-1"],
    created_at: "2026-05-20T14:29:45Z",
  },
  pricing_decisions: [
    {
      decision_id: "01HW-DEC-1",
      intent_id: "01HW-INTENT-1",
      strategy_id: "short-straddle-spy",
      strategy_chosen: "mid_plus_pct_spread",
      profile_source: "strategy_override",
      inputs: { bid: 5.0, ask: 5.5, mid: 5.25, signal_age_ms: 1200, signal_horizon_ms: 86400000 },
      order_type: "limit",
      limit_price: 5.05,
      limit_price_pre_snap: 5.05,
      time_in_force: "day",
      working_policy_id: "fill_or_repeg_1m",
      reasoning:
        "[strategy_override] mid_plus_pct_spread (mid=5.25, spread=0.5, p=0.5) → snap up = 5.05",
      created_at: "2026-05-20T14:29:46Z",
    },
  ],
  originating_signal: {
    signal_id: "01HW-SIG-1",
    model_id: "vol-forecast-spy-1d",
    model_version: "v3",
    symbol: "EQ:SPY",
    asof: "2026-05-20T14:00:00Z",
    kind: "point",
    batch_id: "batch-99",
    ingest_ts: "2026-05-20T14:00:30Z",
  },
};

describe("InspectorPanel (QF-229)", () => {
  beforeEach(() => {
    mockInspect.mockReset();
  });

  it("renders the empty-state hint before any search", () => {
    render(<InspectorPanel />);
    expect(screen.getByText(/Enter a fill_id above/)).toBeTruthy();
  });

  it("renders the 5 sections + reasoning headline on successful inspect", async () => {
    mockInspect.mockResolvedValueOnce(baseResult);
    render(<InspectorPanel />);
    fireEvent.change(screen.getByPlaceholderText("01HW..."), { target: { value: "01HW-FILL-1" } });
    fireEvent.click(screen.getByText("Inspect"));

    await waitFor(() => {
      expect(screen.getByText("Signal")).toBeTruthy();
    });
    expect(screen.getByText("Intent")).toBeTruthy();
    expect(screen.getByText("Pricing decision")).toBeTruthy();
    expect(screen.getByText("Order lifecycle")).toBeTruthy();
    expect(screen.getByText("Fill")).toBeTruthy();
    // Reasoning string is the headline of the pricing-decision card.
    expect(
      screen.getByText(
        "[strategy_override] mid_plus_pct_spread (mid=5.25, spread=0.5, p=0.5) → snap up = 5.05",
      ),
    ).toBeTruthy();
    // Signal model identity surfaces.
    expect(screen.getByText("vol-forecast-spy-1d @ v3")).toBeTruthy();
    // Fill price surfaces.
    expect(screen.getByText("5.2500")).toBeTruthy();
    expect(mockInspect).toHaveBeenCalledWith("01HW-FILL-1");
  });

  it("renders multi-decision intents as an ordered list with timestamps", async () => {
    const multi = {
      ...baseResult,
      pricing_decisions: [
        baseResult.pricing_decisions[0]!,
        {
          ...baseResult.pricing_decisions[0]!,
          decision_id: "01HW-DEC-2",
          reasoning: "[repeg] working-policy fired @ 60s; bumped limit by 1 tick",
          limit_price: 5.06,
          limit_price_pre_snap: 5.06,
          created_at: "2026-05-20T14:30:46Z",
        },
      ],
    };
    mockInspect.mockResolvedValueOnce(multi);
    render(<InspectorPanel />);
    fireEvent.change(screen.getByPlaceholderText("01HW..."), { target: { value: "01HW-FILL-1" } });
    fireEvent.click(screen.getByText("Inspect"));

    await waitFor(() => {
      expect(screen.getByText(/DECISION 1 of 2/)).toBeTruthy();
    });
    expect(screen.getByText(/DECISION 2 of 2/)).toBeTruthy();
    expect(screen.getByText(/working-policy fired @ 60s/)).toBeTruthy();
  });

  it("shows a friendly 404 message for unknown fill_id", async () => {
    mockInspect.mockRejectedValueOnce(new Error("No fill with fill_id=01HW-DOES-NOT-EXIST"));
    render(<InspectorPanel />);
    fireEvent.change(screen.getByPlaceholderText("01HW..."), {
      target: { value: "01HW-DOES-NOT-EXIST" },
    });
    fireEvent.click(screen.getByText("Inspect"));

    await waitFor(() => {
      expect(screen.getByText(/No fill found/)).toBeTruthy();
    });
    expect(screen.getByText(/01HW-DOES-NOT-EXIST/)).toBeTruthy();
  });

  it("shows the raw error message for non-404 failures", async () => {
    mockInspect.mockRejectedValueOnce(new Error("API error: HTTP 500"));
    render(<InspectorPanel />);
    fireEvent.change(screen.getByPlaceholderText("01HW..."), { target: { value: "01HW-FILL-1" } });
    fireEvent.click(screen.getByText("Inspect"));

    await waitFor(() => {
      expect(screen.getByText("API error: HTTP 500")).toBeTruthy();
    });
    expect(screen.queryByText(/No fill found/)).toBeNull();
  });

  it("handles a null originating_signal gracefully (legacy-path orders)", async () => {
    mockInspect.mockResolvedValueOnce({ ...baseResult, originating_signal: null });
    render(<InspectorPanel />);
    fireEvent.change(screen.getByPlaceholderText("01HW..."), { target: { value: "01HW-FILL-1" } });
    fireEvent.click(screen.getByText("Inspect"));

    await waitFor(() => {
      expect(screen.getByText(/Intent referenced no upstream signal/)).toBeTruthy();
    });
  });
});
