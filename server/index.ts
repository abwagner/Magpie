#!/usr/bin/env node
// ── API Server ───────────────────────────────────────────────────────────
// Central server for the EV Trading System. Handles data fetching, storage,
// signal ingress, portfolio management, order execution, and serves the GUI.
//
// Startup sequence defined in: docs/TRADING-SYSTEM-TDD.md
//
// Environment variables:
//   PORT             (default: 3001)
//   DATA_URI         file:///abs/data or s3://bucket — preferred. Defaults to
//                    file://<repo>/data if neither this nor DATA_DIR is set.
//   DATA_DIR         legacy: filesystem path to the data root.
//   CATALOG_DB_PATH  (default: <repo>/data/portfolio.duckdb) file-based DuckDB
//                    catalog. Stays local even when DATA_URI is s3://.
//   MD_TOKEN         MarketData.app API token
//   NATS_URL         (default: nats://localhost:4222)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import duckdb from "duckdb";
import { ulid } from "ulid";
import promClient from "prom-client";
import type { NatsConnection } from "nats";
import type { PortfolioConfig, RiskLimits } from "../src/types/portfolio.js";
import type { LogLevel } from "./logger.js";
import type { Calendar } from "./calendar/index.js";
import type { MarketDataService } from "../src/types/market-data.js";
import type { StateWebSocket } from "./ws-state.js";
import type { NtBridgeMdConfig } from "./market-data/nt-bridge-md-config.js";
import type { LiquidationDeps } from "./api/positions.js";

// Load .env file (server-side, no Vite)
const __dirname_early = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(resolve(__dirname_early, "..", ".env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) {
      const key = m[1]?.trim();
      const val = m[2]?.trim();
      if (key && val !== undefined && !process.env[key]) process.env[key] = val;
    }
  }
} catch {}

// The chains storage layer (and other data adapters) resolve URIs through
// DATA_URI / DATA_DIR. Default DATA_DIR to the repo's data/ root if neither
// is set, so dev workflows keep working without explicit env config.
// QF-74 finishes the DATA_URI cutover (banner, joinUri sites, etc.).
if (!process.env.DATA_URI && !process.env.DATA_DIR) {
  process.env.DATA_DIR = resolve(__dirname_early, "..", "data");
}

// ── Existing modules ────────────────────────────────────────────────────
import { createStorage } from "./storage.js";
import { dataUri, joinUri } from "./orchestrator/storage.js";
import * as dataSources from "./data-sources.js";
import { startLoad, getLoadStatus, cancelLoad } from "./loader.js";

// ── New trading system modules ──────────────────────────────────────────
import { createLogger } from "./logger.js";
import { initDatabase } from "./db/init.js";
import { loadCalendar, createCalendar } from "./calendar/index.js";
import { createPortfolioEngine } from "./portfolio/engine.js";
import { createOrderPlane } from "./order/plane.js";
import { createFillLog } from "./order/fill-log.js";
import { createPaperAdapter } from "./order/adapters/paper.js";
import { createNtBridgeAdapter } from "./order/adapters/nt-bridge.js";
import { createNtObserverConsumer } from "./order/adapters/nt-observer-consumer.js";
import { loadBrokersConfig } from "./order/brokers-config.js";
import { liquidatePositions } from "./api/positions.js";
import { createGateHandler, createDefaultEvaluator } from "./risk/gate-handler.js";
import { createAuditIntentWriter } from "./order/audit-intent.js";
import { createStoreQuery } from "./store/query.js";
import { createStoreApi } from "./store/api.js";
import { createCatalogService } from "./catalog/index.js";
import { createCatalogApi } from "./catalog/api.js";
import { computeFreshness } from "./catalog/freshness.js";
import type { DataPlaneConfig } from "./catalog/freshness.js";
import { createFreshnessMonitor } from "./catalog/freshness-monitor.js";
import { createDownloadsService } from "./downloads/index.js";
import { createDownloadsApi } from "./downloads/api.js";
import { initWriteJobs } from "./writeJobs/init.js";
import { createStateWebSocket } from "./ws-state.js";
import { StrategyStore } from "./strategy/lifecycle.js";
import { StrategyConfigStore } from "./strategy/config-store.js";
import { RiskLimitsStore } from "./risk/limits.js";
import { QualityThresholdsStore } from "./risk/quality_thresholds.js";
import { RiskPoliciesStore } from "./risk/policies.js";
import { createExportsApi } from "./exports/api.js";
import { createHaltsStore } from "./risk/halts.js";
import { createAlertRouter } from "./alerts/router.js";
import {
  createExitRuleMonitor,
  createExitRuleMetrics,
  type ExitRuleMonitor,
} from "./portfolio/exit-rule-monitor.js";
import { createTelemetryHandler } from "./telemetry/handler.js";
import type { ExitRuleHeadroom } from "./strategy/lifecycle.js";

const __dirname = __dirname_early;
const PORT = parseInt(process.env.PORT || "3001", 10);
const ROOT_DIR = resolve(__dirname, "..");

// ── Environment ────────────────────────────────────────────────────────
// APP_ENV: "dev" (default) or "prod"
// TRADING_MODE: "paper" (default) or "live"
// Safety: live trading requires prod environment. dev+live is forced to dev+paper.

const rawAppEnv = (process.env.APP_ENV || "dev").toLowerCase();
const rawTradingMode = (process.env.TRADING_MODE || "paper").toLowerCase();

const APP_ENV = rawAppEnv === "prod" ? "prod" : "dev";
const TRADING_MODE =
  APP_ENV === "dev" && rawTradingMode === "live"
    ? "paper" // dev+live → dev+paper (safety gate)
    : rawTradingMode === "live"
      ? "live"
      : "paper";

if (rawAppEnv === "dev" && rawTradingMode === "live") {
  console.warn(
    "  WARNING: TRADING_MODE=live ignored in dev environment. Set APP_ENV=prod to enable live trading.",
  );
}

// ── Logger ──────────────────────────────────────────────────────────────

const logger = createLogger("server", (process.env.LOG_LEVEL ?? "info") as LogLevel);

// ── 1. DuckDB + table init ──────────────────────────────────────────────

// portfolio.duckdb is a file-based DuckDB DB and stays local even when the
// rest of the data lives on MinIO. The cron rebuild on your-server.example.com
// writes to /srv/quantfoundry/portfolio.duckdb via this env override and
// uploads to MinIO; laptops fetch into the default location for read-only use.
const dbPath = process.env.CATALOG_DB_PATH || resolve(ROOT_DIR, "data", "portfolio.duckdb");
const db = new duckdb.Database(dbPath);
await initDatabase(db);

// ── 2. Market calendar ──────────────────────────────────────────────────

let calendar: Calendar;
try {
  calendar = loadCalendar(resolve(ROOT_DIR, "config/market-calendar.json"));
} catch (e) {
  logger.warn("Market calendar not loaded; using empty calendar", {
    error: String(e instanceof Error ? e.message : e),
  });
  // Provide a minimal empty calendar so the portfolio engine can still start
  calendar = createCalendar({ exchanges: {} });
}

// ── 3. Config loaders ───────────────────────────────────────────────────

// Load portfolio config
let portfolioConfigs: Record<string, PortfolioConfig> = {};
try {
  const raw = readFileSync(resolve(ROOT_DIR, "config/portfolios.json"), "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "portfolios" in parsed && parsed.portfolios) {
    portfolioConfigs = parsed.portfolios as Record<string, PortfolioConfig>;
  }
} catch (e) {
  logger.warn("Portfolio config not loaded", {
    error: e instanceof Error ? e.message : String(e),
  });
}

// ── 4. Storage (existing) ───────────────────────────────────────────────

// `createStorage` resolves chains via DATA_URI / joinUri internally; no path arg.
const storage = createStorage();

// ── 5. Store query ──────────────────────────────────────────────────────

const storeQuery = createStoreQuery(db, logger.child("store"));
const storeApi = createStoreApi({ storeQuery, logger: logger.child("store-api") });

// ── 5a. Data Catalog (cross-kind inventory) ────────────────────────────
const catalogService = createCatalogService({
  db,
  storage,
  rootDir: ROOT_DIR,
  logger: logger.child("catalog"),
});
const catalogApi = createCatalogApi({
  service: catalogService,
  logger: logger.child("catalog-api"),
});

// ── 5a-i. Catalog freshness config (QF-293) ─────────────────────────────
// Load config/data-plane.json for the per-source cadence map.
// Fails gracefully: if the file is absent or malformed the freshness
// endpoint returns an empty sources list rather than crashing boot.
let dataPlaneCfg: DataPlaneConfig = { ingestion: {} };
try {
  const raw = JSON.parse(
    readFileSync(resolve(ROOT_DIR, "config/data-plane.json"), "utf-8"),
  ) as Record<string, unknown>;
  const ingestion = raw["ingestion"];
  if (ingestion && typeof ingestion === "object" && !Array.isArray(ingestion)) {
    dataPlaneCfg = { ingestion: ingestion as DataPlaneConfig["ingestion"] };
  }
} catch (e) {
  logger.warn("data-plane.json not loaded; catalog freshness will return empty list", {
    error: e instanceof Error ? e.message : String(e),
  });
}

// ── 5c. Downloads (cross-source ingest run history) ────────────────
const downloadsService = createDownloadsService({
  rootDir: ROOT_DIR,
  logger: logger.child("downloads"),
});
const downloadsApi = createDownloadsApi({
  service: downloadsService,
  logger: logger.child("downloads-api"),
});

// ── 5b. NATS connection ────────────────────────────────────────────────

import { connect as natsConnect } from "nats";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
let natsConn: NatsConnection | null = null;

