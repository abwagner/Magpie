import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StrategyMonitorPanel } from "./StrategyMonitorPanel.js";
import type { Strategy } from "../types/strategy.js";

describe("StrategyMonitorPanel", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("renders empty state when strategy is null", () => {
    render(<StrategyMonitorPanel strategy={null} />);

    expect(screen.getByText("Pick a strategy on the left.")).toBeTruthy();
  });

  it("fetches and renders monitoring data when strategy is selected", async () => {
    const mockStrategy: Strategy = {
      id: "test-strategy",
      label: "Test Strategy",
      state: "running",
      registered_at: "2026-06-01T10:00:00Z",
      updated_at: "2026-06-08T10:00:00Z",
      history: [],
    };

    const mockData = {
      strategy_id: "test-strategy",
      recent_fills: [
        {
          fill_id: "fill1",
          order_id: "order1",
          symbol: "SPY",
          direction: "long",
          price: 450.5,
          quantity: 10,
          fees: 5.0,
          filled_at: "2026-06-08T10:00:00Z",
          slippage: 0.1,
        },
      ],
      pnl_records: [
        {
          realized_pnl: 500.0,
          entry_fill_id: "fill1",
          entry_price: 450.0,
          entry_date: "2026-06-01T09:00:00Z",
          exit_fill_id: "fill2",
          exit_price: 451.0,
          exit_date: "2026-06-02T15:30:00Z",
          symbol: "SPY",
          direction: "long",
          quantity: 100,
          status: "closed",
        },
      ],
      total_realized_pnl: 500.0,
    };

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    render(<StrategyMonitorPanel strategy={mockStrategy} />);

    // Initially shows loading state
    expect(screen.getByText("Loading…")).toBeTruthy();

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText(/Realized P&L/i)).toBeTruthy();
    });

    // Check that fetch was called with correct URL
    expect(global.fetch).toHaveBeenCalledWith("/api/strategies/test-strategy/monitor");

    // Verify panel sections are rendered
    expect(screen.getByText(/Recent Fills/)).toBeTruthy();
    expect(screen.getByText(/Trades/)).toBeTruthy();
    expect(screen.getAllByText("SPY").length).toBeGreaterThan(0);
  });

  it("renders error message on fetch failure", async () => {
    const mockStrategy: Strategy = {
      id: "test-strategy",
      label: "Test Strategy",
      state: "running",
      registered_at: "2026-06-01T10:00:00Z",
      updated_at: "2026-06-08T10:00:00Z",
      history: [],
    };

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    render(<StrategyMonitorPanel strategy={mockStrategy} />);

    await waitFor(() => {
      expect(screen.getByText(/Error: HTTP 500/)).toBeTruthy();
    });
  });

  it("renders empty states for no fills and no trades", async () => {
    const mockStrategy: Strategy = {
      id: "test-strategy",
      label: "Test Strategy",
      state: "running",
      registered_at: "2026-06-01T10:00:00Z",
      updated_at: "2026-06-08T10:00:00Z",
      history: [],
    };

    const mockData = {
      strategy_id: "test-strategy",
      recent_fills: [],
      pnl_records: [],
      total_realized_pnl: 0,
    };

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    render(<StrategyMonitorPanel strategy={mockStrategy} />);

    await waitFor(() => {
      expect(screen.getByText("No fills.")).toBeTruthy();
      expect(screen.getByText("No trade records.")).toBeTruthy();
    });
  });
});
