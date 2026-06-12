// Tests for the BridgesPanel subcomponent of MarketDataHealthScreen (QF-296).
// Covers: alive/unavailable/recovered transitions, one-broker-down-other-up,
// loading state, error state, and empty-adapters state.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BridgesPanel } from "../MarketDataHealthScreen.js";
import type { BridgeStatus } from "../../types/marketdata-health.js";

afterEach(() => {
  cleanup();
});

// ── Fixtures ──────────────────────────────────────────────────────

const SCHWAB_ALIVE: BridgeStatus = {
  broker: "schwab",
  alive: true,
  last_heartbeat_age_ms: null,
  rpc_count_5m: 12,
  rpc_error_rate_5m: 0,
  rpc_latency_p50_ms: 38,
  rpc_latency_p99_ms: 120,
  priority_rank: 1,
  serving_as_fallback: false,
};

const IBKR_ALIVE: BridgeStatus = {
  broker: "ibkr",
  alive: true,
  last_heartbeat_age_ms: null,
  rpc_count_5m: 5,
  rpc_error_rate_5m: 0.02,
  rpc_latency_p50_ms: 55,
  rpc_latency_p99_ms: 200,
  priority_rank: 0,
  serving_as_fallback: false,
};

const SCHWAB_DOWN: BridgeStatus = {
  broker: "schwab",
  alive: false,
  last_heartbeat_age_ms: null,
  rpc_count_5m: 0,
  rpc_error_rate_5m: 0,
  rpc_latency_p50_ms: null,
  rpc_latency_p99_ms: null,
  priority_rank: 1,
  serving_as_fallback: false,
};

const IBKR_DOWN: BridgeStatus = {
  broker: "ibkr",
  alive: false,
  last_heartbeat_age_ms: null,
  rpc_count_5m: 0,
  rpc_error_rate_5m: 0,
  rpc_latency_p50_ms: null,
  rpc_latency_p99_ms: null,
  priority_rank: 0,
  serving_as_fallback: false,
};

// ── State transitions ─────────────────────────────────────────────

describe("BridgesPanel — alive/unavailable/recovered transitions", () => {
  it("renders 'alive' label and aria-label when bridge is up", () => {
    render(<BridgesPanel bridges={[SCHWAB_ALIVE]} loading={false} error={null} />);
    expect(screen.getByLabelText("alive")).toBeDefined();
    expect(screen.getByText("alive")).toBeDefined();
  });

  it("renders 'unavailable' label and aria-label when bridge is down", () => {
    render(<BridgesPanel bridges={[SCHWAB_DOWN]} loading={false} error={null} />);
    expect(screen.getByLabelText("unavailable")).toBeDefined();
    expect(screen.getByText("unavailable")).toBeDefined();
  });

  it("recovers — re-renders alive after being down when props update", () => {
    const { rerender } = render(
      <BridgesPanel bridges={[SCHWAB_DOWN]} loading={false} error={null} />,
    );
    expect(screen.getByLabelText("unavailable")).toBeDefined();

    rerender(<BridgesPanel bridges={[SCHWAB_ALIVE]} loading={false} error={null} />);
    expect(screen.getByLabelText("alive")).toBeDefined();
  });
});

// ── Multi-broker ──────────────────────────────────────────────────

describe("BridgesPanel — one-broker-down-other-up", () => {
  it("renders both brokers and shows correct status per row", () => {
    render(<BridgesPanel bridges={[SCHWAB_ALIVE, IBKR_DOWN]} loading={false} error={null} />);
    expect(screen.getByText("schwab")).toBeDefined();
    expect(screen.getByText("ibkr")).toBeDefined();

    // Two status cells — one alive, one unavailable
    const aliveEls = screen.getAllByText("alive");
    const unavailableEls = screen.getAllByText("unavailable");
    expect(aliveEls.length).toBeGreaterThanOrEqual(1);
    expect(unavailableEls.length).toBeGreaterThanOrEqual(1);
  });

  it("renders both schwab and ibkr when both are alive", () => {
    render(<BridgesPanel bridges={[SCHWAB_ALIVE, IBKR_ALIVE]} loading={false} error={null} />);
    expect(screen.getByText("schwab")).toBeDefined();
    expect(screen.getByText("ibkr")).toBeDefined();
  });
});

// ── Loading / error / empty states ───────────────────────────────

describe("BridgesPanel — loading state", () => {
  it("renders loading indicator when loading=true and bridges=null", () => {
    render(<BridgesPanel bridges={null} loading={true} error={null} />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });
});

describe("BridgesPanel — error state", () => {
  it("renders error message when error is set", () => {
    render(<BridgesPanel bridges={null} loading={false} error="connection refused" />);
    expect(screen.getByText(/connection refused/i)).toBeDefined();
  });

  it("error takes priority over loading indicator", () => {
    render(<BridgesPanel bridges={null} loading={true} error="timeout" />);
    expect(screen.getByText(/timeout/i)).toBeDefined();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });
});

describe("BridgesPanel — empty adapters state", () => {
  it("renders a configure message when bridges array is empty", () => {
    render(<BridgesPanel bridges={[]} loading={false} error={null} />);
    expect(screen.getByText(/No bridge adapters configured/i)).toBeDefined();
  });
});

// ── RPC error rate rendering ──────────────────────────────────────

describe("BridgesPanel — RPC error rate display", () => {
  it("shows '—' when rpc_count_5m is zero", () => {
    render(<BridgesPanel bridges={[SCHWAB_DOWN]} loading={false} error={null} />);
    // The error rate cell should show "—" when there are no calls.
    expect(screen.getByText("—")).toBeDefined();
  });

  it("shows formatted error percentage when calls exist", () => {
    render(<BridgesPanel bridges={[IBKR_ALIVE]} loading={false} error={null} />);
    // IBKR_ALIVE has rpc_error_rate_5m=0.02 → "2.0%"
    expect(screen.getByText("2.0%")).toBeDefined();
  });
});
