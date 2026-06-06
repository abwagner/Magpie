// ── IBKR Market Data Adapter ──────────────────────────────────────
// Wraps @stoqey/ib for live quotes and option chains. Supports:
//   - Stock quotes (SecType.STK)
//   - Futures quotes (SecType.FUT, front-month resolution from root)
//   - Equity option chains (SecType.OPT)
//   - Futures option chains (SecType.FOP)
//
// Streaming (`subscribeQuotes`) is not yet implemented — falls back to
// poll-based subscription at the service layer.
// Historical chains are served from Parquet via the store, not IBKR.
//
// Core flows lift logic from scripts/ibkr-snapshot.js, which is the
// battle-tested reference for contract resolution, option params, and
// batched snapshot requests against IB Gateway.
//
// Defined in: docs/tdd/market-data.md, topic 3

import type {
  MarketDataAdapter,
  Quote,
  Contract,
  QuoteCallback,
  Subscription,
} from "../../../src/types/market-data.js";
import { isFutures } from "../../../src/lib/symbols.js";
import type * as StoqeyIb from "@stoqey/ib";

type IBApiType = InstanceType<typeof StoqeyIb.IBApi>;
type EventNameType = typeof StoqeyIb.EventName;
type SecTypeEnum = typeof StoqeyIb.SecType;
type OptionTypeEnum = typeof StoqeyIb.OptionType;

// @stoqey/ib's main index.d.ts only exports TickType as a type alias,
// not a value — but at runtime the CJS bundle exposes the enum. Declare
// the subset of members we actually use so TS can typecheck the lookups.
interface TickTypeEnum {
  BID: number;
  ASK: number;
  LAST: number;
  VOLUME: number;
}

// ── Types ──────────────────────────────────────────────────────────

interface IbkrConfig {
  host?: string;
  port?: number;
  client_id?: number;
  timeout_ms?: number;
}

interface IbTicks {
  bid: number;
  ask: number;
  last: number;
  volume: number;
}

interface IbGreeks {
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  undPrice: number | null;
}

interface IbSnapshot {
  ticks: IbTicks;
  greeks: IbGreeks;
}

interface IbContractDetail {
  contract: StoqeyIb.Contract & {
    conId: number;
    symbol: string;
    exchange: string;
    lastTradeDateOrContractMonth?: string;
    tradingClass?: string;
  };
}

interface OptionParamRow {
  exchange: string;
  tradingClass: string;
  multiplier: string;
  expirations: string[];
  strikes: number[];
}

// ── Constants ──────────────────────────────────────────────────────

// Futures root → primary exchange mapping. Lifted from
// scripts/ibkr-snapshot.js — kept in sync here rather than imported so
// adapter and snapshot script can diverge if needed.
const EXCHANGE_MAP: Record<string, string> = {
  CL: "NYMEX",
  RB: "NYMEX",
  NG: "NYMEX",
  HO: "NYMEX",
  ES: "CME",
  NQ: "CME",
  RTY: "CME",
  "6E": "CME",
  YM: "CBOT",
  ZB: "CBOT",
  ZN: "CBOT",
  ZC: "CBOT",
  ZS: "CBOT",
  ZW: "CBOT",
  GC: "COMEX",
  SI: "COMEX",
  HG: "COMEX",
};

// Default strike window around ATM per side. 61 strikes × 2 sides = 122
// contracts, well under IBKR's 100 concurrent market-data subscription
// limit when batched, and covers the typical liquid range.
const STRIKE_WINDOW = 30;

// Batch size + inter-batch sleep honor IBKR's 50 msg/sec rate limit.
const BATCH_SIZE = 50;
const BATCH_SLEEP_MS = 200;

// Benign TWS notification codes we ignore on the top-level error handler.
// 2104/2106/2158 are "market data farm connection is OK" notices; -1 is
// the generic info code. Everything else we log.
const BENIGN_ERROR_CODES = new Set([-1, 2104, 2106, 2158]);

