// ── MarketData.app API Client ─────────────────────────────────────────────
// Bearer token auth. Works in both browser and Node.js (uses fetch).
// Supports real-time chains (with Greeks/IV) and historical chains
// (Greeks/IV computed via bisection IV solver).

import { BS } from "./bs.js";
import { isIndex } from "./symbols.js";

const BASE = "https://api.marketdata.app/v1";

// MarketData.app returns dates as Unix timestamps (seconds). Convert to YYYY-MM-DD.
function formatDate(val) {
  if (val == null) return null;
  if (typeof val === "string") return val; // already a string
  return new Date(val * 1000).toISOString().slice(0, 10);
}

// Credit tracking from response headers
let lastCredits = { consumed: 0, remaining: null, limit: null, reset: null };

function parseCredits(res) {
  const consumed = parseInt(res.headers.get("x-api-ratelimit-consumed") ?? "0", 10);
  const remaining = res.headers.get("x-api-ratelimit-remaining");
  const limit = res.headers.get("x-api-ratelimit-limit");
  const reset = res.headers.get("x-api-ratelimit-reset");
  lastCredits = {
    consumed,
    remaining: remaining != null ? parseInt(remaining, 10) : null,
    limit: limit != null ? parseInt(limit, 10) : null,
    reset: reset != null ? parseInt(reset, 10) : null,
  };
  return lastCredits;
}

export function getLastCredits() {
  return lastCredits;
}

// Server-side: log each MD request with credits. No-op in the browser.
const _isServer = typeof process !== "undefined" && process.versions?.node;

async function get(path, token) {
  const started = _isServer ? Date.now() : 0;
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  parseCredits(res);
  if (_isServer) {
    const ms = Date.now() - started;
    const c = lastCredits;
    process.stderr.write(
      `[marketdata] ${res.status} ${path.split("?")[0]}  ${ms}ms  credits=${c.remaining ?? "?"}/${c.limit ?? "?"}\n`,
    );
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.errmsg || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Parse MarketData.app's parallel-array response into contract objects
function parseChain(d) {
  if (d.s !== "ok") throw new Error(d.errmsg || "No chain data");
  const len = d.optionSymbol?.length || 0;
  const contracts = [];
  for (let i = 0; i < len; i++) {
    contracts.push({
      symbol: d.optionSymbol[i],
      underlying: d.underlying?.[i],
      expiration: formatDate(d.expiration?.[i]),
      side: d.side?.[i],
      strike: d.strike?.[i],
      dte: d.dte?.[i],
      bid: d.bid?.[i],
      bidSize: d.bidSize?.[i],
      ask: d.ask?.[i],
      askSize: d.askSize?.[i],
      mid: d.mid?.[i],
      last: d.last?.[i],
      volume: d.volume?.[i],
      openInterest: d.openInterest?.[i],
      underlyingPrice: d.underlyingPrice?.[i],
      inTheMoney: d.inTheMoney?.[i],
      iv: d.iv?.[i] ?? null,
      delta: d.delta?.[i] ?? null,
      gamma: d.gamma?.[i] ?? null,
      theta: d.theta?.[i] ?? null,
      vega: d.vega?.[i] ?? null,
    });
  }
  return contracts;
}

// Compute IV and Greeks for contracts missing them (historical data)
function fillGreeks(contracts, rfr = 0.05) {
  for (const c of contracts) {
    if (c.iv != null && c.iv > 0) continue; // already has IV
    const S = c.underlyingPrice;
    const K = c.strike;
    const T = (c.dte || 1) / 365;
    const price = c.mid || c.last;
    if (!S || !K || !price || price <= 0 || T <= 0) continue;

    const type = c.side === "call" ? "Call" : "Put";
    const iv = BS.impliedVol(S, K, rfr, T, price, type);
    if (iv == null) continue;

    c.iv = iv;
    c.delta = BS.delta(S, K, rfr, T, iv, type);
    c.gamma = BS.gamma(S, K, rfr, T, iv);
    c.theta = BS.theta(S, K, rfr, T, iv, type);
    c.vega = BS.vega(S, K, rfr, T, iv);
  }
  return contracts;
}

// MarketData.app splits equities and indices into different endpoints;
// route based on shared isIndex() classifier. Indices typically have
// bid/ask==0 and only `last` — adapter falls back accordingly.
export async function stockQuote(symbol, token) {
  const path = isIndex(symbol) ? `/indices/quotes/${symbol}/` : `/stocks/quotes/${symbol}/`;
  const d = await get(path, token);
  if (d.s !== "ok") throw new Error(d.errmsg || "No data");
  const last = d.last?.[0];
  return {
    last,
    bid: d.bid?.[0] ?? last,
    ask: d.ask?.[0] ?? last,
    mid: d.mid?.[0] ?? last,
    volume: d.volume?.[0] ?? 0,
  };
}

export async function expirations(symbol, token) {
  const d = await get(`/options/expirations/${symbol}/`, token);
  if (d.s !== "ok") throw new Error(d.errmsg || "No expirations");
  // MarketData.app returns ISO dates for equities ("2026-05-14") but descriptive
  // strings for futures ("May 14, 2026 (21 days) Weekly 1 /CLN26 (Thursday)").
  // Normalize to ISO dates.
  return (d.expirations || []).map(normalizeExpDate).filter(Boolean);
}

function normalizeExpDate(s) {
  if (!s) return null;
  // Already ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Parse "Month Day, Year ..." — extract just the date portion
  const m = s.match(/^([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const dt = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0, 10);
}

export async function chain(symbol, expiration, token, strikeLimit = 30) {
  const params = new URLSearchParams();
  if (expiration) params.set("expiration", expiration);
  if (strikeLimit) params.set("strikeLimit", strikeLimit);
  const d = await get(`/options/chain/${symbol}/?${params}`, token);
  return parseChain(d);
}

export async function historicalChain(
  symbol,
  date,
  expiration,
  token,
  strikeLimit = 30,
  rfr = 0.05,
) {
  const params = new URLSearchParams({ date });
  if (expiration) params.set("expiration", expiration);
  if (strikeLimit) params.set("strikeLimit", strikeLimit);
  const d = await get(`/options/chain/${symbol}/?${params}`, token);
  const contracts = parseChain(d);
  return fillGreeks(contracts, rfr);
}

// ── Token Storage (browser) ───────────────────────────────────────────────

const TOKEN_KEY = "marketdata-token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    // Node.js — no localStorage
    return process.env?.MD_TOKEN || "";
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function isConnected() {
  return !!getToken();
}

export function disconnect() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// ── Browser-compatible interface (matches schwab/ibkr shape) ─────────────
// These wrap the token-passing functions so data-source.js can call them
// without knowing about the token.

const md = {
  stockQuote: (symbol) => stockQuote(symbol, getToken()),
  expirations: (symbol) => expirations(symbol, getToken()),
  chain: (symbol, expiration, strikeLimit) => chain(symbol, expiration, getToken(), strikeLimit),
  isConnected,
  disconnect,
  getToken,
  setToken,
};

// Raw functions for Node.js scripts (pass token explicitly)
// Import as: import { marketdata } from './marketdata-api.js'
// Or for Node scripts: import { rawStockQuote, ... } from './marketdata-api.js'
export {
  stockQuote as rawStockQuote,
  expirations as rawExpirations,
  chain as rawChain,
  historicalChain as rawHistoricalChain,
};

export const marketdata = md;
