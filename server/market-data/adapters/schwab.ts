// ── Schwab Market Data Adapter ─────────────────────────────────────
// Promoted from scripts/schwab-spike.js into a real adapter.
// Defined in: docs/tdd/market-data.md, topic 3

import type {
  MarketDataAdapter,
  Quote,
  Contract,
  Candle,
  QuoteCallback,
  Subscription,
} from "../../../src/types/market-data.js";
import { isIndex, isFutures } from "../../../src/lib/symbols.js";
import { Black76 } from "../../../src/lib/bs.js";

// ── Types ──────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface SchwabConfig {
  timeout_ms?: number;
}

const MARKET_BASE = "https://api.schwabapi.com/marketdata/v1";

// ── Token Management ───────────────────────────────────────────────
// Schwab access tokens last ~30 min; refresh tokens last 7 days.
// Each access token refresh returns a NEW refresh token — we must
// persist it to .env so the 7-day window keeps rolling forward.
// (Same pattern as schwab-py: https://schwab-py.readthedocs.io/en/latest/auth.html)

interface TokenState {
  access_token: string;
  expires_at: number; // access token expiry (ms epoch)
  refresh_token_updated_at: number; // when we last received a new refresh token
}

const REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let tokenState: TokenState | null = null;

function persistRefreshToken(newToken: string): void {
  // Write the new refresh token back to .env so it survives restarts. The
  // weekly re-auth flow (scripts/schwab-auth.js) also writes .env; this
  // in-process rotation keeps the 7-day window rolling between re-auths.
  // Multi-machine deployments each run their own server with their own .env.
  try {
    const envPath = resolve(process.cwd(), ".env");
    const raw = readFileSync(envPath, "utf-8");
    const lines = raw.split("\n").map((line) => {
      if (line.startsWith("SCHWAB_REFRESH_TOKEN=")) return `SCHWAB_REFRESH_TOKEN=${newToken}`;
      return line;
    });
    writeFileSync(envPath, lines.join("\n"));
    process.env.SCHWAB_REFRESH_TOKEN = newToken;
  } catch (e) {
    process.stderr.write(
      `[schwab] failed to persist refresh token: ${String((e as Error).message ?? e)}\n`,
    );
  }
}

async function refreshAccessToken(): Promise<string | null> {
  const appKey = process.env.SCHWAB_APP_KEY;
  const appSecret = process.env.SCHWAB_APP_SECRET;
  const refreshToken = process.env.SCHWAB_REFRESH_TOKEN;

  if (!appKey || !appSecret || !refreshToken) {
    process.stderr.write(
      `[schwab] missing credentials — key=${!!appKey} secret=${!!appSecret} refresh=${!!refreshToken}\n`,
    );
    return null;
  }

  try {
    const credentials = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
    const res = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(
        `[schwab] token refresh failed: HTTP ${res.status} ${body.slice(0, 200)}\n`,
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const now = Date.now();
    tokenState = {
      access_token: data.access_token,
      expires_at: now + data.expires_in * 1000,
      refresh_token_updated_at: data.refresh_token
        ? now
        : (tokenState?.refresh_token_updated_at ?? now),
    };

    // Persist the new refresh token if Schwab returned one
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      persistRefreshToken(data.refresh_token);
      process.stderr.write(`[schwab] refresh token rotated and persisted to .env\n`);
    }

    return data.access_token;
  } catch (e) {
    process.stderr.write(`[schwab] token refresh threw: ${String((e as Error).message ?? e)}\n`);
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  if (tokenState && tokenState.expires_at > Date.now() + 60000) {
    return tokenState.access_token;
  }
  return refreshAccessToken();
}

/** Token expiry info for status reporting. */
export interface SchwabTokenStatus {
  available: boolean;
  access_token_expires_at: number | null;
  access_token_expires_in_s: number | null;
  refresh_token_expires_at: number | null;
  refresh_token_expires_in_s: number | null;
}

export function getTokenStatus(): SchwabTokenStatus {
  if (!tokenState) {
    return {
      available: false,
      access_token_expires_at: null,
      access_token_expires_in_s: null,
      refresh_token_expires_at: null,
      refresh_token_expires_in_s: null,
    };
  }
  const now = Date.now();
  const refreshExpiresAt = tokenState.refresh_token_updated_at + REFRESH_TOKEN_LIFETIME_MS;
  return {
    available: true,
    access_token_expires_at: tokenState.expires_at,
    access_token_expires_in_s: Math.round((tokenState.expires_at - now) / 1000),
    refresh_token_expires_at: refreshExpiresAt,
    refresh_token_expires_in_s: Math.round((refreshExpiresAt - now) / 1000),
  };
}

async function schwabGet(path: string): Promise<unknown> {
  const token = await getAccessToken();
  if (!token) throw new Error("No Schwab access token");

  const res = await fetch(`${MARKET_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Schwab API ${res.status}: ${await res.text().catch(() => "")}`);
  }

  return res.json();
}

