// ── Server-Side Storage (Chains) ─────────────────────────────────────────
// Read/write the per-month chain parquet files. Single source of truth for
// the live HTTP server's /api/storage/* endpoints, the backtest CLI, and
// the loader.
//
// Backed by server/orchestrator/storage.ts so chains live wherever DATA_URI
// points (file:// for local dev, s3:// for MinIO/AWS) without this module
// having to know.

import type { Database } from "duckdb";
import {
  exists,
  joinUri,
  registerRows,
  replaceAndWriteParquet,
  withDb,
} from "./orchestrator/storage.js";

// ── Types ──────────────────────────────────────────────────────────────

export type Side = "call" | "put";

/** Input shape accepted by storeChain. Caller may omit volume/openInterest. */
export interface StoreContract {
  underlying?: string;
  underlyingPrice: number;
  expiration: string;
  side: Side | string;
  strike: number;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume?: number;
  openInterest?: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** Output shape returned by getChain. Includes computed `symbol` and `inTheMoney`. */
export interface ChainContract {
  symbol: string;
  underlying: string;
  expiration: string;
  side: string;
  strike: number;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  underlyingPrice: number;
  inTheMoney: boolean;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface ChainSummary {
  symbol: string;
  date_min: string;
  date_max: string;
  trading_days: number;
  total_rows: number;
  price_min: number;
  price_max: number;
  files: number;
}

export interface ChainSymbolDetail {
  date: string;
  underlying_price: number;
  contracts: number;
  unique_strikes: number;
  expirations: number;
  strike_min: number;
  strike_max: number;
  strike_width_pct: number;
}

export interface Storage {
  hasData(symbol: string, date: string): Promise<boolean>;
  getDates(symbol: string): Promise<string[]>;
  getChain(symbol: string, date: string, expiration?: string | null): Promise<ChainContract[]>;
  storeChain(
    symbol: string,
    date: string,
    contracts: readonly StoreContract[],
    source?: string,
  ): Promise<{ uri: string; contracts: number }>;
  getSummary(): Promise<ChainSummary[]>;
  getSymbolDetail(symbol: string): Promise<ChainSymbolDetail[]>;
  getExpirations(symbol: string, date: string): Promise<string[]>;
  getUnderlyingPrice(symbol: string, date: string): Promise<number | null>;
  /** No-op: per-call connection lifecycle is handled by withDb(). */
  close(): void;
}

// ── Internals ──────────────────────────────────────────────────────────

const SCHEMA = `(
  date DATE, underlying VARCHAR, underlyingPrice DOUBLE, expiration DATE,
  side VARCHAR, strike DOUBLE, dte INTEGER, bid DOUBLE, ask DOUBLE,
  mid DOUBLE, last DOUBLE, volume INTEGER, openInterest INTEGER,
  iv DOUBLE, delta DOUBLE, gamma DOUBLE, theta DOUBLE, vega DOUBLE,
  source VARCHAR
)`;

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

function chainsGlob(symbol: string): string {
  return joinUri("chains", `${symbol}-*.parquet`);
}

function chainsMonthUri(symbol: string, date: string): string {
  return joinUri("chains", `${symbol}-${date.slice(0, 7)}.parquet`);
}

function asDateString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function allAsync<T = Record<string, unknown>>(db: Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as unknown as T[]);
    });
  });
}

// ── Chain-write primitive ──────────────────────────────────────────────
//
// Exported so the M10-4 chain-store handler can land a chain via the
// dispatcher without recursing through Storage.storeChain. The
// Storage method delegates here; the handler imports this directly.

export async function writeChainParquet(
  symbol: string,
  date: string,
  contracts: readonly StoreContract[],
  source = "live",
): Promise<{ uri: string; contracts: number }> {
  const uri = chainsMonthUri(symbol, date);
  const rows = contracts.map((c) => ({
    date,
    underlying: c.underlying ?? symbol,
    underlyingPrice: c.underlyingPrice,
    expiration: c.expiration,
    side: c.side,
    strike: c.strike,
    dte: c.dte,
    bid: c.bid,
    ask: c.ask,
    mid: c.mid,
    last: c.last,
    volume: c.volume ?? 0,
    openInterest: c.openInterest ?? 0,
    iv: c.iv,
    delta: c.delta,
    gamma: c.gamma,
    theta: c.theta,
    vega: c.vega,
    source,
  }));
  // Atomic full-day replacement: drop existing rows for `date` and
  // append the new contracts. Matches the original storage.js behavior.
  await replaceAndWriteParquet({
    uri,
    schema: SCHEMA,
    rows,
    replaceWhere: `date = '${escape(date)}'`,
    orderBy: "date, expiration, strike, side",
  });
  return { uri, contracts: contracts.length };
}