// ── Connection singleton ───────────────────────────────────────────
// TWS only allows one connection per clientId, and @stoqey/ib
// multiplexes requests on a single socket via reqId. So we share one
// IBApi across all adapter method calls.

interface StoqeyModule {
  IBApi: typeof StoqeyIb.IBApi;
  EventName: EventNameType;
  SecType: SecTypeEnum;
  TickType: TickTypeEnum;
  OptionType: OptionTypeEnum;
}

let ibApi: IBApiType | null = null;
let connected = false;
let connecting: Promise<IBApiType | null> | null = null;
let stoqeyModule: StoqeyModule | null = null;
let nextReqId = 5000;

function getReqId(): number {
  return nextReqId++;
}

// IBApi.on/off have per-event overloads that don't unify when called
// with a dynamic EventName value — wrap once so helpers can subscribe
// without a cast at every call site.
type EventBus = {
  on: (ev: string, fn: (...a: unknown[]) => void) => unknown;
  off: (ev: string, fn: (...a: unknown[]) => void) => unknown;
};
function asBus(api: IBApiType): EventBus {
  return api as unknown as EventBus;
}

async function loadStoqey(): Promise<StoqeyModule | null> {
  // Dynamic import so a missing dependency doesn't crash startup —
  // available() will just return false. @stoqey/ib's main export is
  // missing TickType as a value in its declarations, so we pull it
  // straight from the CJS default export at runtime.
  try {
    const mod = (await import("@stoqey/ib")) as unknown as StoqeyModule;
    return {
      IBApi: mod.IBApi,
      EventName: mod.EventName,
      SecType: mod.SecType,
      TickType: mod.TickType,
      OptionType: mod.OptionType,
    };
  } catch {
    return null;
  }
}

async function ensureConnection(config: Required<IbkrConfig>): Promise<IBApiType | null> {
  if (ibApi && connected) return ibApi;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      if (!stoqeyModule) stoqeyModule = await loadStoqey();
      if (!stoqeyModule) return null;
      const { IBApi, EventName } = stoqeyModule;

      const api = new IBApi({ host: config.host, port: config.port, clientId: config.client_id });
      const bus = asBus(api);

      bus.on(EventName.error, (...args: unknown[]) => {
        const err = args[0] as Error | undefined;
        const code = args[1] as number | undefined;
        if (code !== undefined && BENIGN_ERROR_CODES.has(code)) return;
        process.stderr.write(`[ibkr] code=${code ?? "?"}: ${err?.message ?? ""}\n`);
      });
      bus.on(EventName.disconnected, () => {
        connected = false;
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("IBKR connection timeout")),
          config.timeout_ms,
        );
        bus.on(EventName.connected, () => {
          clearTimeout(timer);
          connected = true;
          resolve();
        });
        api.connect();
      });

      ibApi = api;
      return api;
    } catch (e) {
      process.stderr.write(`[ibkr] connect failed: ${String((e as Error).message ?? e)}\n`);
      ibApi = null;
      connected = false;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

// ── Pure helpers (exported for tests) ──────────────────────────────

/** Convert IB's YYYYMMDD date to ISO YYYY-MM-DD. */
export function ibDateToIso(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** Convert ISO YYYY-MM-DD to IB's YYYYMMDD. */
export function isoToIbDate(iso: string): string {
  return iso.replace(/-/g, "");
}

/** Calendar days until an ISO date. 0 if past. */
export function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso + "T00:00:00Z").getTime() - Date.now()) / 86400000));
}

/** Futures root → primary exchange. NYMEX as default catch-all. */
export function exchangeForRoot(root: string): string {
  return EXCHANGE_MAP[root.toUpperCase()] || "NYMEX";
}