try {
  natsConn = await natsConnect({ servers: NATS_URL });
} catch (e) {
  logger.warn("NATS not available", { url: NATS_URL });
}

// ── 7. Portfolio Engine(s) ──────────────────────────────────────────────

// QF-351 — forward references: exitRuleMonitor is assigned after orderPlane
// (step 8). strategyStore is assigned further down the boot sequence.
// Both callbacks (onPositionUpdate, onEvalComplete) run long after boot so
// all references are valid by call time.
let exitRuleMonitor: ExitRuleMonitor | null = null;
let strategyStore!: StrategyStore;

const portfolioEngine = createPortfolioEngine({
  logger: logger.child("portfolio"),
  onPositionUpdate: (update) => {
    // Fan-out: exit-rule evaluation + live positions push to WS clients.
    exitRuleMonitor?.onPositionUpdate(update);
    stateWs?.pushPortfolioUpdate(update.portfolio, { positions: update.positions });
  },
});

for (const [id, cfg] of Object.entries(portfolioConfigs) as [string, PortfolioConfig][]) {
  portfolioEngine.initPortfolio(id, cfg);
}

// ── 8. Order Plane ──────────────────────────────────────────────────────

const mainPortfolio = Object.keys(portfolioConfigs)[0] ?? "main";
const fillLog = createFillLog(resolve(ROOT_DIR, "data", "fills", `${mainPortfolio}.jsonl`));

const portfolioConfig = (portfolioConfigs[mainPortfolio] ?? {}) as Partial<PortfolioConfig> & {
  slippage?: number;
};
const paperAdapter = createPaperAdapter(
  { slippage: portfolioConfig.slippage },
  {
    getQuote: async (symbol) => {
      const q = await dataSources.stockQuote(symbol);
      return { bid: q.bid ?? 0, ask: q.ask ?? 0, mid: q.mid ?? 0 };
    },
  },
  () => ulid(),
);

import type { ExecutionMode } from "../src/types/order.js";
// Force paper mode unless prod+live
const effectiveMode: ExecutionMode =
  TRADING_MODE === "live" && APP_ENV === "prod"
    ? ((portfolioConfigs[mainPortfolio]?.mode ?? "paper_local") as ExecutionMode)
    : "paper_local";

import { createTradeJournal } from "./order/trade-journal.js";
const tradeJournal = createTradeJournal(db, logger.child("trade-journal"));

// QF-207 / QF-208: persist every Order transition + Fill to DuckDB.
import { createAuditOrderWriter } from "./order/audit-orders.js";
import { createAuditFillWriter } from "./order/audit-fills.js";
const auditOrderWriter = createAuditOrderWriter(db, logger.child("audit-orders"));
const auditFillWriter = createAuditFillWriter(db, logger.child("audit-fills"));

// QF-215: Trade Inspector — read-only join across the five audit tables.
import { createTradeInspector, TradeInspectorNotFoundError } from "./order/trade-inspector.js";
const tradeInspector = createTradeInspector(db, logger.child("trade-inspector"));

// QF-217: OrderPlane Prometheus metrics surface. Counters + lifecycle
// histogram. Isolated Registry — exposed for the eventual /metrics
// aggregator handler.
import { createOrderPlaneMetrics } from "./order/metrics.js";
const orderPlaneMetrics = createOrderPlaneMetrics();

// QF-242 — active-broker selection. brokers.json controls whether the
// NT-bridge (QF-237) services Schwab submits, or paper stays as the
// active broker. Defaults to paper. Enabling Schwab requires NATS up
// + the Python bridge running on the credential host (refuses to
// start otherwise — the bridge.available() probe + the explicit
// natsConn check below catch a misconfigured deploy).
const brokersConfig = loadBrokersConfig(resolve(ROOT_DIR, "config"), logger.child("brokers"));
// QF-243 — multi-account schema. v1 wires a single Schwab adapter from
// the first enabled account; per-portfolio account routing is M12-3+.
const schwabAccount = brokersConfig.schwab.accounts.find((a) => a.enabled);

let activeBroker = paperAdapter;
if (schwabAccount) {
  if (natsConn === null || natsConn.isClosed()) {
    logger.error("brokers.schwab.enabled=true but NATS is not connected; refusing to start", {
      nats_url: NATS_URL,
    });
    process.exit(1);
  }
  const schwabAdapter = createNtBridgeAdapter(
    natsConn,
    {
      broker: "schwab",
      ...(schwabAccount.submit_timeout_ms !== undefined
        ? { submitTimeoutMs: schwabAccount.submit_timeout_ms }
        : {}),
      ...(schwabAccount.query_timeout_ms !== undefined
        ? { queryTimeoutMs: schwabAccount.query_timeout_ms }
        : {}),
    },
    logger.child("nt-bridge-schwab"),
  );
  const schwabAvailable = await schwabAdapter.available();
  if (!schwabAvailable) {
    logger.error(
      "brokers.schwab.enabled=true but the NT bridge isn't available; refusing to start",
      { broker: "schwab" },
    );
    process.exit(1);
  }
  logger.info("Schwab NT-bridge wired as active broker", { broker: "schwab" });
  activeBroker = schwabAdapter;
}

// ── QF-319 — audit observer consumer ──────────────────────────────────
// Subscribes to orders.exec_reports.<broker> alongside the bridge and
// writes nt-native audit rows for chains OPL doesn't own. Required for
// the gate-evaluator's pending_intents log (QF-316) and the drift
// detector (QF-306) to see the full execution trail.
// Wired per enabled broker. Paper-only deploys have no Python bridge
// pushing exec_reports, so we only attach when NATS is up.
const lookupQfOrderId = async (brokerOrderId: string): Promise<string | null> =>
  new Promise((resolve, reject) => {
    // duckdb callback is typed as Callback<TableData>; cast to access order_id field
    db.all(
      "SELECT order_id FROM audit_orders WHERE broker_order_id = ? LIMIT 1",
      brokerOrderId,
      (err: unknown, rows: unknown) => {
        if (err) return reject(err);
        const typedRows = rows as Array<{ order_id: string }>;
        if (typedRows.length === 0) return resolve(null);
        const row = typedRows[0];
        return resolve(row ? row.order_id : null);
      },
    );
  });
// Forward-compat: brokersConfig currently only types `schwab`; ibkr is
// a planned future broker. Access it through the index signature below.
const brokersConfigExtra = brokersConfig as unknown as Record<string, { enabled?: boolean }>;
if (natsConn !== null && !natsConn.isClosed()) {
  if (schwabAccount) {
    createNtObserverConsumer({
      nc: natsConn,
      config: { broker: "schwab" },
      logger: logger.child("nt-observer-schwab"),
      lookupQfOrderId,
      auditOrderWriter,
      auditFillWriter,
    });
    logger.info("audit observer wired", { broker: "schwab" });
  }
  if (brokersConfigExtra["ibkr"]?.enabled) {
    createNtObserverConsumer({
      nc: natsConn,
      config: { broker: "ibkr" },
      logger: logger.child("nt-observer-ibkr"),
      lookupQfOrderId,
      auditOrderWriter,
      auditFillWriter,
    });
    logger.info("audit observer wired", { broker: "ibkr" });
  }
}

// ── QF-315 — gate-evaluator RPC handler ──────────────────────────────
// Subscribes to orders.gate.<broker> for each enabled broker and replies
// with approve/reject. v1 evaluator delegates to PortfolioEngine.
// canExecute(); QF-317 will replace with the cross-strategy aggregate
// evaluator. Audit_intents write is fire-and-forget per §3.4.
const gateAuditIntentWriter = createAuditIntentWriter(db, logger.child("audit-intents-gate"));
const gateEvaluator = createDefaultEvaluator(portfolioEngine);
if (natsConn !== null && !natsConn.isClosed()) {
  if (schwabAccount) {
    createGateHandler({
      nc: natsConn,
      config: { broker: "schwab" },
      logger: logger.child("gate-handler-schwab"),
      evaluator: gateEvaluator,
      auditIntentWriter: gateAuditIntentWriter,
      generateIntentId: () => ulid(),
    });
    logger.info("gate handler wired", { broker: "schwab" });
  }
  if (brokersConfigExtra["ibkr"]?.enabled) {
    createGateHandler({
      nc: natsConn,
      config: { broker: "ibkr" },
      logger: logger.child("gate-handler-ibkr"),
      evaluator: gateEvaluator,
      auditIntentWriter: gateAuditIntentWriter,
      generateIntentId: () => ulid(),
    });
    logger.info("gate handler wired", { broker: "ibkr" });
  }
}

const orderPlane = createOrderPlane({
  portfolioEngine,
  broker: activeBroker,
  fillLog,
  logger: logger.child("order"),
  generateId: () => ulid(),
  mode: effectiveMode,
  tradeJournal,
  auditOrderWriter,
  auditFillWriter,
  metrics: orderPlaneMetrics,
});

