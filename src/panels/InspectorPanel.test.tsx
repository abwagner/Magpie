// QF-229 — InspectorPanel detail-view rendering tests. Mocks the
// inspectTrade API and asserts the 3-section render (Intent → Order →
// Fill) plus the 404 friendly-message branch.
// QF-338 — Signal + Pricing-decision sections retired alongside the
// audit_signals / audit_pricing_decisions tables.

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
};

describe("InspectorPanel (QF-229)", () => {
  beforeEach(() => {
    mockInspect.mockReset();
  });

  it("renders the empty-state hint before any search", () => {
    render(<InspectorPanel />);
    expect(screen.getByText(/Enter a fill_id above/)).toBeTruthy();
  });

  it("renders the 3 sections on successful inspect", async () => {
    mockInspect.mockResolvedValueOnce(baseResult);
    render(<InspectorPanel />);
    fireEvent.change(screen.getByPlaceholderText("01HW..."), { target: { value: "01HW-FILL-1" } });
    fireEvent.click(screen.getByText("Inspect"));

    await waitFor(() => {
      expect(screen.getByText("Intent")).toBeTruthy();
    });
    expect(screen.getByText("Order lifecycle")).toBeTruthy();
    expect(screen.getByText("Fill")).toBeTruthy();
    // Retired sections are gone.
    expect(screen.queryByText("Signal")).toBeNull();
    expect(screen.queryByText("Pricing decision")).toBeNull();
    // Intent identity surfaces.
    expect(screen.getByText("short-straddle-spy")).toBeTruthy();
    // Fill price surfaces.
    expect(screen.getByText("5.2500")).toBeTruthy();
    expect(mockInspect).toHaveBeenCalledWith("01HW-FILL-1");
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
});
