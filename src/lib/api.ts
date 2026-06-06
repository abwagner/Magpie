// ── Server API Client ────────────────────────────────────────────────────
// Single client that calls the Magpie API server.
// Replaces direct calls to Schwab/IBKR/MarketData from the browser.
//
// During the JSX → TS migration most endpoints type their response as
// `unknown` so callers narrow at the consumer. Endpoints whose payload
// matches a shape already declared in src/types/ are typed precisely.

import type { Quote, Contract } from "../types/market-data.js";
import type { Order, Fill, OrderStatus } from "../types/order.js";
import type { PortfolioSnapshot } from "../types/portfolio.js";
import type { Strategy, LifecycleAction } from "../types/strategy.js";
import type { RiskLimits } from "../types/portfolio.js";
import type { RiskLimitsConfig, WsMessage } from "../types/ws.js";

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}
interface ImportMetaWithEnv {
  readonly env?: ImportMetaEnv;
}

const SERVER =
  (import.meta as unknown as ImportMetaWithEnv).env?.VITE_API_URL || "http://localhost:3001";

// ── HTTP helpers ────────────────────────────────────────────────────────

async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `API error: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `API error: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function put<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `API error: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function del<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `API error: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ── Live data (from data sources, also stored to DB) ─────────────────────

export async function stockQuote(symbol: string): Promise<Quote> {
  return get(`/api/quote/${encodeURIComponent(symbol)}`);
}

export interface FuturesMonth {
  symbol: string;
  code: string;
  month: string;
  last?: number;
  bid?: number;
  ask?: number;
}

export async function futuresMonths(symbol: string): Promise<FuturesMonth[]> {
  return get(`/api/futures-months/${encodeURIComponent(symbol)}`);
}

export async function expirations(symbol: string): Promise<string[]> {
  return get(`/api/expirations/${encodeURIComponent(symbol)}`);
}

export async function chain(
  symbol: string,
  expiration: string,
  strikeLimit = 30,
): Promise<Contract[]> {
  return get(`/api/chain/${encodeURIComponent(symbol)}/${expiration}?strikeLimit=${strikeLimit}`);
}

// ── Stored data (from Parquet) ───────────────────────────────────────────

export async function getStoredDates(symbol: string): Promise<string[]> {
  return get(`/api/data/dates/${encodeURIComponent(symbol)}`);
}

export async function getStoredChain(
  symbol: string,
  date: string,
  expiration: string | null = null,
): Promise<Contract[]> {
  let path = `/api/data/chain/${encodeURIComponent(symbol)}/${date}`;
  if (expiration) path += `/${expiration}`;
  return get(path);
}

// ── Data summary / catalog ───────────────────────────────────────────────

export interface DataSummaryRow {
  symbol: string;
  date_min: string;
  date_max: string;
  trading_days: number;
  total_rows: number;
  price_min: number;
  price_max: number;
  files: number;
}

export interface DataDetailRow {
  date: string;
  underlying_price: number;
  contracts: number;
  unique_strikes: number;
  expirations: number;
  strike_min: number;
  strike_max: number;
  strike_width_pct: number;
}

export async function getDataSummary(): Promise<DataSummaryRow[]> {
  return get("/api/data/summary");
}

export async function getDataDetail(symbol: string): Promise<DataDetailRow[]> {
  return get(`/api/data/detail/${encodeURIComponent(symbol)}`);
}

