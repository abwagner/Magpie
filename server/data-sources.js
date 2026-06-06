// ── Server-Side Data Source Router ────────────────────────────────────────
// Tries data sources in order until one succeeds.
// All credentials from process.env — never sent to browser.

import {
  rawStockQuote as mdQuote,
  rawExpirations as mdExpirations,
  rawChain as mdChain,
  rawHistoricalChain as mdHistoricalChain,
} from "../src/lib/marketdata-api.js";

const MD_TOKEN = () => process.env.MD_TOKEN || "";

// Source implementations
const sources = {
  marketdata: {
    name: "MarketData.app",
    available: () => !!MD_TOKEN(),
    stockQuote: (symbol) => mdQuote(symbol, MD_TOKEN()),
    expirations: (symbol) => mdExpirations(symbol, MD_TOKEN()),
    chain: (symbol, expiration, strikeLimit) =>
      mdChain(symbol, expiration, MD_TOKEN(), strikeLimit),
    historicalChain: (symbol, date, expiration, strikeLimit, rfr) =>
      mdHistoricalChain(symbol, date, expiration, MD_TOKEN(), strikeLimit, rfr),
  },
  // Schwab and IBKR can be added here later when their server-side
  // clients are ready. For now, MarketData.app is the primary source.
};

const SOURCE_ORDER = ["marketdata"];

// Try sources in order until one succeeds
async function tryInOrder(method, ...args) {
  const errors = [];
  for (const key of SOURCE_ORDER) {
    const src = sources[key];
    if (!src?.available() || !src[method]) continue;
    try {
      const result = await src[method](...args);
      return { result, source: key };
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }
  throw new Error(`All sources failed: ${errors.join("; ") || "no sources configured"}`);
}

export async function stockQuote(symbol) {
  const { result } = await tryInOrder("stockQuote", symbol);
  return result;
}

export async function expirations(symbol) {
  const { result } = await tryInOrder("expirations", symbol);
  return result;
}

export async function chain(symbol, expiration, strikeLimit = 30) {
  const { result } = await tryInOrder("chain", symbol, expiration, strikeLimit);
  return result;
}

export async function historicalChain(symbol, date, expiration, strikeLimit = 50, rfr = 0.05) {
  const { result } = await tryInOrder(
    "historicalChain",
    symbol,
    date,
    expiration,
    strikeLimit,
    rfr,
  );
  return result;
}

export function getSourceStatus() {
  return SOURCE_ORDER.map((key) => ({
    name: sources[key].name,
    key,
    available: sources[key].available(),
  }));
}