// ── QF-351 — Exit-Rule Monitor ──────────────────────────────────────────
// Wires the framework-side hard-exit enforcer (QF-321) into the production
// boot path. The monitor evaluates per-strategy exit policies on every
// position update and emits closing intents through OPL when a rule trips.
//
// getPolicy always returns undefined for now — no config/strategies/ policy
// source exists yet. The monitor wires up fully but stays DORMANT until
// per-strategy StrategyExitPolicy config is added (planned follow-up).
// This matches QF-321's dormant-until-configured design.
exitRuleMonitor = createExitRuleMonitor({
  logger: logger.child("exit-rule-monitor"),
  metrics: createExitRuleMetrics(),
  newIntentId: () => ulid(),
  submitClosingIntent: (intent) => orderPlane.submit(intent).then(() => {}),
  getPolicy: () => undefined,
  onTripEvent: (data) => {
    stateWs?.pushPositionExitRule(data);
  },
  onTripAlert: (strategyId, rule) => {
    void alertRouter.record({
      type: "exit_rule_tripped",
      level: "warning",
      message: `Exit rule tripped: ${rule} for strategy ${strategyId}`,
      payload: { strategy_id: strategyId, rule },
    });
  },
  onEvalComplete: (strategyId, evals) => {
    // Push strategy_update with per-rule headroom so the GUI strategies
    // panel can render live exit_rules[] status (QF-322).
    const strategy = strategyStore.get(strategyId);
    if (!strategy) return;
    const exit_rules: ExitRuleHeadroom[] = evals.map((ev) => ({
      rule: ev.rule,
      threshold: ev.threshold,
      actual: ev.actual,
      headroom_pct: ev.headroom_pct,
    }));
    stateWs?.pushStrategyUpdate({ ...strategy, exit_rules });
  },
});
logger.info("Exit-rule monitor wired (dormant until per-strategy policies are configured)");

// QF-323 — operator manual-liquidation deps. Resolves a position_id
// against the framework projector (portfolio engine), then submits a
// closing intent through the same OPL path the exit-rule monitor uses.
const liquidationDeps: LiquidationDeps = {
  resolvePosition: (positionId: string) => {
    for (const pid of Object.keys(portfolioConfigs)) {
      const pos = portfolioEngine.getState(pid).positions.find((p) => p.position_id === positionId);
      if (pos) {
        return {
          position_id: pos.position_id,
          portfolio: pid,
          symbol: pos.symbol,
          direction: pos.direction,
          quantity: pos.quantity,
          strategy_id: pos.strategy_id,
          composite_id: pos.composite_id ?? null,
        };
      }
    }
    return null;
  },
  submit: (intent) => orderPlane.submit(intent),
  newId: () => ulid(),
  now: () => new Date().toISOString(),
  logger: logger.child("liquidation"),
};

// ── 9c. Write-job dispatch (M10-1 — server-mediated MinIO writes) ──────

const writeJobsModule = await initWriteJobs({
  db,
  logger: logger.child("write-jobs"),
});

// ── 10. Model Runner ──────────────────────────────────────────────────────

import { createMarketDataService } from "./market-data/service.js";
import { createAdapter as createMdAdapter } from "./market-data/adapters/marketdata.js";
import {
  createAdapter as createSchwabAdapter,
  getTokenStatus as getSchwabTokenStatus,
} from "./market-data/adapters/schwab.js";
import { getSecretsStatus } from "./auth/secrets-status.js";
import { getFundamentalsStatus } from "./fundamentals/status.js";
import { createAdapter as createIbkrAdapter } from "./market-data/adapters/ibkr.js";
import { createAdapter as createDatabentoAdapter } from "./market-data/adapters/databento.js";
import { createNtBridgeMdAdapter } from "./market-data/adapters/nt-bridge-md.js";
import { parseNtBridgeMdConfig } from "./market-data/nt-bridge-md-config.js";
import { createMetricsRegistry } from "./market-data/metrics.js";
// QF-221: book-budget allocator + priority comparator + L2 subscription
// manager. Per QF-28 / QF-205 / QF-204, these compose to cap per-source
// L2 streams and prefer subscribing to symbols backed by working orders.
import {
  createBookBudgetMetrics,
  createBookBudgetAllocator,
  WorkingOrderPriorityComparator,
} from "./market-data/book-budget.js";
import { createSubscriptionManager } from "./market-data/subscriptions.js";

let modelMarketData: MarketDataService | null = null;
// Priority order: Databento (live, low-latency) → IBKR (broker) → Schwab → MarketData.
// Databento available() flips to false if the Python sidecar isn't
// publishing heartbeats; falls through cleanly. IBKR is the broker-of-truth
// fallback. Schwab and MarketData remain for non-futures coverage.
const schwabAdapter = createSchwabAdapter();
const databentoAdapter = createDatabentoAdapter({ nc: natsConn ?? undefined });
const legacyMdAdapters = [databentoAdapter, createIbkrAdapter(), schwabAdapter, createMdAdapter()];

// ── M13-07: nt-bridge-md adapter composition ─────────────────────────
// Per docs/tdd/broker-integration.md §6. The nt_bridge block in
// config/market-data.json gates the conditional wiring; enabled=false
// keeps behavior identical to pre-M13. Modes:
//   observe — append nt-bridge at lowest priority (legacy owns prod)
//   first   — prepend nt-bridge (NT canonical, legacy fallback)
//   only    — replace legacy entirely
// Operator changes mode by editing the block + restarting the server.
let mdAdapterList = legacyMdAdapters;
let ntBridgeMdConfig: NtBridgeMdConfig = { enabled: false, brokers: [], mode: "observe" };
try {
  const mdConfigRaw = JSON.parse(
    readFileSync(resolve(ROOT_DIR, "config/market-data.json"), "utf-8"),
  ) as Record<string, unknown>;
  ntBridgeMdConfig = parseNtBridgeMdConfig(
    mdConfigRaw["nt_bridge"],
    logger.child("nt-bridge-md-config"),
  );
} catch (e) {
  logger.warn("nt-bridge-md: config block missing or unparseable; defaults applied", {
    error: String(e instanceof Error ? e.message : e),
  });
}
if (ntBridgeMdConfig.enabled) {
  if (!natsConn) {
    logger.error("nt_bridge.enabled=true but NATS connection unavailable; refusing to start", {
      brokers: ntBridgeMdConfig.brokers,
    });
    process.exit(1);
  }
  const ntAdapters = [];
  for (const broker of ntBridgeMdConfig.brokers) {
    const t = ntBridgeMdConfig.timeouts ?? {};
    const adapter = createNtBridgeMdAdapter(
      natsConn,
      {
        broker,
        ...(t.quote_ms !== undefined ? { quoteTimeoutMs: t.quote_ms } : {}),
        ...(t.expirations_ms !== undefined ? { expirationsTimeoutMs: t.expirations_ms } : {}),
        ...(t.chain_ms !== undefined ? { chainTimeoutMs: t.chain_ms } : {}),
        ...(t.historical_chain_ms !== undefined
          ? { historicalChainTimeoutMs: t.historical_chain_ms }
          : {}),
        ...(t.candles_ms !== undefined ? { candlesTimeoutMs: t.candles_ms } : {}),
        ...(ntBridgeMdConfig.heartbeat_stale_ms !== undefined
          ? { heartbeatStaleMs: ntBridgeMdConfig.heartbeat_stale_ms }
          : {}),
      },
      logger.child(`nt-bridge-md-${broker}`),
    );
    ntAdapters.push(adapter);
  }
  switch (ntBridgeMdConfig.mode) {
    case "observe":
      mdAdapterList = [...legacyMdAdapters, ...ntAdapters];
      break;
    case "first":
      mdAdapterList = [...ntAdapters, ...legacyMdAdapters];
      break;
    case "only":
      mdAdapterList = ntAdapters;
      break;
  }
  logger.info("nt-bridge-md adapters wired", {
    brokers: ntBridgeMdConfig.brokers,
    mode: ntBridgeMdConfig.mode,
    adapter_names: mdAdapterList.map((a) => a.name),
  });
}

// QF-55: single shared metrics registry. Service wraps adapters with it
// at factory time; api factory consumes it via /api/data/sources/health.
const mdMetrics = createMetricsRegistry();

// QF-221: book-budget allocator + L2 subscription manager. Construct
// regardless of whether any production caller subscribes to L2 today —
// this is the "wiring lights up" step so the QF-28 / QF-204 / QF-205
// work isn't dormant. Caps come from config/market-data.json's
// `book_budget` map. `getBookCandidate` returns null permanently now
// that the working-order monitor (its former late-bind source) is
// retired (QF-339), so the comparator's L2 preemption path is disabled.
let mdConfigBookBudget: Record<string, number> = {};
let mdConfigSubscription: { poll_interval_ms: number } = { poll_interval_ms: 5000 };
try {
  const mdConfigRaw = JSON.parse(
    readFileSync(resolve(ROOT_DIR, "config/market-data.json"), "utf-8"),
  ) as Record<string, unknown>;
  mdConfigBookBudget = (mdConfigRaw["book_budget"] as Record<string, number> | undefined) ?? {};
  mdConfigSubscription =
    (mdConfigRaw["subscription"] as { poll_interval_ms: number } | undefined) ??
    mdConfigSubscription;
} catch (e) {
  logger.warn("book-budget: market-data.json config missing or unparseable; defaults applied", {
    error: String(e instanceof Error ? e.message : e),
  });
}
const bookBudgetMetrics = createBookBudgetMetrics();
const bookBudgetAllocator = createBookBudgetAllocator({
  config: { limits: mdConfigBookBudget },
  metrics: bookBudgetMetrics,
  comparator: WorkingOrderPriorityComparator,
});
import type { BookCandidate } from "./market-data/book-budget.js";
let getBookCandidateImpl: (symbol: string) => BookCandidate | null = (_symbol: string) => null;
const bookSubscriptionManager = createSubscriptionManager(
  mdAdapterList,
  // The subscription manager wants a Cache; the existing market-data
  // service builds its own. They're separate caches (subscriptions are
  // stream-driven; the service cache is request-driven). Pass an empty
  // Cache-shaped object — the manager's L2 path doesn't write to it.
  {
    get: () => undefined,
    set: () => {},
    invalidate: () => {},
    stats: () => ({ hits: 0, misses: 0, entries: 0 }),
    clear: () => {},
  },
  mdConfigSubscription,
  logger.child("book-subs"),
  {
    bookBudget: bookBudgetAllocator,
    bookBudgetComparator: WorkingOrderPriorityComparator,
    getBookCandidate: (symbol) => getBookCandidateImpl(symbol),
    // QF-222 — metrics handle so the re-evaluation loop's reclaim
    // counter fires. Safe to thread even if the loop is disabled
    // (default cadence is 60s; the counter just never increments).
    bookBudgetMetrics,
  },
);
logger.info("book-budget allocator constructed", {
  limits: mdConfigBookBudget,
  adapters: mdAdapterList.map((a) => a.name).join(","),
});