/** Pick ±window strikes around the strike nearest to spot. */
export function windowStrikesAroundAtm(
  strikes: number[],
  spot: number,
  window = STRIKE_WINDOW,
): number[] {
  if (!strikes.length) return [];
  const sorted = [...strikes].sort((a, b) => a - b);
  let atmIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const dist = Math.abs(sorted[i]! - spot);
    if (dist < minDist) {
      minDist = dist;
      atmIdx = i;
    }
  }
  return sorted.slice(Math.max(0, atmIdx - window), atmIdx + window + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── TWS request primitives ─────────────────────────────────────────

function resolveContractDetails(
  api: IBApiType,
  events: EventNameType,
  query: Record<string, unknown>,
  timeoutMs: number,
): Promise<IbContractDetail[]> {
  return new Promise((resolve, reject) => {
    const bus = asBus(api);
    const reqId = getReqId();
    const details: IbContractDetail[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Contract details timeout"));
    }, timeoutMs);

    const onDetails = (...a: unknown[]) => {
      if (a[0] === reqId) details.push(a[1] as IbContractDetail);
    };
    const onEnd = (...a: unknown[]) => {
      if (a[0] === reqId) {
        cleanup();
        resolve(details);
      }
    };
    function cleanup() {
      clearTimeout(timer);
      bus.off(events.contractDetails, onDetails);
      bus.off(events.contractDetailsEnd, onEnd);
    }

    bus.on(events.contractDetails, onDetails);
    bus.on(events.contractDetailsEnd, onEnd);
    api.reqContractDetails(reqId, query as unknown as StoqeyIb.Contract);
  });
}