// ── Schwab-specific symbol transforms ─────────────────────────────
// Schwab prefixes index tickers with `$` on the quotes endpoint and uses
// different roots for index options (e.g. VIX options are listed under
// VIXW). Classification comes from the shared isIndex() helper; the
// transforms below are Schwab's per-vendor conventions only.

function toSchwabQuoteSymbol(symbol: string): string {
  return isIndex(symbol) ? `$${symbol.toUpperCase()}` : symbol;
}

// Per-ticker overrides for option chain roots. Index options on Schwab
// typically use a weekly root — extend this map as new indices come up.
const OPTION_ROOT_OVERRIDES: Record<string, string> = {
  VIX: "VIXW",
};

function toSchwabOptionRoot(symbol: string): string {
  return OPTION_ROOT_OVERRIDES[symbol.toUpperCase()] ?? symbol;
}

// ── Futures option chain builder ─────────────────────────────────
// Schwab's /chains endpoint does NOT support futures (returns 400).
// But individual futures option quotes ARE available via /quotes using
// the format: ./{optionRoot}{monthCode}{YY}{C|P}{strike}
//
// Some products use a different option root than the futures root:
//   /CL → LO (light oil options), /NG → ON, etc.
// Most use the same root: /ES → ES, /NQ → NQ, /GC → GC.

const FUTURES_MONTH_CODES = "FGHJKMNQUVXZ";

const FUTURES_OPTION_ROOT: Record<string, string> = {
  CL: "LO",
  NG: "ON",
  HO: "OH",
  RB: "OB",
};