try {
  modelMarketData = createMarketDataService({
    adapters: mdAdapterList,
    logger: logger.child("model-md"),
    metrics: mdMetrics,
  });

  // Schwab auth check — run async, don't block startup. If credentials are
  // present but auth fails, log a prominent warning so we find out at boot
  // rather than only when a signal fires.
  const schwabKey = process.env.SCHWAB_APP_KEY;
  const schwabRefresh = process.env.SCHWAB_REFRESH_TOKEN;
  if (schwabKey && schwabRefresh) {
    schwabAdapter
      .available()
      .then((ok) => {
        if (ok) {
          logger.info("schwab auth ok — adapter ready");
        } else {
          logger.warn(
            "schwab refresh token appears expired — run `npm run schwab-auth` to re-authorize. Until then Schwab calls fall through to other adapters.",
          );
        }
      })
      .catch((e) => {
        logger.warn("schwab auth probe threw", { error: String(e.message ?? e) });
      });
  } else {
    logger.info("schwab credentials not set — adapter will skip (chain falls through to IBKR/MD)");
  }
} catch (e) {
  logger.warn("Model runner not initialized", {
    error: String(e instanceof Error ? e.message : e),
  });
}

// ── 11b. Market Data HTTP API ──────────────────────────────────────────

import { createMarketDataApi } from "./market-data/api.js";

let marketDataApi: ReturnType<typeof createMarketDataApi> | null = null;
if (modelMarketData) {
  marketDataApi = createMarketDataApi({
    service: modelMarketData,
    adapters: mdAdapterList,
    logger: logger.child("market-data-api"),
    metrics: mdMetrics,
  });
}

// QF-58: data exports (Settings → Activity → Exports). One handler per
// HTTP request; the DuckDB results materialise in memory before write
// so exports are bounded by available RAM. Date-range filters keep
// realistic exports comfortably under that ceiling.
const exportsApi = createExportsApi({ db, logger: logger.child("exports") });

// QF-348 — browser telemetry log forwarder. Browser events arrive as a
// JSON array; they are validated, threaded with the browser-supplied
// correlation_id (or a generated one), and written to the central log
// stream alongside server-side logs.
const telemetryHandler = createTelemetryHandler({
  logger: logger.child("browser-telemetry"),
  extractBearer: (req) => {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return null;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = m?.[1]?.trim();
    return token && token.length > 0 ? token : null;
  },
});

// QF-60: per-portfolio halt audit. PortfolioEngine already owns the
// runtime halt state (state.halted + state.halt_reason); this store
// adds the audit history + an HTTP surface.
const haltsStore = createHaltsStore({
  db,
  logger: logger.child("halts"),
  portfolioEngine,
});
try {
  await haltsStore.init();
} catch (e) {
  logger.warn("Halts audit init failed", {
    error: e instanceof Error ? e.message : String(e),
  });
}

// QF-61: alert router (Settings → Activity → Alerts). Producers call
// `alertRouter.record(event)`; rules in config/alerts.yaml decide
// which channels each event fans out to. Internal channel goes
// through the existing stateWs.pushAlert helper (wired below once
// stateWs is constructed); slack channel hits the configured webhook.
const alertRouter = createAlertRouter({
  yamlPath: resolve(ROOT_DIR, "config/alerts.yaml"),
  logger: logger.child("alerts"),
  slackWebhookUrl: () => process.env.SLACK_WEBHOOK_URL,
});
try {
  await alertRouter.load();
} catch (e) {
  logger.warn("Alerts config load failed", {
    error: e instanceof Error ? e.message : String(e),
  });
}
// QF-295: wire alertRouter into the write-job runner now that the router
// is ready (runner init precedes router creation in the boot sequence).
writeJobsModule.runner.setAlertRouter(alertRouter);

// ── 11c. Freshness Monitor (QF-295) ────────────────────────────────────
// Periodic tick (~5 min) that calls computeFreshness() and fires
// ingest.stale.<source> / ingest.recovered.<source> via alertRouter.
// dataPlaneCfg is already loaded above (step 5a-i).

const freshnessMonitor = createFreshnessMonitor({
  db,
  config: dataPlaneCfg,
  alertRouter,
  logger: logger.child("freshness-monitor"),
});
freshnessMonitor.start();
logger.info("Freshness monitor started");

// ── 11d. Restart recovery ──────────────────────────────────────────────

import { rehydrateOrderPlane, reconcileOrdersWithBroker } from "./order/restart-recovery.js";

// QF-214 — rebuild the OrderPlane's in-memory book from audit_orders
// BEFORE accepting new orders. Without this, restart
// mid-trading-day loses every in-flight order. Idempotent + safe when
// audit_orders is empty (returns stats with all zeros).
try {
  const stats = await rehydrateOrderPlane(orderPlane, db, logger.child("restart-recovery"));
  if (stats.orders_loaded > 0) {
    logger.warn(
      "Active orders re-hydrated from audit_orders",
      stats as unknown as Record<string, unknown>,
    );
  }
} catch (e) {
  logger.error("Restart recovery (OrderPlane) failed", {
    error: String(e instanceof Error ? e.message : e),
  });
}

// QF-230 — after rehydrating in-memory state, ask the broker what
// actually happened to each open order while QF was down. Synthesizes
// the missing fill / cancel / rejection transitions. Best-effort:
// reconciliation failures don't block startup.
try {
  const reconStats = await reconcileOrdersWithBroker(
    orderPlane,
    paperAdapter,
    logger.child("restart-recovery"),
    alertRouter,
  );
  if (reconStats.checked > 0) {
    logger.warn(
      "Broker reconciliation walk complete",
      reconStats as unknown as Record<string, unknown>,
    );
  }
} catch (e) {
  logger.error("Restart recovery (broker reconciliation) failed", {
    error: String(e instanceof Error ? e.message : e),
  });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

// ── HTTP helpers ─────────────────────────────────────────────────────────

// Route object returned by matchRoute. handler is always present;
// id/symbol/date/expiration are populated per-route.
interface Route {
  handler: string;
  id?: string;
  symbol?: string;
  date?: string;
  expiration?: string | null;
  action?: string;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as unknown);
      } catch {
        resolve({});
      }
    });
  });
}

// ── Route matching ───────────────────────────────────────────────────────

