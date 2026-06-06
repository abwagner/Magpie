// ── Data Adapter Interface & Registry ──────────────────────────────
// Defined in: docs/tdd/signal-orchestrator.md

// ── Types ─────────────────────────────────────────────────────────

export interface DataRequest {
  /** Source-specific arguments (e.g. {series: "WCRFPUS2"} or {symbol: "EQ:SPY", type: "quote"}) */
  args: Record<string, unknown>;
  /** File path for persistent data, relative to data_dir. Absent for in-memory live data. */
  output?: string;
  /** Incremental start date override (YYYY-MM-DD). */
  since?: string;
}

export interface DataResult {
  request: DataRequest;
  ok: boolean;
  /** Max date in the result — used for freshness checks on persistent feeds. */
  dataThrough?: string;
  /** In-memory result for live data (quotes, chains). */
  data?: unknown;
  /** Error message if ok=false. */
  error?: string;
}

export interface AdapterCapabilities {
  /** Can handle multiple items per fetch call. */
  batch: boolean;
  /** Supports long-lived connections (WebSocket, streaming). */
  streaming: boolean;
  /** Max concurrent requests the adapter supports. */
  maxConcurrent: number;
}

export interface DataAdapter {
  id: string;
  capabilities: AdapterCapabilities;
  /** Fetch one or more items. Adapter handles auth, pagination, rate limits internally. */
  fetch(requests: DataRequest[]): Promise<DataResult[]>;
  /**
   * Optional: report whether the adapter can actually service a request with
   * the given args. Used by the UI to disable manual-refresh buttons for
   * unsupported types (e.g. candles). Default: assume supported.
   */
  supportsRequest?(args: Record<string, unknown>): boolean;
}

export function adapterSupports(adapter: DataAdapter, args: Record<string, unknown>): boolean {
  return adapter.supportsRequest ? adapter.supportsRequest(args) : true;
}

// ── Registry ──────────────────────────────────────────────────────

const adapters = new Map<string, DataAdapter>();

export function registerAdapter(adapter: DataAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`Adapter "${adapter.id}" already registered`);
  }
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): DataAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(
      `No adapter registered for "${id}". Available: ${[...adapters.keys()].join(", ")}`,
    );
  }
  return adapter;
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}