function futuresOptionRoot(futuresRoot: string): string {
  const root = futuresRoot
    .replace(/^\//, "")
    .replace(/[FGHJKMNQUVXZ]\d{2}$/i, "")
    .toUpperCase();
  return FUTURES_OPTION_ROOT[root] ?? root;
}

function futuresMonthCode(expirationDate: string, futuresSymbol: string): string | null {
  // If the user gave us a specific contract (e.g. /CLM26), extract the month code
  const contractMatch = futuresSymbol.replace(/^\//, "").match(/([FGHJKMNQUVXZ])(\d{2})$/i);
  if (contractMatch) {
    return contractMatch[1]!.toUpperCase() + contractMatch[2]!;
  }
  // Otherwise derive from the expiration date — find the nearest standard futures
  // month that expires on or after this date. Standard months for most energy:
  // every month (FGHJKMNQUVXZ). For simplicity, map expiration month to its code.
  const month = parseInt(expirationDate.slice(5, 7), 10); // 1-12
  const year = expirationDate.slice(2, 4); // "26"
  return FUTURES_MONTH_CODES[month - 1]! + year;
}

function generateFuturesOptionSymbols(
  optRoot: string,
  monthCode: string,
  strikes: number[],
): string[] {
  const syms: string[] = [];
  for (const strike of strikes) {
    // Format: ./{root}{monthCode}C{strike} — strike as integer or decimal
    const strikeStr = Number.isInteger(strike) ? String(strike) : strike.toFixed(2);
    syms.push(`./${optRoot}${monthCode}C${strikeStr}`);
    syms.push(`./${optRoot}${monthCode}P${strikeStr}`);
  }
  return syms;
}

async function batchQuoteFuturesOptions(
  symbols: string[],
  underlyingPrice: number,
  expiration: string,
  rfr: number = 0.05,
): Promise<Contract[]> {
  // Schwab /quotes supports up to ~200 symbols per call
  const contracts: Contract[] = [];
  const BATCH_SIZE = 100;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const param = batch.map((s) => encodeURIComponent(s)).join(",");

    try {
      const data = (await schwabGet(`/quotes?symbols=${param}&fields=quote,reference`)) as Record<
        string,
        Record<string, unknown>
      >;

      for (const [sym, entry] of Object.entries(data)) {
        if (sym === "errors" || !entry.assetMainType) continue;
        const q = (entry.quote ?? {}) as Record<string, number>;
        const ref = (entry.reference ?? {}) as Record<string, unknown>;
        const putCall = (ref.contractType as string) ?? (sym.includes("C") ? "C" : "P");
        const strike = (ref.strikePrice as number) ?? 0;
        const expMs = ref.expirationDate as number;
        const expStr = expMs ? new Date(expMs).toISOString().slice(0, 10) : expiration;
        const dte = Math.max(0, Math.round((new Date(expStr).getTime() - Date.now()) / 86400000));

        const bid = q.bidPrice ?? 0;
        const ask = q.askPrice ?? 0;
        const mid = (bid + ask) / 2;
        const side = putCall.toUpperCase() === "P" ? "put" : "call";
        const type = side === "call" ? "Call" : "Put";

        // Schwab doesn't return Greeks for futures options — compute via Black-76
        const T = dte / 365;
        let iv = 0;
        let delta = 0;
        let gamma = 0;
        let theta = 0;
        let vega = 0;

        if (T > 0 && mid > 0 && underlyingPrice > 0 && strike > 0) {
          const solvedIv = Black76.impliedVol(underlyingPrice, strike, rfr, T, mid, type);
          if (solvedIv && solvedIv > 0.001 && solvedIv < 5) {
            iv = solvedIv;
            delta = Black76.delta(underlyingPrice, strike, rfr, T, iv, type);
            gamma = Black76.gamma(underlyingPrice, strike, rfr, T, iv);
            theta = Black76.theta(underlyingPrice, strike, rfr, T, iv, type);
            vega = Black76.vega(underlyingPrice, strike, rfr, T, iv);
          }
        }

        contracts.push({
          symbol: sym,
          underlying: (ref.underlying as string) ?? "",
          expiration: expStr,
          side,
          strike,
          dte,
          bid,
          ask,
          mid,
          last: q.lastPrice ?? 0,
          volume: q.totalVolume ?? 0,
          openInterest: q.openInterest ?? 0,
          underlyingPrice,
          iv,
          delta,
          gamma,
          theta,
          vega,
        });
      }
    } catch {
      // Skip failed batches
    }
  }

  return contracts.sort((a, b) => a.strike - b.strike || (a.side === "call" ? -1 : 1));
}

// ── Factory ────────────────────────────────────────────────────────

export function createAdapter(config: SchwabConfig = {}): MarketDataAdapter {
  return {
    name: "schwab",

    async available(): Promise<boolean> {
      const appKey = process.env.SCHWAB_APP_KEY;
      const refreshToken = process.env.SCHWAB_REFRESH_TOKEN;
      if (!appKey || !refreshToken) return false;

      // Check token freshness
      const token = await getAccessToken();
      return token !== null;
    },

    async stockQuote(symbol: string): Promise<Quote | null> {
      try {
        const schwabSym = toSchwabQuoteSymbol(symbol);
        const data = (await schwabGet(
          `/quotes?symbols=${encodeURIComponent(schwabSym)}&fields=quote`,
        )) as Record<string, { quote: Record<string, number> }>;
        // Schwab may return a different key than requested (e.g. /ES → /ESM26).
        // Fall back to the first key in the response.
        const entry = data[schwabSym] ?? data[Object.keys(data)[0]!];
        const q = entry?.quote;
        if (!q) return null;

        return {
          symbol,
          bid: q.bidPrice ?? 0,
          ask: q.askPrice ?? 0,
          mid: ((q.bidPrice ?? 0) + (q.askPrice ?? 0)) / 2,
          last: q.lastPrice ?? 0,
          volume: q.totalVolume ?? 0,
          timestamp: new Date().toISOString(),
          _meta: {
            source: "schwab",
            source_timestamp: null,
            fetched_at: new Date().toISOString(),
            freshness_ms: null,
            latency_ms: 0,
            from_cache: false,
            cache_age_ms: 0,
            sources_tried: ["schwab"],
          },
        };
      } catch {
        return null;
      }
    },

    async expirations(symbol: string): Promise<string[] | null> {
      // Futures: strip contract month suffix (/CLM26 → /CL) since the
      // expirationchain endpoint only accepts the root
      let schwabSym: string;
      if (isFutures(symbol)) {
        schwabSym =
          "/" +
          symbol
            .slice(1)
            .replace(/[FGHJKMNQUVXZ]\d{2}$/i, "")
            .toUpperCase();
      } else {
        schwabSym = toSchwabOptionRoot(symbol);
      }
      try {
        const data = (await schwabGet(
          `/expirationchain?symbol=${encodeURIComponent(schwabSym)}`,
        )) as { expirationList?: Array<{ expirationDate: string }> };
        return data.expirationList?.map((e) => e.expirationDate) ?? null;
      } catch {
        return null;
      }
    },

    async chain(symbol: string, expiration: string): Promise<Contract[] | null> {
      if (isFutures(symbol)) {
        // Build a synthetic chain from individual futures option quotes
        try {
          // Get spot price from the futures quote
          const quote = await this.stockQuote(symbol);
          const spot = quote?.last ?? 0;
          if (spot === 0) return null;

          // Determine option root and month code
          const optRoot = futuresOptionRoot(symbol);
          const monthCode = futuresMonthCode(expiration, symbol);
          if (!monthCode) return null;

          // Generate strikes: $1 increments for energy, centered on spot
          const strikeStep = spot > 500 ? 25 : spot > 100 ? 5 : 1;
          const numStrikes = 25;
          const baseStrike = Math.round(spot / strikeStep) * strikeStep;
          const strikes: number[] = [];
          for (let i = -numStrikes; i <= numStrikes; i++) {
            strikes.push(baseStrike + i * strikeStep);
          }

          const syms = generateFuturesOptionSymbols(optRoot, monthCode, strikes);
          return await batchQuoteFuturesOptions(syms, spot, expiration);
        } catch {
          return null;
        }
      }

      const schwabSym = toSchwabOptionRoot(symbol);
      try {
        const data = (await schwabGet(
          `/chains?symbol=${encodeURIComponent(schwabSym)}&fromDate=${expiration}&toDate=${expiration}&strikeCount=50`,
        )) as {
          callExpDateMap?: Record<string, Record<string, Array<Record<string, unknown>>>>;
          putExpDateMap?: Record<string, Record<string, Array<Record<string, unknown>>>>;
          underlyingPrice?: number;
        };

        const contracts: Contract[] = [];
        const underlyingPrice = data.underlyingPrice ?? 0;

        for (const [side, expMap] of [
          ["call", data.callExpDateMap],
          ["put", data.putExpDateMap],
        ] as const) {
          if (!expMap) continue;
          for (const [, strikes] of Object.entries(expMap)) {
            for (const [, options] of Object.entries(strikes)) {
              for (const opt of options as Array<Record<string, unknown>>) {
                contracts.push({
                  symbol: String(opt.symbol ?? ""),
                  underlying: symbol,
                  expiration: String(opt.expirationDate ?? expiration).slice(0, 10),
                  side: side as "call" | "put",
                  strike: Number(opt.strikePrice ?? 0),
                  dte: Number(opt.daysToExpiration ?? 0),
                  bid: Number(opt.bid ?? 0),
                  ask: Number(opt.ask ?? 0),
                  mid: Number(opt.mark ?? 0),
                  last: Number(opt.last ?? 0),
                  volume: Number(opt.totalVolume ?? 0),
                  openInterest: Number(opt.openInterest ?? 0),
                  underlyingPrice,
                  iv: Number(opt.volatility ?? 0),
                  delta: Number(opt.delta ?? 0),
                  gamma: Number(opt.gamma ?? 0),
                  theta: Number(opt.theta ?? 0),
                  vega: Number(opt.vega ?? 0),
                });
              }
            }
          }
        }

        return contracts.length > 0 ? contracts : null;
      } catch {
        return null;
      }
    },

    async historicalChain(
      _symbol: string,
      _date: string,
      _expiration: string,
    ): Promise<Contract[] | null> {
      // Schwab doesn't support historical chain queries
      return null;
    },

    async candles(
      symbol: string,
      from: string,
      to: string,
      frequency: "daily" | "minute" = "daily",
    ): Promise<Candle[] | null> {
      try {
        const startMs = new Date(from).getTime();
        const endMs = new Date(to).getTime();
        const freqType = frequency === "minute" ? "minute" : "daily";
        const freq = 1;

        const data = (await schwabGet(
          `/pricehistory?symbol=${symbol}&periodType=year&frequencyType=${freqType}&frequency=${freq}&startDate=${startMs}&endDate=${endMs}`,
        )) as {
          candles?: Array<{
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
            datetime: number;
          }>;
        };

        if (!data.candles?.length) return null;

        return data.candles.map((c) => ({
          date:
            frequency === "daily"
              ? new Date(c.datetime).toISOString().slice(0, 10)
              : new Date(c.datetime).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));
      } catch {
        return null;
      }
    },

    subscribeQuotes(_symbols: string[], _callback: QuoteCallback): Subscription | null {
      // Schwab doesn't support streaming at v1
      return null;
    },
  };
}
