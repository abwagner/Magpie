// Unit tests for getBridgeStatuses (QF-296).
// Tests cover: alive/unavailable/recovered transitions and mixed-broker state.

import { describe, it, expect } from "vitest";
import { getBridgeStatuses } from "../../health.js";
import { createMetricsRegistry } from "../../metrics.js";
import type { MarketDataAdapter } from "../../../../src/types/market-data.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeNtAdapter(broker: string, alive: boolean): MarketDataAdapter {
  return {
    name: `nt-bridge/${broker}`,
    async available() {
      return alive;
    },
    async stockQuote() {
      return null;
    },
    async expirations() {
      return null;
    },
    async chain() {
      return null;
    },
    async historicalChain() {
      return null;
    },
    subscribeQuotes() {
      return null;
    },
  };
}

function makeLegacyAdapter(name: string): MarketDataAdapter {
  return {
    name,
    async available() {
      return true;
    },
    async stockQuote() {
      return null;
    },
    async expirations() {
      return null;
    },
    async chain() {
      return null;
    },
    async historicalChain() {
      return null;
    },
    subscribeQuotes() {
      return null;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("getBridgeStatuses", () => {
  it("returns an empty bridges array when no nt-bridge adapters are present", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [makeLegacyAdapter("schwab"), makeLegacyAdapter("marketdata")],
      metrics,
    });
    expect(result.bridges).toHaveLength(0);
  });

  it("reports alive=true when nt-bridge adapter is available", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", true)],
      metrics,
    });
    expect(result.bridges).toHaveLength(1);
    const bridge = result.bridges[0]!;
    expect(bridge.broker).toBe("schwab");
    expect(bridge.alive).toBe(true);
  });

  it("reports alive=false when nt-bridge adapter is unavailable", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", false)],
      metrics,
    });
    expect(result.bridges).toHaveLength(1);
    const bridge = result.bridges[0]!;
    expect(bridge.broker).toBe("schwab");
    expect(bridge.alive).toBe(false);
  });

  it("treats available() throwing as alive=false (recovered transition)", async () => {
    const metrics = createMetricsRegistry();
    const adapter: MarketDataAdapter = {
      name: "nt-bridge/ibkr",
      async available() {
        throw new Error("NATS connection lost");
      },
      async stockQuote() {
        return null;
      },
      async expirations() {
        return null;
      },
      async chain() {
        return null;
      },
      async historicalChain() {
        return null;
      },
      subscribeQuotes() {
        return null;
      },
    };
    const result = await getBridgeStatuses({ adapters: [adapter], metrics });
    expect(result.bridges).toHaveLength(1);
    expect(result.bridges[0]!.broker).toBe("ibkr");
    expect(result.bridges[0]!.alive).toBe(false);
  });

  it("handles one-broker-down-other-up correctly", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", true), makeNtAdapter("ibkr", false)],
      metrics,
    });
    expect(result.bridges).toHaveLength(2);

    const schwab = result.bridges.find((b) => b.broker === "schwab");
    const ibkr = result.bridges.find((b) => b.broker === "ibkr");
    expect(schwab?.alive).toBe(true);
    expect(ibkr?.alive).toBe(false);
  });

  it("ignores non-bridge legacy adapters in the output", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [
        makeLegacyAdapter("marketdata"),
        makeNtAdapter("schwab", true),
        makeLegacyAdapter("databento"),
      ],
      metrics,
    });
    expect(result.bridges).toHaveLength(1);
    expect(result.bridges[0]!.broker).toBe("schwab");
  });

  it("surfaces RPC stats from the metrics registry by adapter name", async () => {
    const metrics = createMetricsRegistry();
    // Record some calls for the schwab nt-bridge adapter.
    metrics.record("nt-bridge/schwab", "quote", 42, true);
    metrics.record("nt-bridge/schwab", "quote", 80, false, "timeout");

    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", true)],
      metrics,
    });

    const bridge = result.bridges[0]!;
    expect(bridge.rpc_count_5m).toBe(2);
    expect(bridge.rpc_error_rate_5m).toBe(0.5);
    expect(bridge.rpc_latency_p50_ms).not.toBeNull();
    expect(bridge.rpc_latency_p99_ms).not.toBeNull();
  });

  it("returns zero RPC stats when no calls have been recorded", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", true)],
      metrics,
    });
    const bridge = result.bridges[0]!;
    expect(bridge.rpc_count_5m).toBe(0);
    expect(bridge.rpc_error_rate_5m).toBe(0);
    expect(bridge.rpc_latency_p50_ms).toBeNull();
    expect(bridge.rpc_latency_p99_ms).toBeNull();
  });

  // ── QF-341 — fallback liveness fields ───────────────────────────

  it("defaults priority_rank=null and serving_as_fallback=false with no policy", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", true)],
      metrics,
    });
    const bridge = result.bridges[0]!;
    expect(bridge.priority_rank).toBeNull();
    expect(bridge.serving_as_fallback).toBe(false);
    expect(result.policy).toBeUndefined();
  });

  it("derives priority_rank from the policy order (0 = primary)", async () => {
    const metrics = createMetricsRegistry();
    const policy = {
      fallback_enabled: true,
      priority: ["ibkr", "schwab"],
      heartbeat_stale_ms: 30000,
      methods: {},
    };
    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", true), makeNtAdapter("ibkr", true)],
      metrics,
      policy,
    });
    const schwab = result.bridges.find((b) => b.broker === "schwab");
    const ibkr = result.bridges.find((b) => b.broker === "ibkr");
    expect(ibkr?.priority_rank).toBe(0);
    expect(schwab?.priority_rank).toBe(1);
    expect(result.policy).toEqual(policy);
  });

  it("marks serving_as_fallback for brokers in the supplied set", async () => {
    const metrics = createMetricsRegistry();
    const result = await getBridgeStatuses({
      adapters: [makeNtAdapter("schwab", true), makeNtAdapter("ibkr", false)],
      metrics,
      brokersServingAsFallback: new Set(["schwab"]),
    });
    const schwab = result.bridges.find((b) => b.broker === "schwab");
    const ibkr = result.bridges.find((b) => b.broker === "ibkr");
    expect(schwab?.serving_as_fallback).toBe(true);
    expect(ibkr?.serving_as_fallback).toBe(false);
  });

  it("uses the adapter's exact last-heartbeat age when exposed (QF-341)", async () => {
    const metrics = createMetricsRegistry();
    const adapter: MarketDataAdapter & { lastHeartbeatAgeMs: () => number | null } = {
      ...makeNtAdapter("schwab", true),
      lastHeartbeatAgeMs: () => 4200,
    };
    const result = await getBridgeStatuses({ adapters: [adapter], metrics });
    expect(result.bridges[0]!.last_heartbeat_age_ms).toBe(4200);
  });
});
