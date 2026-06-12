// ── Server-Side Data Source Router ────────────────────────────────────────
// Tries data sources in order until one succeeds.
// All credentials from process.env — never sent to browser.

import {
  rawStockQuote as mdQuote,
  rawExpirations as mdExpirations,
  rawChain as mdChain,
  rawHistoricalChain as mdHistoricalChain,
} from "../src/lib/marketdata-api.js";
import type { MDContract, MDStockQuote } from "../src/lib/marketdata-api.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface DataSource {
  name: string;
  available: () => boolean;
  stockQuote?: (symbol: string) => Promise<MDStockQuote>;
  expirations?: (symbol: string) => Promise<string[]>;
  chain?: (
    symbol: string,
    expiration: string | null | undefined,
    strikeLimit: number,
  ) => Promise<MDContract[]>;
  historicalChain?: (
    symbol: string,
    date: string,
    expiration: string | null | undefined,
    strikeLimit: number,
    rfr: number,
  ) => Promise<MDContract[]>;
}

type SourceMethod = "stockQuote" | "expirations" | "chain" | "historicalChain";

export interface SourceStatus {
  name: string;
  key: string;
  available: boolean;
}

const MD_TOKEN = (): string => process.env.MD_TOKEN || "";

// Source implementations
const sources: Record<string, DataSource> = {
  marketdata: {
    name: "MarketData.app",
    available: () => !!MD_TOKEN(),
    stockQuote: (symbol) => mdQuote(symbol, MD_TOKEN()),
    expirations: (symbol) => mdExpirations(symbol, MD_TOKEN()),
    chain: (symbol, expiration, strikeLimit) => mdChain(symbol, expiration, MD_TOKEN(), strikeLimit),
    historicalChain: (symbol, date, expiration, strikeLimit, rfr) =>
      mdHistoricalChain(symbol, date, expiration, MD_TOKEN(), strikeLimit, rfr),
  },
  // Schwab and IBKR can be added here later when their server-side
  // clients are ready. For now, MarketData.app is the primary source.
};

const SOURCE_ORDER = ["marketdata"];

// Try sources in order until one succeeds
async function tryInOrder<T>(
  method: SourceMethod,
  ...args: unknown[]
): Promise<{ result: T; source: string }> {
  const errors: string[] = [];
  for (const key of SOURCE_ORDER) {
    const src = sources[key];
    const fn = src?.[method];
    if (!src?.available() || !fn) continue;
    try {
      const result = (await (fn as (...a: unknown[]) => Promise<T>)(...args)) as T;
      return { result, source: key };
    } catch (e) {
      errors.push(`${src.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`All sources failed: ${errors.join("; ") || "no sources configured"}`);
}

export async function stockQuote(symbol: string): Promise<MDStockQuote> {
  const { result } = await tryInOrder<MDStockQuote>("stockQuote", symbol);
  return result;
}

export async function expirations(symbol: string): Promise<string[]> {
  const { result } = await tryInOrder<string[]>("expirations", symbol);
  return result;
}

export async function chain(
  symbol: string,
  expiration: string | null | undefined,
  strikeLimit = 30,
): Promise<MDContract[]> {
  const { result } = await tryInOrder<MDContract[]>("chain", symbol, expiration, strikeLimit);
  return result;
}

export async function historicalChain(
  symbol: string,
  date: string,
  expiration: string | null | undefined,
  strikeLimit = 50,
  rfr = 0.05,
): Promise<MDContract[]> {
  const { result } = await tryInOrder<MDContract[]>(
    "historicalChain",
    symbol,
    date,
    expiration,
    strikeLimit,
    rfr,
  );
  return result;
}

export function getSourceStatus(): SourceStatus[] {
  return SOURCE_ORDER.map((key) => {
    const src = sources[key] as DataSource;
    return {
      name: src.name,
      key,
      available: src.available(),
    };
  });
}