function matchRoute(method: string | undefined, pathname: string): Route | null {
  let m: RegExpMatchArray | null;

  // Prometheus metrics (QF-276)
  if (pathname === "/metrics" && method === "GET") return { handler: "metrics" };

  // Status
  if (pathname === "/api/status") return { handler: "status" };

  // Secrets audit (QF-56) — never returns secret values, only set/expiry/path/instructions.
  if (pathname === "/api/secrets/status" && method === "GET") return { handler: "secretsStatus" };

  // Fundamentals data-lake status (QF-63) — per-parquet existence, row count, freshness.
  if (pathname === "/api/fundamentals/status" && method === "GET")
    return { handler: "fundamentalsStatus" };

  // Live data
  m = pathname.match(/^\/api\/quote\/(.+)$/);
  if (m && method === "GET") return { handler: "quote", symbol: decodeURIComponent(m[1]!) };

  m = pathname.match(/^\/api\/futures-months\/(.+)$/);
  if (m && method === "GET") return { handler: "futuresMonths", symbol: decodeURIComponent(m[1]!) };

  m = pathname.match(/^\/api\/expirations\/(.+)$/);
  if (m && method === "GET") return { handler: "expirations", symbol: decodeURIComponent(m[1]!) };

  m = pathname.match(/^\/api\/chain\/([^/]+)\/([^/?]+)/);
  if (m && method === "GET")
    return {
      handler: "chain",
      symbol: decodeURIComponent(m[1]!),
      expiration: decodeURIComponent(m[2]!),
    };

  // Stored data
  m = pathname.match(/^\/api\/data\/dates\/(.+)$/);
  if (m && method === "GET") return { handler: "dates", symbol: decodeURIComponent(m[1]!) };

  m = pathname.match(/^\/api\/data\/chain\/([^/]+)\/([^/]+)(?:\/([^/?]+))?/);
  if (m && method === "GET")
    return {
      handler: "storedChain",
      symbol: decodeURIComponent(m[1]!),
      date: decodeURIComponent(m[2]!),
      expiration: m[3] ? decodeURIComponent(m[3]) : null,
    };

  // Data summary
  if (pathname === "/api/data/summary" && method === "GET") return { handler: "dataSummary" };
  m = pathname.match(/^\/api\/data\/detail\/(.+)$/);
  if (m && method === "GET") return { handler: "dataDetail", symbol: decodeURIComponent(m[1]!) };

  // Data loading
  if (pathname === "/api/load" && method === "POST") return { handler: "startLoad" };
  if (pathname === "/api/load/status" && method === "GET") return { handler: "loadStatus" };
  if (pathname === "/api/load/cancel" && method === "POST") return { handler: "cancelLoad" };

  // Source status
  if (pathname === "/api/sources") return { handler: "sources" };

  // ── Trading system routes ─────────────────────────────────────────────

  // Unified data catalog (all dataset kinds)
  if (pathname === "/api/catalog" && method === "GET") return { handler: "catalog" };
  // Per-source data freshness derived view (QF-293)
  if (pathname === "/api/catalog/freshness" && method === "GET")
    return { handler: "catalogFreshness" };
  // Per-run drill-down for qo-run descriptors (quant-optimizer wfo results).
  m = pathname.match(/^\/api\/qo-run\/(.+)$/);
  if (m && method === "GET") return { handler: "qoRun", id: decodeURIComponent(m[1]!) };

  // Cross-source download / ingest run history
  if (pathname === "/api/downloads/runs" && method === "GET") return { handler: "downloadsRuns" };
  if (pathname.startsWith("/api/downloads/runs/") && method === "GET")
    return { handler: "downloadsRun" };

  // Positions & accounts (Schwab)
  if (pathname === "/api/positions" && method === "GET") return { handler: "positions" };
  // QF-323 — operator manual liquidation. Exact multi-select route is
  // checked before the :id route (the latter requires a trailing
  // /liquidate, so they can't collide, but order keeps intent clear).
  if (pathname === "/api/positions/liquidate" && method === "POST")
    return { handler: "positionsLiquidate" };
  m = pathname.match(/^\/api\/positions\/([^/]+)\/liquidate$/);
  if (m && method === "POST")
    return { handler: "positionLiquidate", id: decodeURIComponent(m[1]!) };
  if (pathname === "/api/accounts" && method === "GET") return { handler: "accounts" };

  // Market data (unified Schwab/IBKR/MD fallback chain)
  if (pathname === "/api/market-data/status" && method === "GET") return { handler: "mdStatus" };
  // QF-55 — per-adapter health (lag, error rate, last error, fallback events, rate-limit credits).
  if (pathname === "/api/data/sources/health" && method === "GET") return { handler: "mdHealth" };
  // QF-296 — post-rewrite bridge-heartbeat topology (per-broker alive + RPC stats).
  if (pathname === "/api/marketdata/bridges" && method === "GET") return { handler: "mdBridges" };
  if (pathname === "/api/market-data/quote" && method === "GET") return { handler: "mdQuote" };
  if (pathname === "/api/market-data/expirations" && method === "GET")
    return { handler: "mdExpirations" };
  if (pathname === "/api/market-data/chain" && method === "GET") return { handler: "mdChain" };
  if (pathname === "/api/market-data/candles" && method === "GET") return { handler: "mdCandles" };
  // Portfolio
  m = pathname.match(/^\/api\/portfolio\/([^/]+)\/snapshots$/);
  if (m && method === "GET")
    return { handler: "portfolioSnapshots", id: decodeURIComponent(m[1]!) };
  m = pathname.match(/^\/api\/portfolio\/([^/]+)$/);
  if (m && method === "GET") return { handler: "portfolio", id: decodeURIComponent(m[1]!) };

  // System
  if (pathname === "/api/system/kill" && method === "POST") return { handler: "systemKill" };
  if (pathname === "/api/system/reset" && method === "POST") return { handler: "systemReset" };
  if (pathname === "/api/system/status" && method === "GET") return { handler: "systemStatus" };

  // Orders
  m = pathname.match(/^\/api\/orders\/([^/]+)\/(approve|reject|cancel)$/);
  if (m && method === "POST")
    return {
      handler: `order${m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1)}`,
      id: decodeURIComponent(m[1]!),
    };
  if (pathname === "/api/orders" && method === "GET") return { handler: "listOrders" };

  // Trade Inspector
  if (pathname === "/api/trades/journal" && method === "GET") return { handler: "tradeJournal" };
  if (pathname.startsWith("/api/trades/inspect") && method === "GET")
    return { handler: "tradeInspect" };

  // Risk limits
  if (pathname === "/api/risk/limits" && method === "GET") return { handler: "riskLimitsGet" };
  m = pathname.match(/^\/api\/risk\/limits\/([^/]+)$/);
  if (m && method === "PUT") return { handler: "riskLimitsSet", id: decodeURIComponent(m[1]!) };

  // QF-61: alerts router (Settings → Activity → Alerts).
  if (pathname === "/api/alerts/rules" && method === "GET") return { handler: "alertsRulesGet" };
  if (pathname === "/api/alerts/rules" && method === "PUT") return { handler: "alertsRulesSet" };
  if (pathname === "/api/alerts/recent" && method === "GET") return { handler: "alertsRecent" };
  if (pathname === "/api/alerts/test" && method === "POST") return { handler: "alertsTest" };

  // QF-60: per-portfolio halt + reset audit (Settings → Risk → Emergency).
  if (pathname === "/api/halts/history" && method === "GET") return { handler: "haltsHistory" };
  m = pathname.match(/^\/api\/portfolio\/([^/]+)\/halt$/);
  if (m && method === "POST") return { handler: "portfolioHalt", id: decodeURIComponent(m[1]!) };
  m = pathname.match(/^\/api\/portfolio\/([^/]+)\/reset$/);
  if (m && method === "POST") return { handler: "portfolioReset", id: decodeURIComponent(m[1]!) };

  // QF-58: data exports.
  if (pathname === "/api/exports" && method === "GET") return { handler: "exportsList" };
  m = pathname.match(/^\/api\/exports\/([A-Za-z0-9_-]+)$/);
  if (m && method === "GET") return { handler: "exportsDownload", id: decodeURIComponent(m[1]!) };

  // QF-57: named risk-policy presets (CRUD + apply-to-portfolio).
  if (pathname === "/api/risk/policies" && method === "GET") return { handler: "riskPoliciesList" };
  m = pathname.match(/^\/api\/risk\/policies\/([A-Za-z0-9_-]+)\/apply$/);
  if (m && method === "POST")
    return { handler: "riskPoliciesApply", id: decodeURIComponent(m[1]!) };
  m = pathname.match(/^\/api\/risk\/policies\/([A-Za-z0-9_-]+)$/);
  if (m && method === "PUT")
    return { handler: "riskPoliciesUpsert", id: decodeURIComponent(m[1]!) };
  if (m && method === "DELETE")
    return { handler: "riskPoliciesDelete", id: decodeURIComponent(m[1]!) };

  // QF-54: model quality thresholds (per-model + defaults).
  if (pathname === "/api/quality_thresholds" && method === "GET")
    return { handler: "qualityThresholdsGet" };
  m = pathname.match(/^\/api\/models\/([^/]+)\/quality_thresholds$/);
  if (m && method === "GET")
    return { handler: "modelQualityThresholdsGet", id: decodeURIComponent(m[1]!) };
  if (m && method === "PUT")
    return { handler: "modelQualityThresholdsSet", id: decodeURIComponent(m[1]!) };

  // Strategy lifecycle
  if (pathname === "/api/strategies" && method === "GET") return { handler: "strategiesList" };
  if (pathname === "/api/strategies" && method === "POST") return { handler: "strategiesRegister" };
  m = pathname.match(/^\/api\/strategies\/([^/]+)\/transition$/);
  if (m && method === "POST")
    return { handler: "strategiesTransition", id: decodeURIComponent(m[1]!) };
  m = pathname.match(/^\/api\/strategies\/([^/]+)\/notes$/);
  if (m && method === "PUT") return { handler: "strategiesNotes", id: decodeURIComponent(m[1]!) };
  m = pathname.match(/^\/api\/strategies\/([^/]+)\/params_provenance$/);
  if (m && method === "PUT")
    return { handler: "strategiesParamsProvenance", id: decodeURIComponent(m[1]!) };
  // QF-59: strategy config (config/portfolios.json `strategies.<id>.config` slice).
  if (pathname === "/api/strategies/config" && method === "GET")
    return { handler: "strategiesConfigList" };
  m = pathname.match(/^\/api\/strategies\/([^/]+)\/config$/);
  if (m && method === "GET")
    return { handler: "strategiesConfigGet", id: decodeURIComponent(m[1]!) };
  if (m && method === "PUT")
    return { handler: "strategiesConfigPut", id: decodeURIComponent(m[1]!) };

  // QF-331: drift baseline pin (operator-only).
  m = pathname.match(/^\/api\/strategies\/([^/]+)\/drift-baseline$/);
  if (m && method === "PUT")
    return { handler: "strategiesDriftBaselinePin", id: decodeURIComponent(m[1]!) };

  // Write-job dispatch (M10-1)
  m = pathname.match(/^\/api\/write-jobs\/([A-Za-z0-9-]+)$/);
  if (m && method === "GET") return { handler: "writeJobsStatus", id: decodeURIComponent(m[1]!) };
  if (pathname === "/api/write-jobs" && method === "POST") return { handler: "writeJobsSubmit" };
  if (pathname === "/api/write-jobs" && method === "GET") return { handler: "writeJobsList" };

  // Store
  if (pathname === "/api/store/summary" && method === "GET") return { handler: "storeSummary" };

  // Trade Inspector (QF-215) — chase the audit chain for a given fill.
  m = pathname.match(/^\/api\/trades\/inspect$/);
  if (m && method === "GET") return { handler: "tradeInspect" };

  // QF-348 — browser-side telemetry log stream.
  if (pathname === "/api/telemetry" && method === "POST") return { handler: "telemetry" };

  return null;
}

// ── Prometheus metrics (QF-276) ──────────────────────────────────────────

const metricsRegister = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegister, prefix: "qf_" });

// Application-level custom metrics
const httpRequestDuration = new promClient.Histogram({
  name: "qf_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegister],
});
const httpRequestTotal = new promClient.Counter({
  name: "qf_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegister],
});

