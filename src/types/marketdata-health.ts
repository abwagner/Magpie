// Settings · Data · Health — frontend mirror of
// server/market-data/health.ts. Server is authoritative; keep in sync.

// ── Pre-rewrite types (QF-55) ─────────────────────────────────────
// Kept for backward compatibility with the legacy /api/data/sources/health
// endpoint. Do not use in new code.

export type AdapterAvailability = "available" | "unavailable" | "errored";

export interface AdapterMetricsSummary {
  source: string;
  calls: number;
  errors: number;
  error_rate: number;
  p50_ms: number | null;
  p99_ms: number | null;
  last_call_at?: string;
  last_success_at?: string;
  last_error?: { ts: string; method: string; message: string };
}

export interface AdapterHealth {
  source: string;
  availability: AdapterAvailability;
  availability_error?: string;
  metrics?: AdapterMetricsSummary;
}

export interface FallbackEvent {
  ts: string;
  from: string;
  to: string;
  method: string;
}

export interface MarketDataCredits {
  consumed: number;
  remaining: number | null;
  limit: number | null;
  /** Epoch seconds when the rate-limit window resets, per vendor header. */
  reset: number | null;
}

export interface MarketDataHealthResponse {
  generated_at: string;
  adapters: AdapterHealth[];
  recent_fallbacks: FallbackEvent[];
  marketdata_credits: MarketDataCredits;
}

// ── Post-rewrite bridge-heartbeat types (QF-296) ──────────────────
// GET /api/marketdata/bridges → { bridges: BridgeStatus[] }
// Per broker NT bridge alive state + heartbeat age + RPC error rate.
// Stale threshold: 30s without heartbeat → alive=false.

export interface BridgeStatus {
  broker: string;
  alive: boolean;
  /** Age of the last heartbeat in milliseconds. null if no heartbeat seen. */
  last_heartbeat_age_ms: number | null;
  /** Total RPC calls in the last 5-minute rolling window. */
  rpc_count_5m: number;
  /** Error rate (0–1) over the last 5-minute rolling window. */
  rpc_error_rate_5m: number;
  /** p50 RPC latency in ms over the last 5-minute window. null if no calls. */
  rpc_latency_p50_ms: number | null;
  /** p99 RPC latency in ms over the last 5-minute window. null if no calls. */
  rpc_latency_p99_ms: number | null;
}

export interface BridgesResponse {
  bridges: BridgeStatus[];
}