// Unified data catalog (all kinds: chains, signals, ETFs, futures, macro, fills, backtests)
export async function getCatalog({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<unknown> {
  return get(`/api/catalog${refresh ? "?refresh=1" : ""}`);
}

// quant-optimizer per-run drill-down: returns the parsed wfo_results JSON
// for a single qo-run descriptor (the id is the form `qo-run:<base>`; the
// API path drops the kind prefix).
export async function getQoRun(id: string): Promise<unknown> {
  const stripped = id.startsWith("qo-run:") ? id.slice("qo-run:".length) : id;
  return get(`/api/qo-run/${encodeURIComponent(stripped)}`);
}

// Cross-source download / ingest run history.
import type { RunsResponse, RunActivityResponse } from "../types/downloads.js";
export async function getDownloadRuns({
  refresh = false,
}: { refresh?: boolean } = {}): Promise<RunsResponse> {
  return get(`/api/downloads/runs${refresh ? "?refresh=1" : ""}`);
}
export async function getDownloadRun(id: string): Promise<RunActivityResponse> {
  return get(`/api/downloads/runs/${encodeURIComponent(id)}`);
}

// ── Data loading ─────────────────────────────────────────────────────────

export interface LoadStatus {
  running: boolean;
  progress?: number;
  total?: number;
  symbol?: string;
  currentDate?: string;
  contractsLoaded?: number;
  errors?: unknown[];
}

export async function startLoad(
  symbol: string,
  from: string,
  to: string,
): Promise<{ totalDays: number }> {
  return post("/api/load", { symbol, from, to });
}

export async function getLoadStatus(): Promise<LoadStatus> {
  return get("/api/load/status");
}

export async function cancelLoad(): Promise<unknown> {
  return post("/api/load/cancel");
}

// ── Server status ────────────────────────────────────────────────────────

export async function getStatus(): Promise<unknown> {
  return get("/api/status");
}

export async function getSources(): Promise<unknown> {
  return get("/api/sources");
}

// ── Trading System API ──────────────────────────────────────────────────

// Portfolio
export const getPortfolio = (id: string): Promise<unknown> =>
  get(`/api/portfolio/${encodeURIComponent(id)}`);
export const getPortfolioSnapshots = (id: string): Promise<PortfolioSnapshot[]> =>
  get(`/api/portfolio/${encodeURIComponent(id)}/snapshots`);

// System
export const systemKill = (reason: string): Promise<unknown> =>
  post("/api/system/kill", { reason });
export const systemReset = (): Promise<unknown> => post("/api/system/reset");
export const getSystemStatus = (): Promise<unknown> => get("/api/system/status");

// Orders
export const getOrders = (params: Record<string, string> = {}): Promise<Order[]> => {
  const qs = new URLSearchParams(params).toString();
  return get(`/api/orders${qs ? "?" + qs : ""}`);
};
// QF-50 — operator-edit overrides supplied by the GUI's approval queue.
// Each field is optional; only the fields the operator actually changed
// should be included. The backend computes the diff vs the Execution
// Layer's recommendation and stores the diff in
// audit_orders.operator_edits.
export interface ApproveOrderEdits {
  order_type?: "market" | "limit";
  limit_price?: number;
  time_in_force?: "day" | "gtc" | "ioc" | "fok";
  working_policy_id?: string;
}

export const approveOrder = (
  id: string,
  edits?: ApproveOrderEdits,
): Promise<{ status: OrderStatus }> =>
  post(`/api/orders/${encodeURIComponent(id)}/approve`, edits ?? {});
export const rejectOrder = (id: string): Promise<{ status: OrderStatus }> =>
  post(`/api/orders/${encodeURIComponent(id)}/reject`);
export const cancelOrder = (id: string): Promise<{ status: OrderStatus }> =>
  post(`/api/orders/${encodeURIComponent(id)}/cancel`);

// ── QF-323 — operator manual liquidation ──────────────────────────
// Mirrors server/api/positions.ts LiquidationOutcome. Closes one
// position (or several via multi-select); the server resolves each
// position_id against the framework projector and submits a closing
// intent through OPL.
export interface LiquidationOutcome {
  position_id: string;
  status: "submitted" | "not_found" | "error";
  intent_id?: string;
  order_id?: string;
  order_status?: string;
  error?: string;
}

export const liquidatePosition = (id: string): Promise<{ results: LiquidationOutcome[] }> =>
  post(`/api/positions/${encodeURIComponent(id)}/liquidate`);

export const liquidatePositions = (
  positionIds: string[],
): Promise<{ results: LiquidationOutcome[] }> =>
  post("/api/positions/liquidate", { position_ids: positionIds });

// Trade Inspector
//
// inspectTrades — multi-mode list endpoint (no params: recent intents;
// strategy_id / from+to: filtered intents). Used by AuditLogScreen.
// inspectTrade — QF-215 / QF-229 single-fill structured handler:
// /api/trades/inspect?fill_id=<ulid> returns the full audit chain
// (signal → intent → pricing decisions → order → fill) as nested JSON.
export const inspectTrades = (params: Record<string, string> = {}): Promise<unknown> => {
  const qs = new URLSearchParams(params).toString();
  return get(`/api/trades/inspect${qs ? "?" + qs : ""}`);
};

export const inspectTrade = (fillId: string): Promise<unknown> =>
  get(`/api/trades/inspect?fill_id=${encodeURIComponent(fillId)}`);

// Trade Journal
export const getTradeJournal = (
  params: Record<string, string> = {},
): Promise<{ trades: unknown[] }> => {
  const qs = new URLSearchParams(params).toString();
  return get(`/api/trades/journal${qs ? "?" + qs : ""}`);
};

// Risk limits
export const getRiskLimits = (): Promise<RiskLimitsConfig> => get("/api/risk/limits");
export const setRiskLimits = (portfolioId: string, limits: RiskLimits): Promise<RiskLimitsConfig> =>
  put(`/api/risk/limits/${encodeURIComponent(portfolioId)}`, limits);

// Strategy lifecycle
export const listStrategies = (): Promise<Strategy[]> => get("/api/strategies");
export const registerStrategy = (input: {
  id: string;
  label: string;
  manifest_revision?: string | null;
  operator_notes?: string;
}): Promise<Strategy> => post("/api/strategies", input);
export const transitionStrategy = (
  id: string,
  action: LifecycleAction,
  reason?: string,
): Promise<Strategy> =>
  post(`/api/strategies/${encodeURIComponent(id)}/transition`, { action, reason });
export const setStrategyNotes = (id: string, notes: string): Promise<Strategy> =>
  put(`/api/strategies/${encodeURIComponent(id)}/notes`, { notes });

// QF-331: pin a QO backtest archive as the drift baseline for a strategy.
// Stores baseline_qo_run in the strategy's drift spec.
export const pinDriftBaseline = (
  id: string,
  baselineQoRun: string,
  actor?: string,
): Promise<{ strategy_id: string; baseline_qo_run: string }> =>
  put(`/api/strategies/${encodeURIComponent(id)}/drift-baseline`, {
    baseline_qo_run: baselineQoRun,
    actor,
  });

// QF-59: strategy config (config/portfolios.json `strategies.<id>.config`).
export interface StrategyConfigSummary {
  portfolio: string;
  id: string;
  module: string;
  signal_interests: string[];
  signal_staleness_seconds: number;
  config_keys: string[];
}
export interface StrategyConfigEntry {
  module: string;
  config: Record<string, unknown>;
  signal_interests: string[];
  signal_staleness_seconds: number;
}
export const listStrategyConfigs = (): Promise<{ strategies: StrategyConfigSummary[] }> =>
  get("/api/strategies/config");
export const getStrategyConfig = (id: string, portfolio?: string): Promise<StrategyConfigEntry> => {
  const qs = portfolio ? `?portfolio=${encodeURIComponent(portfolio)}` : "";
  return get(`/api/strategies/${encodeURIComponent(id)}/config${qs}`);
};
export const setStrategyConfig = (
  id: string,
  patch: Partial<Omit<StrategyConfigEntry, "module">>,
  portfolio?: string,
): Promise<StrategyConfigEntry> => {
  const qs = portfolio ? `?portfolio=${encodeURIComponent(portfolio)}` : "";
  return put(`/api/strategies/${encodeURIComponent(id)}/config${qs}`, patch);
};

// Store
export const getStoreSummary = (): Promise<unknown> => get("/api/store/summary");

// Positions & accounts (Schwab)
import type { BrokerPositions } from "../types/broker.js";
export const getPositions = (accountHash?: string): Promise<BrokerPositions> =>
  get(`/api/positions${accountHash ? "?account=" + encodeURIComponent(accountHash) : ""}`);

export interface SchwabAccount {
  hashValue: string;
  accountNumber: string;
  type?: string;
}
export const getAccounts = (): Promise<{ accounts: SchwabAccount[] }> => get("/api/accounts");

// Market Data
export const getMarketDataStatus = (): Promise<unknown> => get("/api/market-data/status");

import type { SecretsStatusResponse } from "../types/secrets.js";
export const getSecretsStatus = (): Promise<SecretsStatusResponse> => get("/api/secrets/status");

import type { BridgesResponse, MarketDataHealthResponse } from "../types/marketdata-health.js";
export const getMarketDataHealth = (): Promise<MarketDataHealthResponse> =>
  get("/api/data/sources/health");
export const getMarketDataBridges = (): Promise<BridgesResponse> => get("/api/marketdata/bridges");

import type { FreshnessResponse } from "../types/catalog.js";
export const getCatalogFreshness = (): Promise<FreshnessResponse> => get("/api/catalog/freshness");

/** Submit an ingest/backfill write-job for a source.
 *  - fmp → kind: "fmp-backfill"
 *  - databento → kind: "databento-pull"
 *  - everything else → kind: "ingest" with { source } params
 */
export function submitIngest(source: string): Promise<SubmitWriteJobResponse> {
  if (source === "fmp") return submitWriteJob("fmp-backfill", {});
  if (source === "databento") return submitWriteJob("databento-pull", {});
  return submitWriteJob("ingest", { source });
}

import type { ModelThresholds, QualityThresholdsConfig } from "../types/quality-thresholds.js";
export const getQualityThresholds = (): Promise<QualityThresholdsConfig> =>
  get("/api/quality_thresholds");
export const setModelQualityThresholds = (
  modelId: string,
  thresholds: ModelThresholds,
): Promise<QualityThresholdsConfig> =>
  put(`/api/models/${encodeURIComponent(modelId)}/quality_thresholds`, thresholds);

import type {
  AlertEvent,
  AlertLevel,
  AlertRule,
  AlertsConfig,
  AlertsRecentResponse,
} from "../types/alerts.js";
export const getAlertRules = (): Promise<AlertsConfig> => get("/api/alerts/rules");
export const setAlertRules = (rules: AlertRule[]): Promise<AlertsConfig> =>
  put("/api/alerts/rules", { rules });
export const getRecentAlerts = (limit = 50): Promise<AlertsRecentResponse> =>
  get(`/api/alerts/recent?limit=${limit}`);
export const fireTestAlert = (input: {
  type?: string;
  level?: AlertLevel;
  message?: string;
  payload?: Record<string, unknown>;
}): Promise<{ event: AlertEvent }> => post("/api/alerts/test", input);

import type { HaltEvent, HaltsHistoryResponse } from "../types/halts.js";
export const getHaltsHistory = (limit = 100): Promise<HaltsHistoryResponse> =>
  get(`/api/halts/history?limit=${limit}`);
export const haltPortfolio = (portfolioId: string, reason: string): Promise<{ event: HaltEvent }> =>
  post(`/api/portfolio/${encodeURIComponent(portfolioId)}/halt`, { reason });
export const resetPortfolio = (
  portfolioId: string,
  reason: string,
): Promise<{ event: HaltEvent }> =>
  post(`/api/portfolio/${encodeURIComponent(portfolioId)}/reset`, { reason });

import type { FundamentalsStatusResponse } from "../types/fundamentals.js";
export const getFundamentalsStatus = (): Promise<FundamentalsStatusResponse> =>
  get("/api/fundamentals/status");

import type {
  WriteJob,
  WriteJobsListResponse,
  SubmitWriteJobResponse,
} from "../types/write-jobs.js";

// Write-job dispatch (M10-1). Bearer-token auth; the GUI stashes the
// token in sessionStorage so it's not in the URL or persisted on disk.
const WRITE_JOB_TOKEN_KEY = "qf.writeJobToken";
export function getWriteJobToken(): string | null {
  try {
    return sessionStorage.getItem(WRITE_JOB_TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setWriteJobToken(token: string | null): void {
  try {
    if (token === null || token === "") sessionStorage.removeItem(WRITE_JOB_TOKEN_KEY);
    else sessionStorage.setItem(WRITE_JOB_TOKEN_KEY, token);
  } catch {
    /* sessionStorage might be disabled */
  }
}

async function writeJobFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getWriteJobToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${SERVER}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      reason?: string;
      details?: unknown;
    };
    throw new Error(
      body.error
        ? `${body.error}${body.reason ? ` (${body.reason})` : ""}`
        : `API error: HTTP ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export const listWriteJobs = (
  params: { kind?: string; limit?: number } = {},
): Promise<WriteJobsListResponse> => {
  const qs = new URLSearchParams();
  if (params.kind) qs.set("kind", params.kind);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const tail = qs.toString();
  return writeJobFetch(`/api/write-jobs${tail ? `?${tail}` : ""}`);
};

export const getWriteJob = (jobId: string): Promise<WriteJob> =>
  writeJobFetch(`/api/write-jobs/${encodeURIComponent(jobId)}`);

export const submitWriteJob = (kind: string, params: unknown): Promise<SubmitWriteJobResponse> =>
  writeJobFetch("/api/write-jobs", {
    method: "POST",
    body: JSON.stringify({ kind, params }),
  });

import type { ExportFormat, ExportsListResponse } from "../types/exports.js";
export const listExports = (): Promise<ExportsListResponse> => get("/api/exports");
/** URL for a download; the caller hits this via a hidden anchor so
 *  the browser drives the file save (no JSON round-trip in JS). */
export function exportDownloadUrl(
  kind: string,
  from: string | null,
  to: string | null,
  format: ExportFormat,
): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("format", format);
  return `${SERVER}/api/exports/${encodeURIComponent(kind)}?${params.toString()}`;
}

import type { RiskPoliciesConfig, RiskPolicy } from "../types/risk-policies.js";
export const getRiskPolicies = (): Promise<RiskPoliciesConfig> => get("/api/risk/policies");
export const upsertRiskPolicy = (id: string, policy: RiskPolicy): Promise<RiskPoliciesConfig> =>
  put(`/api/risk/policies/${encodeURIComponent(id)}`, policy);
export const deleteRiskPolicy = (id: string): Promise<RiskPoliciesConfig> =>
  del(`/api/risk/policies/${encodeURIComponent(id)}`);
export const applyRiskPolicy = (
  policyId: string,
  portfolioId: string,
): Promise<{ applied: unknown }> =>
  post(`/api/risk/policies/${encodeURIComponent(policyId)}/apply`, {
    portfolio_id: portfolioId,
  });

// ── WebSocket ───────────────────────────────────────────────────────────

export function connectStateWs(
  onMessage: (msg: WsMessage) => void,
  onClose: () => void,
): WebSocket {
  const wsUrl = SERVER.replace(/^http/, "ws") + "/ws/state";
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data) as WsMessage);
  ws.onclose = onClose;
  ws.onerror = () => ws.close();
  return ws;
}

// Re-export bag for components that import { api } rather than named symbols.
export const api = {
  stockQuote,
  expirations,
  chain,
  futuresMonths,
  getStoredDates,
  getStoredChain,
  getDataSummary,
  getDataDetail,
  getCatalog,
  getQoRun,
  getDownloadRuns,
  getDownloadRun,
  startLoad,
  getLoadStatus,
  cancelLoad,
  getStatus,
  getSources,
  getPositions,
  getAccounts,
  getPortfolio,
  getPortfolioSnapshots,
  systemKill,
  systemReset,
  getSystemStatus,
  getOrders,
  approveOrder,
  rejectOrder,
  cancelOrder,
  inspectTrades,
  inspectTrade,
  getTradeJournal,
  getRiskLimits,
  setRiskLimits,
  listStrategies,
  registerStrategy,
  transitionStrategy,
  setStrategyNotes,
  getStoreSummary,
  getMarketDataStatus,
  getSecretsStatus,
  getMarketDataHealth,
  getMarketDataBridges,
  getQualityThresholds,
  setModelQualityThresholds,
  getAlertRules,
  setAlertRules,
  getRecentAlerts,
  fireTestAlert,
  getHaltsHistory,
  haltPortfolio,
  resetPortfolio,
  getFundamentalsStatus,
  listWriteJobs,
  getWriteJob,
  submitWriteJob,
  getWriteJobToken,
  setWriteJobToken,
  listExports,
  exportDownloadUrl,
  getRiskPolicies,
  upsertRiskPolicy,
  deleteRiskPolicy,
  applyRiskPolicy,
  connectStateWs,
  getCatalogFreshness,
  submitIngest,
};