function requestSnapshot(
  api: IBApiType,
  events: EventNameType,
  tickTypes: TickTypeEnum,
  contract: StoqeyIb.Contract,
  timeoutMs: number,
): Promise<IbSnapshot> {
  return new Promise((resolve, reject) => {
    const bus = asBus(api);
    const reqId = getReqId();
    const ticks: IbTicks = { bid: 0, ask: 0, last: 0, volume: 0 };
    const greeks: IbGreeks = {
      iv: null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      undPrice: null,
    };
    let gotData = false;

    const timer = setTimeout(() => {
      cleanup();
      if (gotData) resolve({ ticks, greeks });
      else reject(new Error("Snapshot timeout"));
    }, timeoutMs);

    const onTickPrice = (...a: unknown[]) => {
      const [id, type, value] = a as [number, number, number];
      if (id !== reqId || value === -1) return;
      gotData = true;
      if (type === tickTypes.BID) ticks.bid = value;
      else if (type === tickTypes.ASK) ticks.ask = value;
      else if (type === tickTypes.LAST) ticks.last = value;
    };
    const onTickSize = (...a: unknown[]) => {
      const [id, type, value] = a as [number, number, number];
      if (id !== reqId || value === -1) return;
      gotData = true;
      if (type === tickTypes.VOLUME) ticks.volume = value;
    };
    const onTickOption = (...a: unknown[]) => {
      const [id, , , iv, delta, , , gamma, vega, theta, undPrice] = a as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      if (id !== reqId) return;
      gotData = true;
      if (iv > 0 && iv < 10) greeks.iv = iv;
      if (delta > -2 && delta < 2) greeks.delta = delta;
      if (gamma >= 0) greeks.gamma = gamma;
      if (theta !== undefined && theta !== null) greeks.theta = theta;
      if (vega !== undefined && vega !== null) greeks.vega = vega;
      if (undPrice > 0) greeks.undPrice = undPrice;
    };
    const onSnapshotEnd = (...a: unknown[]) => {
      if (a[0] === reqId) {
        cleanup();
        resolve({ ticks, greeks });
      }
    };
    const onError = (...a: unknown[]) => {
      if (a[2] === reqId) {
        cleanup();
        reject(new Error(`IBKR error`));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      bus.off(events.tickPrice, onTickPrice);
      bus.off(events.tickSize, onTickSize);
      bus.off(events.tickOptionComputation, onTickOption);
      bus.off(events.tickSnapshotEnd, onSnapshotEnd);
      bus.off(events.error, onError);
      try {
        api.cancelMktData(reqId);
      } catch {
        /* already cancelled */
      }
    }

    bus.on(events.tickPrice, onTickPrice);
    bus.on(events.tickSize, onTickSize);
    bus.on(events.tickOptionComputation, onTickOption);
    bus.on(events.tickSnapshotEnd, onSnapshotEnd);
    bus.on(events.error, onError);
    // "106" = generic tick list for option Greeks; snapshot=true
    api.reqMktData(reqId, contract, "106", true, false);
  });
}

function requestOptionParams(
  api: IBApiType,
  events: EventNameType,
  root: string,
  conId: number,
  exchange: string,
  secType: string,
  timeoutMs: number,
): Promise<OptionParamRow[]> {
  return new Promise((resolve, reject) => {
    const bus = asBus(api);
    const reqId = getReqId();
    const rows: OptionParamRow[] = [];
    const timer = setTimeout(() => {
      cleanup();
      if (rows.length) resolve(rows);
      else reject(new Error("Option params timeout"));
    }, timeoutMs);

    const onParam = (...a: unknown[]) => {
      const [id, exch, , tradingClass, multiplier, expirations, strikes] = a as [
        number,
        string,
        number,
        string,
        string,
        Set<string>,
        Set<number>,
      ];
      if (id !== reqId) return;
      rows.push({
        exchange: exch,
        tradingClass,
        multiplier,
        expirations: [...expirations],
        strikes: [...strikes],
      });
    };
    const onEnd = (...a: unknown[]) => {
      if (a[0] === reqId) {
        cleanup();
        resolve(rows);
      }
    };
    function cleanup() {
      clearTimeout(timer);
      bus.off(events.securityDefinitionOptionParameter, onParam);
      bus.off(events.securityDefinitionOptionParameterEnd, onEnd);
    }

    bus.on(events.securityDefinitionOptionParameter, onParam);
    bus.on(events.securityDefinitionOptionParameterEnd, onEnd);
    api.reqSecDefOptParams(reqId, root, exchange, secType as StoqeyIb.SecType, conId);
  });
}

// ── Contract resolution ────────────────────────────────────────────

async function resolveFuturesContract(
  api: IBApiType,
  events: EventNameType,
  secTypes: SecTypeEnum,
  symbol: string,
  timeoutMs: number,
): Promise<IbContractDetail | null> {
  const root = symbol.replace(/^[./]+/, "").toUpperCase();
  const exchange = exchangeForRoot(root);
  const query = { symbol: root, secType: secTypes.FUT, exchange, currency: "USD" };

  const details = await resolveContractDetails(api, events, query, timeoutMs);
  if (!details.length) return null;

  // Pick nearest-expiry future that hasn't expired yet.
  const todayIb = isoToIbDate(new Date().toISOString().slice(0, 10));
  const future = details
    .filter((d) => (d.contract.lastTradeDateOrContractMonth || "") >= todayIb)
    .sort((a, b) =>
      (a.contract.lastTradeDateOrContractMonth || "").localeCompare(
        b.contract.lastTradeDateOrContractMonth || "",
      ),
    );
  return future[0] ?? details[0]!;
}

async function resolveStockContract(
  api: IBApiType,
  events: EventNameType,
  secTypes: SecTypeEnum,
  symbol: string,
  timeoutMs: number,
): Promise<IbContractDetail | null> {
  const query = {
    symbol: symbol.toUpperCase(),
    secType: secTypes.STK,
    exchange: "SMART",
    currency: "USD",
  };
  const details = await resolveContractDetails(api, events, query, timeoutMs);
  return details[0] ?? null;
}

// ── Factory ────────────────────────────────────────────────────────

export function createAdapter(config: IbkrConfig = {}): MarketDataAdapter {
  const resolved = {
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 4002,
    client_id: config.client_id ?? 2,
    timeout_ms: config.timeout_ms ?? 10000,
  };

  async function getContext() {
    const ib = await ensureConnection(resolved);
    if (!ib || !stoqeyModule) return null;
    return { ib, ...stoqeyModule };
  }

  function buildMeta(t0: number): Quote["_meta"] {
    return {
      source: "ibkr",
      source_timestamp: null,
      fetched_at: new Date().toISOString(),
      freshness_ms: null,
      latency_ms: Date.now() - t0,
      from_cache: false,
      cache_age_ms: 0,
      sources_tried: ["ibkr"],
    };
  }

  return {
    name: "ibkr",

    async available(): Promise<boolean> {
      try {
        const ib = await ensureConnection(resolved);
        return ib !== null && connected;
      } catch {
        return false;
      }
    },

    async stockQuote(symbol: string): Promise<Quote | null> {
      const t0 = Date.now();
      const ctx = await getContext();
      if (!ctx) return null;

      try {
        const detail = isFutures(symbol)
          ? await resolveFuturesContract(
              ctx.ib,
              ctx.EventName,
              ctx.SecType,
              symbol,
              resolved.timeout_ms,
            )
          : await resolveStockContract(
              ctx.ib,
              ctx.EventName,
              ctx.SecType,
              symbol,
              resolved.timeout_ms,
            );
        if (!detail) return null;

        const snap = await requestSnapshot(
          ctx.ib,
          ctx.EventName,
          ctx.TickType,
          detail.contract,
          resolved.timeout_ms,
        );
        const { bid, ask, last, volume } = snap.ticks;
        const mid = bid && ask ? (bid + ask) / 2 : last || 0;

        return {
          symbol,
          bid,
          ask,
          mid,
          last,
          volume,
          timestamp: new Date().toISOString(),
          _meta: buildMeta(t0),
        };
      } catch (e) {
        process.stderr.write(
          `[ibkr] stockQuote(${symbol}) failed: ${String((e as Error).message ?? e)}\n`,
        );
        return null;
      }
    },

    async expirations(symbol: string): Promise<string[] | null> {
      const ctx = await getContext();
      if (!ctx) return null;

      try {
        const detail = isFutures(symbol)
          ? await resolveFuturesContract(
              ctx.ib,
              ctx.EventName,
              ctx.SecType,
              symbol,
              resolved.timeout_ms,
            )
          : await resolveStockContract(
              ctx.ib,
              ctx.EventName,
              ctx.SecType,
              symbol,
              resolved.timeout_ms,
            );
        if (!detail) return null;

        const underlyingSec = isFutures(symbol) ? ctx.SecType.FUT : ctx.SecType.STK;
        const rows = await requestOptionParams(
          ctx.ib,
          ctx.EventName,
          detail.contract.symbol,
          detail.contract.conId,
          detail.contract.exchange,
          underlyingSec,
          resolved.timeout_ms,
        );
        if (!rows.length) return null;

        const todayIb = isoToIbDate(new Date().toISOString().slice(0, 10));
        const all = new Set<string>();
        for (const r of rows) for (const e of r.expirations) if (e >= todayIb) all.add(e);
        return [...all].sort().map(ibDateToIso);
      } catch (e) {
        process.stderr.write(
          `[ibkr] expirations(${symbol}) failed: ${String((e as Error).message ?? e)}\n`,
        );
        return null;
      }
    },

    async chain(symbol: string, expiration: string): Promise<Contract[] | null> {
      const ctx = await getContext();
      if (!ctx) return null;

      try {
        const futures = isFutures(symbol);
        const detail = futures
          ? await resolveFuturesContract(
              ctx.ib,
              ctx.EventName,
              ctx.SecType,
              symbol,
              resolved.timeout_ms,
            )
          : await resolveStockContract(
              ctx.ib,
              ctx.EventName,
              ctx.SecType,
              symbol,
              resolved.timeout_ms,
            );
        if (!detail) return null;

        // Underlying quote → ATM strike + underlyingPrice field.
        const undSnap = await requestSnapshot(
          ctx.ib,
          ctx.EventName,
          ctx.TickType,
          detail.contract,
          resolved.timeout_ms,
        );
        const underlyingPrice = undSnap.ticks.last || undSnap.ticks.bid || 0;
        if (!underlyingPrice) return null;

        // Option params → strikes + tradingClass for this expiration.
        const underlyingSec = futures ? ctx.SecType.FUT : ctx.SecType.STK;
        const paramRows = await requestOptionParams(
          ctx.ib,
          ctx.EventName,
          detail.contract.symbol,
          detail.contract.conId,
          detail.contract.exchange,
          underlyingSec,
          resolved.timeout_ms,
        );
        if (!paramRows.length) return null;

        const expIb = isoToIbDate(expiration);
        const strikeSet = new Set<number>();
        let tradingClass = detail.contract.tradingClass || detail.contract.symbol;
        for (const r of paramRows) {
          if (r.expirations.includes(expIb)) {
            for (const s of r.strikes) strikeSet.add(s);
            tradingClass = r.tradingClass || tradingClass;
          }
        }
        if (!strikeSet.size) return null;

        const strikes = windowStrikesAroundAtm([...strikeSet], underlyingPrice, STRIKE_WINDOW);
        const dte = daysUntil(expiration);
        const optSecType = futures ? ctx.SecType.FOP : ctx.SecType.OPT;

        // Build call+put contracts per strike.
        type OptReq = { ibContract: StoqeyIb.Contract; strike: number; side: "call" | "put" };
        const optReqs: OptReq[] = [];
        for (const strike of strikes) {
          for (const right of [ctx.OptionType.Call, ctx.OptionType.Put]) {
            optReqs.push({
              ibContract: {
                symbol: detail.contract.symbol,
                secType: optSecType,
                exchange: detail.contract.exchange,
                currency: "USD",
                lastTradeDateOrContractMonth: expIb,
                strike,
                right,
                tradingClass,
              } as StoqeyIb.Contract,
              strike,
              side: right === ctx.OptionType.Call ? "call" : "put",
            });
          }
        }

        // Batch snapshots — 50 concurrent, 200ms sleep between batches.
        const contracts: Contract[] = [];
        for (let i = 0; i < optReqs.length; i += BATCH_SIZE) {
          const batch = optReqs.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map((o) =>
              requestSnapshot(
                ctx.ib,
                ctx.EventName,
                ctx.TickType,
                o.ibContract,
                resolved.timeout_ms,
              ).then((snap) => ({ o, snap })),
            ),
          );
          for (const r of results) {
            if (r.status !== "fulfilled") continue;
            const { o, snap } = r.value;
            const { bid, ask, last, volume } = snap.ticks;
            const mid = bid && ask ? (bid + ask) / 2 : last || 0;
            contracts.push({
              symbol: `${detail.contract.symbol} ${expiration} ${o.side === "call" ? "C" : "P"}${o.strike}`,
              underlying: symbol,
              expiration,
              side: o.side,
              strike: o.strike,
              dte,
              bid,
              ask,
              mid,
              last,
              volume,
              // Open interest requires generic tick "101" (not in our
              // request). Parity with scripts/ibkr-snapshot.js: leave 0.
              openInterest: 0,
              underlyingPrice,
              iv: snap.greeks.iv ?? 0,
              delta: snap.greeks.delta ?? 0,
              gamma: snap.greeks.gamma ?? 0,
              theta: snap.greeks.theta ?? 0,
              vega: snap.greeks.vega ?? 0,
            });
          }
          if (i + BATCH_SIZE < optReqs.length) await sleep(BATCH_SLEEP_MS);
        }

        return contracts.sort((a, b) => a.strike - b.strike || (a.side === "call" ? -1 : 1));
      } catch (e) {
        process.stderr.write(
          `[ibkr] chain(${symbol},${expiration}) failed: ${String((e as Error).message ?? e)}\n`,
        );
        return null;
      }
    },

    async historicalChain(
      _symbol: string,
      _date: string,
      _expiration: string,
    ): Promise<Contract[] | null> {
      // Not supported — IBKR historical data is a separate paid subscription.
      // Historical queries are served from Parquet via the store query module.
      return null;
    },

    subscribeQuotes(_symbols: string[], _callback: QuoteCallback): Subscription | null {
      // Deferred: streaming requires a persistent subscription map and
      // cleanup on unsubscribe. Returning null makes the service fall
      // back to poll-based subscription, which works.
      return null;
    },
  };
}
