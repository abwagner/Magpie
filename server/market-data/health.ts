// ── Market-Data Source Health ───────────────────────────────────────
//
// Two endpoints live here:
//
//   GET /api/data/sources/health  (QF-55, pre-rewrite)
//     Assembles per-adapter availability + metrics + fallback events +
//     MarketData.app credits. Backed by live `available()` probes and
//     the in-memory metrics registry.
//
//   GET /api/marketdata/bridges  (QF-296, post-rewrite)
//     Per-broker bridge alive state + heartbeat age + RPC error rate.
//     Uses adapter.available() as the alive proxy for the private
//     lastHeartbeatMs closure var until a fuller data-plane build
//     replaces the data source.
//
// All values are point-in-time snapshots; the UI re-fetches periodically
// rather than streaming.

import type { MarketDataAdapter } from "../../src/types/market-data.js";
import { getLastCredits } from "../../src/lib/marketdata-api.js";
import type { AdapterHealthSummary, FallbackEvent, MetricsRegistry } from "./metrics.js";

export type AdapterAvailability = "available" | "unavailable" | "errored";

export interface AdapterHealth {
  /** Adapter name as registered (e.g., "schwab", "marketdata"). */
  source: string;
  /** Result of an `available()` probe at request time. */
  availability: AdapterAvailability;
  /** Error message if `available()` threw — empty otherwise. */
  availability_error?: string;
  /** All telemetry counters from the metrics registry. Missing when the
   *  adapter hasn't been called yet in this process. */
  metrics?: AdapterHealthSummary;
}

export interface MarketDataCredits {
  /** Credits consumed on the most recent MarketData.app request. */
  consumed: number;
  /** Remaining credits in the current window; null if unknown. */
  remaining: number | null;
  /** Total allowed in the current window; null if unknown. */
  limit: number | null;
  /** Epoch seconds (per the vendor header) when the window resets. */
  reset: number | null;
}

export interface MarketDataHealthResponse {
  generated_at: string;
  adapters: AdapterHealth[];
  /** Newest-first ring of recent source-router fallback events. */
  recent_fallbacks: FallbackEvent[];
  /** Vendor-specific rate-limit telemetry where available. */
  marketdata_credits: MarketDataCredits;
}

export interface HealthDeps {
  adapters: MarketDataAdapter[];
  metrics: MetricsRegistry;
}

export async function getMarketDataHealth(deps: HealthDeps): Promise<MarketDataHealthResponse> {
  const summaries = new Map<string, AdapterHealthSummary>();
  for (const s of deps.metrics.snapshot()) summaries.set(s.source, s);

  const adapterHealth = await Promise.all(
    deps.adapters.map(async (a): Promise<AdapterHealth> => {
      let availability: AdapterAvailability;
      let availabilityError: string | undefined;
      try {
        availability = (await a.available()) ? "available" : "unavailable";
      } catch (e) {
        availability = "errored";
        availabilityError = e instanceof Error ? e.message : String(e);
      }
      const summary = summaries.get(a.name);
      return summary
        ? {
            source: a.name,
            availability,
            ...(availabilityError ? { availability_error: availabilityError } : {}),
            metrics: summary,
          }
        : {
            source: a.name,
            availability,
            ...(availabilityError ? { availability_error: availabilityError } : {}),
          };
    }),
  );

  return {
    generated_at: new Date().toISOString(),
    adapters: adapterHealth,
    recent_fallbacks: deps.metrics.recentFallbacks(),
    marketdata_credits: getLastCredits() as MarketDataCredits,
  };
}

// ── Bridge-heartbeat health (QF-296) ─────────────────────────────
//
// GET /api/marketdata/bridges — per-broker bridge alive state + RPC
// telemetry for the post-rewrite operator view.
//
// Bridge adapters are identified by adapter.name matching "nt-bridge/<broker>".
// The alive proxy is adapter.available(), which internally checks that a
// heartbeat was received within heartbeatStaleMs (default 30s). Until a
// fuller data-plane build exposes the private lastHeartbeatMs directly, this
// is the correct stub per the ticket's "stub-the-data-source clause".
//
// RPC stats (count, error rate, latency) come from the MetricsRegistry
// snapshot keyed on adapter.name.

export interface BridgeStatus {
  broker: string;
  alive: boolean;
  /** Milliseconds since last heartbeat. null if no heartbeat ever received. */
  last_heartbeat_age_ms: number | null;
  rpc_count_5m: number;
  rpc_error_rate_5m: number;
  rpc_latency_p50_ms: number | null;
  rpc_latency_p99_ms: number | null;
}

export interface BridgesResponse {
  bridges: BridgeStatus[];
}

export interface BridgesDeps {
  /** Full adapter list. Only nt-bridge adapters are surfaced. */
  adapters: MarketDataAdapter[];
  metrics: MetricsRegistry;
}

// NT bridge adapter names follow the pattern "nt-bridge/<broker>".
const NT_BRIDGE_PREFIX = "nt-bridge/";

export async function getBridgeStatuses(deps: BridgesDeps): Promise<BridgesResponse> {
  const bridgeAdapters = deps.adapters.filter((a) => a.name.startsWith(NT_BRIDGE_PREFIX));

  const summaries = new Map<string, AdapterHealthSummary>();
  for (const s of deps.metrics.snapshot()) summaries.set(s.source, s);

  const bridges = await Promise.all(
    bridgeAdapters.map(async (a): Promise<BridgeStatus> => {
      const broker = a.name.slice(NT_BRIDGE_PREFIX.length);

      // alive proxy: adapter.available() checks lastHeartbeatMs internally.
      let alive = false;
      try {
        alive = await a.available();
      } catch {
        // Treat errors as unavailable — same as heartbeat timeout.
      }

      // Heartbeat age is approximated from alive state. When alive=true the
      // bridge saw a heartbeat within 30s; when alive=false we cannot know
      // the exact age without exposing the private closure — return null.
      // The data-plane build-out ticket will replace this with an exact value.
      const last_heartbeat_age_ms: number | null = alive ? null : null;

      const summary = summaries.get(a.name);

      return {
        broker,
        alive,
        last_heartbeat_age_ms,
        rpc_count_5m: summary?.calls ?? 0,
        rpc_error_rate_5m: summary?.error_rate ?? 0,
        rpc_latency_p50_ms: summary?.p50_ms ?? null,
        rpc_latency_p99_ms: summary?.p99_ms ?? null,
      };
    }),
  );

  return { bridges };
}