// ── Public surface ─────────────────────────────────────────────────────

export function createStorage(): Storage {
  return {
    async hasData(symbol, date) {
      const uri = chainsGlob(symbol);
      if (!(await globMaybeExists(uri))) return false;
      try {
        const rows = await withDb(async (db) =>
          allAsync<{ n: number | bigint }>(
            db,
            `SELECT count(*) AS n FROM read_parquet('${escape(uri)}')
             WHERE date = '${escape(date)}'`,
          ),
        );
        return Number(rows[0]?.n ?? 0) > 0;
      } catch {
        return false;
      }
    },

    async getDates(symbol) {
      const uri = chainsGlob(symbol);
      try {
        const rows = await withDb(async (db) =>
          allAsync<{ date: unknown }>(
            db,
            `SELECT DISTINCT date FROM read_parquet('${escape(uri)}') ORDER BY date`,
          ),
        );
        return rows.map((r) => asDateString(r.date));
      } catch {
        return [];
      }
    },

    async getChain(symbol, date, expiration = null) {
      const uri = chainsGlob(symbol);
      try {
        const where = expiration
          ? `date = '${escape(date)}' AND expiration = '${escape(expiration)}'`
          : `date = '${escape(date)}'`;
        const rows = await withDb(async (db) =>
          allAsync<RawChainRow>(
            db,
            `SELECT * FROM read_parquet('${escape(uri)}')
             WHERE ${where}
             ORDER BY expiration, strike, side`,
          ),
        );
        return rows.map(toChainContract);
      } catch {
        return [];
      }
    },

    async storeChain(symbol, date, contracts, source = "live") {
      return writeChainParquet(symbol, date, contracts, source);
    },

    async getSummary() {
      const uri = joinUri("chains", "*.parquet");
      try {
        return await withDb(async (db) => {
          const rows = await allAsync<RawSummaryRow>(
            db,
            `SELECT
               underlying AS symbol,
               MIN(date) AS date_min,
               MAX(date) AS date_max,
               COUNT(DISTINCT date) AS trading_days,
               COUNT(*) AS total_rows,
               MIN(underlyingPrice) AS price_min,
               MAX(underlyingPrice) AS price_max,
               COUNT(DISTINCT strftime(date, '%Y-%m')) AS files
             FROM read_parquet('${escape(uri)}')
             GROUP BY underlying
             ORDER BY underlying`,
          );
          return rows.map(
            (r): ChainSummary => ({
              symbol: r.symbol,
              date_min: asDateString(r.date_min),
              date_max: asDateString(r.date_max),
              trading_days: Number(r.trading_days),
              total_rows: Number(r.total_rows),
              price_min: Number(r.price_min),
              price_max: Number(r.price_max),
              files: Number(r.files),
            }),
          );
        });
      } catch {
        return [];
      }
    },

    async getSymbolDetail(symbol) {
      const uri = chainsGlob(symbol);
      try {
        return await withDb(async (db) => {
          const rows = await allAsync<RawDetailRow>(
            db,
            `SELECT
               date,
               underlyingPrice,
               COUNT(*) AS contracts,
               COUNT(DISTINCT strike) AS unique_strikes,
               COUNT(DISTINCT expiration) AS expirations,
               MIN(strike) AS strike_min,
               MAX(strike) AS strike_max
             FROM read_parquet('${escape(uri)}')
             GROUP BY date, underlyingPrice
             ORDER BY date`,
          );
          return rows.map((r): ChainSymbolDetail => {
            const spot = Number(r.underlyingPrice);
            const sMin = Number(r.strike_min);
            const sMax = Number(r.strike_max);
            const halfWidth = spot > 0 ? Math.max(Math.abs(sMax - spot), Math.abs(spot - sMin)) : 0;
            return {
              date: asDateString(r.date),
              underlying_price: spot,
              contracts: Number(r.contracts),
              unique_strikes: Number(r.unique_strikes),
              expirations: Number(r.expirations),
              strike_min: sMin,
              strike_max: sMax,
              strike_width_pct: spot > 0 ? +((halfWidth / spot) * 100).toFixed(1) : 0,
            };
          });
        });
      } catch {
        return [];
      }
    },

    async getExpirations(symbol, date) {
      const uri = chainsGlob(symbol);
      try {
        const rows = await withDb(async (db) =>
          allAsync<{ expiration: unknown }>(
            db,
            `SELECT DISTINCT expiration FROM read_parquet('${escape(uri)}')
             WHERE date = '${escape(date)}' ORDER BY expiration`,
          ),
        );
        return rows.map((r) => asDateString(r.expiration));
      } catch {
        return [];
      }
    },

    async getUnderlyingPrice(symbol, date) {
      const uri = chainsGlob(symbol);
      try {
        const rows = await withDb(async (db) =>
          allAsync<{ underlyingPrice: number | null }>(
            db,
            `SELECT underlyingPrice FROM read_parquet('${escape(uri)}')
             WHERE date = '${escape(date)}' LIMIT 1`,
          ),
        );
        return rows[0]?.underlyingPrice ?? null;
      } catch {
        return null;
      }
    },

    close() {
      // No-op — withDb manages per-call DuckDB lifecycle.
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

interface RawChainRow {
  date: unknown;
  underlying: string;
  underlyingPrice: number;
  expiration: unknown;
  side: string;
  strike: number;
  dte: number;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number | bigint;
  openInterest: number | bigint;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

interface RawSummaryRow {
  symbol: string;
  date_min: unknown;
  date_max: unknown;
  trading_days: number | bigint;
  total_rows: number | bigint;
  price_min: number;
  price_max: number;
  files: number | bigint;
}

interface RawDetailRow {
  date: unknown;
  underlyingPrice: number;
  contracts: number | bigint;
  unique_strikes: number | bigint;
  expirations: number | bigint;
  strike_min: number;
  strike_max: number;
}

function toChainContract(r: RawChainRow): ChainContract {
  const expiration = asDateString(r.expiration);
  const inTheMoney =
    r.side === "call" ? r.strike < r.underlyingPrice : r.strike > r.underlyingPrice;
  return {
    symbol: `${r.underlying} ${expiration} ${r.strike} ${r.side === "call" ? "C" : "P"}`,
    underlying: r.underlying,
    expiration,
    side: r.side,
    strike: r.strike,
    dte: r.dte,
    bid: r.bid,
    ask: r.ask,
    mid: r.mid,
    last: r.last,
    volume: Number(r.volume),
    openInterest: Number(r.openInterest),
    underlyingPrice: r.underlyingPrice,
    inTheMoney,
    iv: r.iv,
    delta: r.delta,
    gamma: r.gamma,
    theta: r.theta,
    vega: r.vega,
  };
}

/**
 * Heuristic: a glob URI "exists" (has any matching file). For file:// URIs
 * we glob the local filesystem directly (cheap). For s3:// we let DuckDB
 * try to read one row — succeeds when at least one parquet matches the glob.
 *
 * Used by hasData to short-circuit when a symbol has no data on disk.
 */
async function globMaybeExists(uri: string): Promise<boolean> {
  if (uri.startsWith("file://") || (!uri.includes("://") && uri.startsWith("/"))) {
    return existsInLocalDir(uri);
  }
  try {
    await withDb(async (db) =>
      allAsync(db, `SELECT 1 FROM read_parquet('${escape(uri)}') LIMIT 1`),
    );
    return true;
  } catch {
    return false;
  }
}

function existsInLocalDir(uri: string): Promise<boolean> {
  // Parquet glob like /path/data/chains/SPY-*.parquet — check if any file matches.
  return import("node:fs").then(({ readdirSync, existsSync }) => {
    const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash < 0) return false;
    const dir = path.slice(0, lastSlash);
    const pattern = path.slice(lastSlash + 1);
    if (!existsSync(dir)) return false;
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return readdirSync(dir).some((f) => re.test(f));
  });
}

// Re-export helpers used by callers (parquet plumbing fan-out).
export { exists, joinUri, registerRows, withDb };