// ── Request handler ──────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const startTime = process.hrtime.bigint();

  if (req.method === "OPTIONS") {
    json(res, 204, null);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const route = matchRoute(req.method, url.pathname);
  if (!route) {
    json(res, 404, { error: "Not found" });
    return;
  }

  try {
    let result;
    switch (route.handler) {
      case "metrics":
        res.writeHead(200, {
          "Content-Type": promClient.register.contentType,
          "Access-Control-Allow-Origin": "*",
        });
        res.end(await metricsRegister.metrics());
        return;

      case "status":
        result = {
          ok: true,
          sources: dataSources.getSourceStatus(),
          load: getLoadStatus(),
        };
        break;

      case "secretsStatus":
        result = getSecretsStatus();
        break;

      case "fundamentalsStatus":
        result = await getFundamentalsStatus(logger.child("fundamentals"));
        break;

      case "futuresMonths": {
        // List available futures contract months by batch-quoting candidates
        const root = route
          .symbol!.replace(/^\//, "")
          .replace(/[FGHJKMNQUVXZ]\d{2}$/i, "")
          .toUpperCase();
        const MONTH_CODES = "FGHJKMNQUVXZ";
        const now = new Date();
        const candidates: Array<{ symbol: string; code: string; month: string }> = [];
        for (let offset = 0; offset < 18; offset++) {
          const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
          const monthIdx = d.getMonth();
          const yearSuffix = String(d.getFullYear()).slice(2);
          const code = MONTH_CODES[monthIdx] ?? "";
          candidates.push({
            symbol: `/${root}${code}${yearSuffix}`,
            code: `${code}${yearSuffix}`,
            month: d.toISOString().slice(0, 7),
          });
        }
        // Batch-quote to see which are active
        const months = [];
        if (modelMarketData) {
          for (const c of candidates) {
            try {
              const q = await modelMarketData.getQuote(c.symbol);
              if (q && q.last > 0) {
                months.push({
                  symbol: c.symbol,
                  code: c.code,
                  month: c.month,
                  last: q.last,
                  bid: q.bid,
                  ask: q.ask,
                });
              }
            } catch {
              /* not active */
            }
          }
        }
        result = months;
        break;
      }

      case "quote":
        // Use unified market data service (proper adapter routing for futures/indices)
        if (modelMarketData) {
          result = await modelMarketData.getQuote(route.symbol!);
        } else {
          result = await dataSources.stockQuote(route.symbol!);
        }
        break;

      case "expirations":
        if (modelMarketData) {
          result = await modelMarketData.getExpirations(route.symbol!);
        } else {
          result = await dataSources.expirations(route.symbol!);
        }
        break;

      case "chain": {
        const strikeLimit = parseInt(url.searchParams.get("strikeLimit") || "30", 10);
        let contracts;
        if (modelMarketData) {
          contracts = await modelMarketData.getChain(route.symbol!, route.expiration ?? "");
        } else {
          contracts = await dataSources.chain(route.symbol!, route.expiration ?? "", strikeLimit);
        }
        // Store to Parquet for future use (skip futures — different storage path)
        if (contracts?.length && !route.symbol!.startsWith("/")) {
          const today = new Date().toISOString().slice(0, 10);
          storage.storeChain(route.symbol!, today, contracts, "live").catch(() => {});
        }
        result = contracts;
        break;
      }

      case "dates":
        result = await storage.getDates(route.symbol!);
        break;

      case "storedChain":
        result = await storage.getChain(route.symbol!, route.date!, route.expiration ?? undefined);
        break;

      case "dataSummary":
        result = await storage.getSummary();
        break;

      case "dataDetail":
        result = await storage.getSymbolDetail(route.symbol!);
        break;

      case "startLoad": {
        const body = await readBody(req);
        const loadReq = body as { symbol?: string; from?: string; to?: string };
        if (!loadReq.symbol || !loadReq.from || !loadReq.to) {
          json(res, 400, { error: "Required: symbol, from, to" });
          return;
        }
        result = startLoad(storage, loadReq as { symbol: string; from: string; to: string });
        break;
      }

      case "loadStatus":
        result = getLoadStatus();
        break;

      case "cancelLoad":
        result = cancelLoad();
        break;

      case "sources":
        result = dataSources.getSourceStatus();
        break;

      // ── Trading system handlers ─────────────────────────────────────

      case "positions":
        if (marketDataApi) {
          await marketDataApi.handlePositions(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;

      // QF-323 — operator manual liquidation (order-execution.md §5.2).
      case "positionLiquidate": {
        const outcomes = await liquidatePositions(liquidationDeps, [route.id!]);
        result = { results: outcomes };
        break;
      }
      case "positionsLiquidate": {
        const body = await readBody(req);
        const liqBody = body as { position_ids?: unknown };
        const ids = Array.isArray(liqBody.position_ids) ? (liqBody.position_ids as string[]) : [];
        if (ids.length === 0) throw new Error("position_ids (non-empty array) is required");
        const outcomes = await liquidatePositions(liquidationDeps, ids);
        result = { results: outcomes };
        break;
      }
      case "accounts":
        if (marketDataApi) {
          await marketDataApi.handleAccounts(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;

      case "mdStatus":
        if (marketDataApi) {
          await marketDataApi.handleStatus(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;
      case "mdHealth":
        if (marketDataApi) {
          await marketDataApi.handleHealth(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;
      case "mdBridges":
        if (marketDataApi) {
          await marketDataApi.handleBridges(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;
      case "mdQuote":
        if (marketDataApi) {
          await marketDataApi.handleQuote(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;
      case "mdExpirations":
        if (marketDataApi) {
          await marketDataApi.handleExpirations(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;
      case "mdChain":
        if (marketDataApi) {
          await marketDataApi.handleChain(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;
      case "mdCandles":
        if (marketDataApi) {
          await marketDataApi.handleCandles(req, res);
          return;
        }
        json(res, 503, { error: "Market data service unavailable" });
        return;
      case "catalog":
        await catalogApi.handleCatalog(req, res);
        return;

      // QF-293: per-source data freshness derived view
      case "catalogFreshness": {
        const sources = await computeFreshness(db, dataPlaneCfg);
        result = { sources };
        break;
      }

      case "qoRun":
        await catalogApi.handleQoRun(req, res, route.id!);
        return;

      case "downloadsRuns":
        await downloadsApi.handleRuns(req, res);
        return;
      case "downloadsRun":
        await downloadsApi.handleRun(req, res);
        return;

      case "portfolio":
        try {
          result = portfolioEngine.getState(route.id!);
        } catch {
          json(res, 404, { error: "Portfolio not found" });
          return;
        }
        break;

      case "portfolioSnapshots": {
        const rows = await new Promise((resolve, reject) => {
          db.all(
            "SELECT * FROM portfolio_snapshots WHERE portfolio = ? ORDER BY snapshot_ts DESC LIMIT 500",
            route.id!,
            (err: Error | null, rows: unknown[]) => (err ? reject(err) : resolve(rows ?? [])),
          );
        });
        result = rows;
        break;
      }

      case "systemKill": {
        const body = await readBody(req);
        const killBody = body as { reason?: string };
        orderPlane.killSwitch(killBody.reason ?? "operator");
        for (const id of Object.keys(portfolioConfigs)) {
          portfolioEngine.halt(id, killBody.reason ?? "kill switch");
        }
        if (stateWs) stateWs.pushSystemHalt(killBody.reason ?? "kill switch");
        result = { ok: true, halted: true };
        break;
      }

      case "systemReset":
        orderPlane.resetKillSwitch();
        for (const id of Object.keys(portfolioConfigs)) {
          portfolioEngine.resetHalt(id);
        }
        result = { ok: true, halted: false };
        break;

      case "systemStatus":
        result = {
          app_env: APP_ENV,
          trading_mode: TRADING_MODE,
          execution_mode: portfolioConfigs[mainPortfolio]?.mode ?? "paper_local",
          halted: orderPlane.isHalted(),
          halt_reason: null,
          nats_connected: natsConn !== null && !natsConn.isClosed(),
          sources_available: dataSources
            .getSourceStatus()
            .filter((s) => s.available)
            .map((s) => s.key),
          schwab_token: getSchwabTokenStatus(),
        };
        break;

      case "listOrders":
        result = orderPlane.listOrders(url.searchParams.get("portfolio") ?? undefined);
        break;

      case "orderApprove": {
        // QF-50: body may include operator-edit fields (order_type,
        // limit_price, time_in_force, working_policy_id). Empty or
        // missing body = approve as recommended. Body parsing tolerates
        // both ({}) and no-body cases.
        let edits;
        try {
          const cl = Number(req.headers["content-length"] ?? "0");
          if (cl > 0) edits = await readBody(req);
        } catch {
          edits = undefined;
        }
        await orderPlane.approve(route.id!, edits as Record<string, unknown> | undefined);
        result = { ok: true };
        break;
      }

      case "orderReject":
        await orderPlane.reject(route.id!);
        result = { ok: true };
        break;

      case "orderCancel":
        await orderPlane.cancel(route.id!);
        result = { ok: true };
        break;

      case "riskLimitsGet":
        result = riskLimitsStore.get();
        break;

      case "riskLimitsSet": {
        const body = await readBody(req);
        if (!body || typeof body !== "object") {
          throw new Error("body required");
        }
        result = await riskLimitsStore.setPortfolio(route.id!, body as unknown as RiskLimits);
        break;
      }

      // ── QF-61: alerts router ─────────────────────────────────────────
      case "alertsRulesGet":
        result = alertRouter.get();
        break;

      case "alertsRulesSet": {
        const body = await readBody(req);
        const rulesBody = body as Record<string, unknown>;
        if (!body || typeof body !== "object" || !Array.isArray(rulesBody["rules"])) {
          throw new Error("body.rules array required");
        }
        result = await alertRouter.replace(
          rulesBody["rules"] as import("./alerts/router.js").AlertRule[],
        );
        break;
      }

      case "alertsRecent": {
        const url2 = new URL(req.url!, `http://${req.headers.host}`);
        const limit = url2.searchParams.get("limit");
        result = { events: alertRouter.recent(limit ? parseInt(limit, 10) : 50) };
        break;
      }

      case "alertsTest": {
        // Fire a synthetic alert through the router so operators can
        // verify rule + channel wiring without needing a real
        // producer. Payload echoes whatever the caller sent so the
        // test event is identifiable in recent + downstream channels.
        const body = await readBody(req);
        const testBody = (body ?? {}) as Record<string, unknown>;
        const event = await alertRouter.record({
          type: typeof testBody["type"] === "string" ? testBody["type"] : "test.synthetic",
          level:
            testBody["level"] === "critical" || testBody["level"] === "warning"
              ? (testBody["level"] as "critical" | "warning")
              : "info",
          message:
            typeof testBody["message"] === "string"
              ? testBody["message"]
              : "Synthetic alert fired from /api/alerts/test",
          payload:
            testBody["payload"] && typeof testBody["payload"] === "object"
              ? (testBody["payload"] as Record<string, unknown>)
              : undefined,
        });
        result = { event };
        break;
      }

      // ── QF-60: per-portfolio halt audit ──────────────────────────────
      case "haltsHistory": {
        const url2 = new URL(req.url!, `http://${req.headers.host}`);
        const limit = url2.searchParams.get("limit");
        result = {
          events: await haltsStore.history(limit ? parseInt(limit, 10) : 100),
        };
        break;
      }

      case "portfolioHalt": {
        const body = await readBody(req);
        const haltBody = body as Record<string, unknown>;
        if (!body || typeof body !== "object" || typeof haltBody["reason"] !== "string") {
          throw new Error("body.reason is required");
        }
        const haltEvent = await haltsStore.halt(
          route.id!,
          haltBody["reason"],
          haltBody["actor"] as string | undefined,
        );
        if (stateWs) stateWs.pushSystemHalt(`${route.id!}: ${haltEvent.reason}`);
        result = { event: haltEvent };
        break;
      }

      case "portfolioReset": {
        const body = await readBody(req);
        const resetBody = body as Record<string, unknown>;
        if (!body || typeof body !== "object" || typeof resetBody["reason"] !== "string") {
          throw new Error("body.reason is required");
        }
        const resetEvent = await haltsStore.reset(
          route.id!,
          resetBody["reason"],
          resetBody["actor"] as string | undefined,
        );
        result = { event: resetEvent };
        break;
      }

      // ── QF-58: exports ───────────────────────────────────────────────
      case "exportsList":
        exportsApi.handleList(req, res);
        return; // handler writes its own response

      case "exportsDownload":
        await exportsApi.handleExport(req, res, route.id!);
        return;

      // ── QF-57: risk policies ─────────────────────────────────────────
      case "riskPoliciesList":
        result = riskPoliciesStore.get();
        break;

      case "riskPoliciesUpsert": {
        const body = await readBody(req);
        if (!body || typeof body !== "object") throw new Error("body required");
        result = await riskPoliciesStore.upsert(
          route.id!,
          body as unknown as import("./risk/policies.js").RiskPolicy,
        );
        break;
      }

      case "riskPoliciesDelete":
        result = await riskPoliciesStore.remove(route.id!);
        break;

      case "riskPoliciesApply": {
        const body = await readBody(req);
        const applyBody = body as Record<string, unknown>;
        if (!body || typeof body !== "object" || typeof applyBody["portfolio_id"] !== "string") {
          throw new Error("body.portfolio_id is required");
        }
        result = await riskPoliciesStore.apply(route.id!, applyBody["portfolio_id"]);
        break;
      }

      // ── QF-54: model quality thresholds ──────────────────────────────
      case "qualityThresholdsGet":
        result = qualityThresholdsStore.get();
        break;

      case "modelQualityThresholdsGet":
        result = qualityThresholdsStore.effective(route.id!);
        break;

      case "modelQualityThresholdsSet": {
        const body = await readBody(req);
        if (!body || typeof body !== "object") {
          throw new Error("body required");
        }
        result = await qualityThresholdsStore.setModel(
          route.id!,
          body as unknown as import("./risk/quality_thresholds.js").ModelThresholds,
        );
        break;
      }

      case "strategiesList":
        result = strategyStore.list();
        break;

      case "strategiesRegister": {
        const body = await readBody(req);
        const regBody = body as Record<string, unknown>;
        if (!regBody["id"] || !regBody["label"]) {
          throw new Error("id and label are required");
        }
        result = await strategyStore.register(
          {
            id: String(regBody["id"]),
            label: String(regBody["label"]),
            manifest_revision: (regBody["manifest_revision"] as string | null | undefined) ?? null,
            operator_notes: (regBody["operator_notes"] as string | undefined) ?? "",
          },
          (regBody["actor"] as string | undefined) ?? "operator",
        );
        break;
      }

      case "strategiesTransition": {
        const body = await readBody(req);
        const transBody = body as Record<string, unknown>;
        if (!transBody["action"]) throw new Error("action is required");
        result = await strategyStore.transition(
          route.id!,
          String(transBody["action"]) as import("./strategy/lifecycle.js").LifecycleAction,
          (transBody["actor"] as string | undefined) ?? "operator",
          transBody["reason"] as string | undefined,
        );
        break;
      }

      case "strategiesNotes": {
        const body = await readBody(req);
        const notesBody = body as Record<string, unknown>;
        if (typeof notesBody["notes"] !== "string") throw new Error("notes (string) is required");
        result = await strategyStore.setNotes(route.id!, notesBody["notes"]);
        break;
      }

      case "strategiesParamsProvenance": {
        // B3 / QF-172: deployed strategy records the quant-optimizer run
        // (lineage_id from /api/catalog qo-run descriptor) that picked
        // its parameters. Validation happens inside StrategyStore so
        // malformed bodies surface as 400 via the generic error handler.
        const body = await readBody(req);
        result = await strategyStore.setParamsProvenance(
          route.id!,
          body as unknown as import("./strategy/lifecycle.js").ParamsProvenance,
        );
        break;
      }

      case "strategiesConfigList": {
        // QF-59: list every (portfolio, strategy) pair with a compact
        // preview of its config slice. The GUI uses this for the picker.
        result = { strategies: await strategyConfigStore.list() };
        break;
      }

      case "strategiesConfigGet": {
        // QF-59. Portfolio is optional via ?portfolio=…; defaults to
        // the first key in portfolios.json (today: "main").
        const portfolio = url.searchParams.get("portfolio") || mainPortfolio;
        result = await strategyConfigStore.get(portfolio, route.id!);
        break;
      }

      case "strategiesConfigPut": {
        // QF-59. Body shape is the patchable subset of StrategyConfigEntry:
        // { config?, signal_interests?, signal_staleness_seconds? }.
        // `module` is intentionally not writable here — see config-store.ts.
        const portfolio = url.searchParams.get("portfolio") || mainPortfolio;
        const body = await readBody(req);
        result = await strategyConfigStore.update(
          portfolio,
          route.id!,
          body as Record<string, unknown>,
        );
        break;
      }

      case "strategiesDriftBaselinePin": {
        // QF-331: operator pins (or re-pins) the drift baseline QO archive.
        // The archive URL is written to config.drift.baseline_qo_run in
        // portfolios.json so the slow-tier's baseline-resolver can read it.
        const body = await readBody(req);
        const pinBody = body as Record<string, unknown>;
        if (typeof pinBody["baseline_qo_run"] !== "string" || !pinBody["baseline_qo_run"]) {
          throw new Error("baseline_qo_run (non-empty string) is required");
        }
        const portfolio = url.searchParams.get("portfolio") || mainPortfolio;
        result = await strategyConfigStore.pinDriftBaseline(
          portfolio,
          route.id!,
          pinBody["baseline_qo_run"],
        );
        break;
      }

      case "tradeJournal": {
        const portfolio = url.searchParams.get("portfolio") || undefined;
        const status = url.searchParams.get("status") || "all";
        let trades;
        if (status === "open") trades = await tradeJournal.getOpenTrades(portfolio);
        else if (status === "closed") trades = await tradeJournal.getClosedTrades(portfolio);
        else trades = await tradeJournal.getAllTrades(portfolio);
        result = { trades };
        break;
      }

      case "tradeInspect": {
        // QF-229 — fill_id mode routes to the structured QF-215
        // handler (full audit chain: signal + intent + pricing
        // decisions + order + fill). Other modes (by time / strategy)
        // keep the legacy joined-row shape for the Audit Log screen.
        // A duplicate `case "tradeInspect"` below this point was dead
        // code prior to QF-229 — the structured handler was unreachable.
        const fillId = url.searchParams.get("fill_id");
        if (fillId && fillId.trim() !== "") {
          try {
            result = await tradeInspector.inspect(fillId.trim());
          } catch (err) {
            if (err instanceof TradeInspectorNotFoundError) {
              json(res, 404, { error: err.message });
              return;
            }
            throw err;
          }
          break;
        }
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const strategyId = url.searchParams.get("strategy_id");

        let sql: string;
        let params: string[] = [];
        if (strategyId) {
          sql = `SELECT ai.*, ao.order_id, ao.status as order_status, ao.broker
                 FROM audit_intents ai
                 LEFT JOIN audit_orders ao ON ai.intent_id = ao.intent_id
                 WHERE ai.strategy_id = ? ORDER BY ai.created_at DESC LIMIT 100`;
          params = [strategyId];
        } else if (from && to) {
          sql = `SELECT ai.*, ao.order_id, ao.status as order_status
                 FROM audit_intents ai
                 LEFT JOIN audit_orders ao ON ai.intent_id = ao.intent_id
                 WHERE ai.created_at BETWEEN ? AND ? ORDER BY ai.created_at DESC LIMIT 100`;
          params = [from, to];
        } else {
          sql = `SELECT ai.*, ao.order_id, ao.status as order_status
                 FROM audit_intents ai
                 LEFT JOIN audit_orders ao ON ai.intent_id = ao.intent_id
                 ORDER BY ai.created_at DESC LIMIT 50`;
        }
        result = await new Promise((resolve, reject) => {
          db.all(sql, ...params, (err: Error | null, rows: unknown[]) =>
            err ? reject(err) : resolve(rows ?? []),
          );
        });
        break;
      }

      case "writeJobsSubmit":
        await writeJobsModule.api.handleSubmit(req, res);
        return;

      case "writeJobsStatus":
        await writeJobsModule.api.handleStatus(req, res, route.id!);
        return;

      case "writeJobsList":
        await writeJobsModule.api.handleList(req, res, url.searchParams);
        return;

      case "storeSummary":
        await storeApi.handleStoreSummary(req, res);
        return;

      // QF-348 — browser-side telemetry log stream.
      case "telemetry":
        await telemetryHandler(req, res);
        return;

      // QF-229 — previously a duplicate `case "tradeInspect"` lived here
      // and was unreachable (the first match wins in a JS switch). Merged
      // into the canonical handler above which routes fill_id queries to
      // tradeInspector.inspect.
    }

    // Record HTTP metrics after successful handling (QF-276)
    const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
    const labels = { method: req.method, route: route.handler, status: 200 };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestTotal.inc(labels);

    json(res, 200, result);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = err.status ?? 500;
    // Record HTTP metrics for error responses too (QF-276)
    const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
    const labels = { method: req.method, route: route?.handler ?? "unknown", status };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestTotal.inc(labels);

    if (!res.headersSent) {
      json(res, status, { error: err.message ?? String(e) });
    } else {
      logger.error("Handler error after response started", {
        error: String(err.message ?? e),
        url: req.url,
      });
    }
  }
});

// ── WebSocket setup ─────────────────────────────────────────────────────

import { WebSocketServer } from "ws";

let stateWs: StateWebSocket | null = null;
try {
  const wss = new WebSocketServer({ noServer: true });

  stateWs = createStateWebSocket(server, logger.child("ws-state"), (_opts) => {
    // Return our pre-created wss as the "WsServer"
    return wss;
  });

  // QF-61: wire the alert router's `internal` channel through stateWs
  // so matched alerts fan out to connected operator UIs.
  alertRouter.setInternalSink((alert) => stateWs!.pushAlert(alert));

  // Handle HTTP upgrade for /ws/state
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname === "/ws/state") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);

        // Send initial snapshot
        const snapshot: {
          type: string;
          portfolios: Record<string, unknown>;
          [key: string]: unknown;
        } = {
          type: "snapshot",
          portfolios: {},
          orders: { pending: [], recent: orderPlane.listOrders().slice(-20) },
          system: {
            app_env: APP_ENV,
            trading_mode: TRADING_MODE,
            execution_mode: portfolioConfigs[mainPortfolio]?.mode ?? "paper_local",
            halted: orderPlane.isHalted(),
            nats_connected: natsConn !== null && !natsConn.isClosed(),
            sources_available: dataSources
              .getSourceStatus()
              .filter((s) => s.available)
              .map((s) => s.key),
            schwab_token: getSchwabTokenStatus(),
          },
          models: [],
          strategies: strategyStore.list(),
          risk_limits: riskLimitsStore.get(),
        };
        // Add portfolio states
        for (const id of Object.keys(portfolioConfigs)) {
          try {
            snapshot.portfolios[id] = portfolioEngine.getState(id);
          } catch {}
        }
        ws.send(JSON.stringify(snapshot));
      });
    }
  });

  // WebSocket ready
} catch (e) {
  logger.warn("State WebSocket not initialized", {
    error: e instanceof Error ? e.message : String(e),
  });
  stateWs = null;
}

// ── Strategy lifecycle store ────────────────────────────────────────────
// Persists registered/enabled/running/paused/halted/retired state per
// strategy to data/strategies.json. Every transition emits a
// `strategy_update` WS message; the GUI's Strategies workspace
// (Phase 3) reads from the snapshot + diffs.

strategyStore = new StrategyStore({
  path: resolve(ROOT_DIR, "data/strategies.json"),
  logger: logger.child("strategy"),
  onChange: (s) => {
    if (stateWs) stateWs.pushStrategyUpdate(s);
  },
});
try {
  await strategyStore.load();
  logger.info("Strategy store loaded", { count: strategyStore.list().length });
} catch (e) {
  logger.warn("Strategy store load failed", {
    error: e instanceof Error ? e.message : String(e),
  });
}

// ── Strategy config store (config/portfolios.json) ────────────────────────
// QF-59. Read/write the per-strategy `config` slice for the Settings →
// Models → Strategies screen. The runner consumes portfolios.json at
// boot, so v1 semantics are "save → restart to apply" (documented in
// the GUI banner).
const strategyConfigStore = new StrategyConfigStore({
  portfoliosJsonPath: resolve(ROOT_DIR, "config/portfolios.json"),
  logger: logger.child("strategy-config"),
});

// ── Risk limits store (config/risk_limits.yaml) ───────────────────────────
// On first boot the YAML doesn't exist; we bootstrap from whatever
// limits portfolios.json has so behavior doesn't change. From the
// second boot onward, the YAML is the editable source — the GUI
// (Settings → Risk → Limits) writes to it; portfolios.json's limits
// block is left in place for now but is no longer authoritative.

const riskFallback: Record<string, RiskLimits> = {};
for (const [pid, cfg] of Object.entries(portfolioConfigs) as [string, PortfolioConfig][]) {
  if (cfg && cfg.limits) riskFallback[pid] = cfg.limits;
}
const riskLimitsStore = new RiskLimitsStore({
  yamlPath: resolve(ROOT_DIR, "config/risk_limits.yaml"),
  logger: logger.child("risk-limits"),
  fallbackLimits: riskFallback,
  onChange: (cfg) => {
    if (stateWs) stateWs.pushRiskLimits(cfg);
  },
});
try {
  await riskLimitsStore.load();
} catch (e) {
  logger.warn("Risk limits load failed", {
    error: e instanceof Error ? e.message : String(e),
  });
}

// QF-54: per-model quality thresholds (healthy / degraded / failed flips
// driven by model_quality metrics). Empty config until an operator sets
// anything via the Settings UI — no fallback bootstrap.
const qualityThresholdsStore = new QualityThresholdsStore({
  yamlPath: resolve(ROOT_DIR, "config/quality_thresholds.yaml"),
  logger: logger.child("quality-thresholds"),
});
try {
  await qualityThresholdsStore.load();
} catch (e) {
  logger.warn("Quality thresholds load failed", {
    error: e instanceof Error ? e.message : String(e),
  });
}

// QF-57: named risk-policy presets (Standard / Tight overnight / Earnings
// week / ...). Applying a policy copies its limits into risk_limits.yaml
// via the riskLimitsStore above.
const riskPoliciesStore = new RiskPoliciesStore({
  yamlPath: resolve(ROOT_DIR, "config/risk_policies.yaml"),
  logger: logger.child("risk-policies"),
  riskLimitsStore,
});
try {
  await riskPoliciesStore.load();
} catch (e) {
  logger.warn("Risk policies load failed", {
    error: e instanceof Error ? e.message : String(e),
  });
}

// ── Startup ──────────────────────────────────────────────────────────────

// ── Startup banner ──────────────────────────────────────────────────────

const portfolioNames = Object.keys(portfolioConfigs).join(", ") || "none";
const sources = dataSources
  .getSourceStatus()
  .map((s) => {
    const icon = s.available ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
    return `${icon} ${s.name}`;
  })
  .join("  ");
const natsStatus = natsConn ? "\x1b[32m●\x1b[0m connected" : "\x1b[2m○ not available\x1b[0m";
const envColor = APP_ENV === "prod" ? "\x1b[31m" : "\x1b[33m";
const tradingColor = TRADING_MODE === "live" ? "\x1b[32m" : "\x1b[33m";

server.listen(PORT, () => {
  console.log();
  console.log("  \x1b[36mEV\x1b[0m \x1b[1mTrading System\x1b[0m");
  console.log();
  console.log(
    `  Environment: ${envColor}${APP_ENV}\x1b[0m  Trading: ${tradingColor}${TRADING_MODE}\x1b[0m`,
  );
  console.log(`  Port:        \x1b[1m${PORT}\x1b[0m`);
  console.log(`  Portfolios:  ${portfolioNames}`);
  console.log(`  Data:        ${dataUri()}`);
  console.log(`  Sources:     ${sources}`);
  console.log(`  NATS:        ${natsStatus}`);
  console.log(
    `  Calendar:    ${calendar ? "\x1b[32m●\x1b[0m loaded" : "\x1b[2m○ not loaded\x1b[0m"}`,
  );
  console.log();
  console.log(`  \x1b[32m✓\x1b[0m http://localhost:${PORT}`);
  console.log();
});
