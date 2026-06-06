// ── Schwab REST (positions + accounts) ─────────────────────────────
// Trader API REST plumbing — account hash discovery, OAuth token
// refresh, and the position / account list endpoints. Consumed by
// server/market-data/api.ts for the GUI's positions view.
//
// QF-236 — the previous order-side createSchwabOrderAdapter() stub
// is removed; Schwab order submission flows through QF-233's NT
// bridge (server/order/adapters/nt-bridge.ts). This file is now
// REST-only; the name was kept under server/order/adapters/ to
// preserve git history, but conceptually it belongs to the
// market-data side.

// ── Types ──────────────────────────────────────────────────────────

export interface OptionPosition {
  symbol: string;
  underlying: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface EquityPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
}

export interface FuturesPosition {
  // Full contract symbol (e.g. "/CLM26"). Contract month is encoded
  // in the third character: F G H J K M N Q U V X Z.
  symbol: string;
  // Root (e.g. "/CL"). Useful for grouping all CL contract months.
  root: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
}

export interface SchwabPositions {
  options: OptionPosition[];
  equities: EquityPosition[];
  futures: FuturesPosition[];
}

// ── Auth (shared convention with market-data adapter) ─────────────

const TRADER_BASE = "https://api.schwabapi.com/trader/v1";

function schwabEnv(name: string): string | undefined {
  return process.env[name] ?? process.env[`VITE_${name}`];
}

interface TokenState {
  access_token: string;
  expires_at: number;
}

let tokenState: TokenState | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const appKey = schwabEnv("SCHWAB_APP_KEY");
  const appSecret = schwabEnv("SCHWAB_APP_SECRET");
  const refreshToken = schwabEnv("SCHWAB_REFRESH_TOKEN");
  if (!appKey || !appSecret || !refreshToken) return null;

  try {
    const credentials = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
    const res = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!res.ok) {
      process.stderr.write(`[schwab-trader] token refresh failed: HTTP ${res.status}\n`);
      return null;
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    tokenState = {
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  } catch (e) {
    process.stderr.write(
      `[schwab-trader] token refresh threw: ${String((e as Error).message ?? e)}\n`,
    );
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  if (tokenState && tokenState.expires_at > Date.now() + 60_000) return tokenState.access_token;
  return refreshAccessToken();
}

async function traderGet(path: string): Promise<unknown> {
  const token = await getAccessToken();
  if (!token) throw new Error("Schwab not authenticated");
  const res = await fetch(`${TRADER_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Schwab trader ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

// ── Account hash auto-discovery ───────────────────────────────────

let cachedAccountHash: string | null = null;

async function getAccountHash(): Promise<string> {
  if (cachedAccountHash) return cachedAccountHash;
  const data = (await traderGet("/accounts/accountNumbers")) as Array<{
    accountNumber: string;
    hashValue: string;
  }>;
  if (!data || data.length === 0) throw new Error("No Schwab accounts found");
  cachedAccountHash = data[0]!.hashValue;
  return cachedAccountHash;
}

// ── Position parsing ──────────────────────────────────────────────

function parseOccSymbol(
  occ: string,
): { underlying: string; expiration: string; side: "call" | "put"; strike: number } | null {
  // OCC format: "SPY   260425P00638000" → underlying=SPY, exp=2026-04-25, side=put, strike=638
  const trimmed = occ.trim();
  const match = trimmed.match(/^(\w+)\s+(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, underlying, dateStr, pc, strikeStr] = match;
  const yy = dateStr!.slice(0, 2);
  const mm = dateStr!.slice(2, 4);
  const dd = dateStr!.slice(4, 6);
  return {
    underlying: underlying!,
    expiration: `20${yy}-${mm}-${dd}`,
    side: pc === "C" ? "call" : "put",
    strike: parseInt(strikeStr!, 10) / 1000,
  };
}

function parseFuturesSymbol(symbol: string): string {
  // Schwab futures: "/CLM26" → "/CL", "./CLM26" → "/CL"
  const cleaned = symbol.replace(/^\./, "");
  const match = cleaned.match(/^(\/\w+)/);
  return match ? match[1]! : cleaned;
}

function parseFuturesOptionSymbol(inst: Record<string, unknown>): {
  underlying: string;
  expiration: string;
  side: "call" | "put";
  strike: number;
} {
  // Schwab futures options instrument fields:
  // symbol: "./CLM26 C85" or similar, putCall: "CALL"/"PUT",
  // strikePrice: 85, expirationDate: "2026-05-14"
  const symbol = (inst.symbol as string) ?? "";
  const underlying = parseFuturesSymbol(symbol.split(/\s/)[0] ?? symbol);
  const putCall = (inst.putCall as string) ?? "";
  const strike = (inst.strikePrice as number) ?? 0;
  const expDate = (inst.expirationDate as string) ?? "";
  // expirationDate may be ISO "2026-05-14T..." or "2026-05-14"
  const expiration = expDate.slice(0, 10);

  return {
    underlying,
    expiration,
    side: putCall.toUpperCase().startsWith("P") ? "put" : "call",
    strike,
  };
}

function parsePositions(accountData: unknown): SchwabPositions {
  const options: OptionPosition[] = [];
  const equities: EquityPosition[] = [];
  const futures: FuturesPosition[] = [];

  const raw = accountData as Record<string, unknown>;
  // Schwab may return under "securitiesAccount" or directly contain "positions"
  const acct = (raw.securitiesAccount ?? raw) as Record<string, unknown>;
  const positions = (acct?.positions ?? []) as Array<Record<string, unknown>>;

  for (const pos of positions) {
    const inst = pos.instrument as Record<string, unknown> | undefined;
    if (!inst) continue;

    const assetType = inst.assetType as string;
    const longQty = (pos.longQuantity as number) ?? 0;
    const shortQty = (pos.shortQuantity as number) ?? 0;
    const quantity = longQty - shortQty;
    const avgCost = (pos.averagePrice as number) ?? 0;
    const mktVal = (pos.marketValue as number) ?? 0;
    const dayPnl = (pos.currentDayProfitLoss as number) ?? 0;
    const isOptionLike = assetType === "OPTION" || assetType === "FUTURE_OPTION";
    const multiplier = isOptionLike ? 100 : 1;
    const unrealizedPnl = mktVal - avgCost * Math.abs(quantity) * multiplier;

    if (assetType === "OPTION") {
      const occSym = (inst.symbol as string) ?? "";
      const parsed = parseOccSymbol(occSym);
      const putCall = (inst.putCall as string) ?? "";

      options.push({
        symbol: occSym,
        underlying: parsed?.underlying ?? (inst.underlyingSymbol as string) ?? "",
        side: parsed?.side ?? (putCall.toLowerCase().startsWith("p") ? "put" : "call"),
        strike: parsed?.strike ?? 0,
        expiration: parsed?.expiration ?? "",
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
      });
    } else if (assetType === "FUTURE_OPTION") {
      const parsed = parseFuturesOptionSymbol(inst);

      options.push({
        symbol: (inst.symbol as string) ?? "",
        underlying: parsed.underlying,
        side: parsed.side,
        strike: parsed.strike,
        expiration: parsed.expiration,
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
      });
    } else if (assetType === "FUTURE") {
      const fullSymbol = (inst.symbol as string) ?? "";
      futures.push({
        symbol: fullSymbol,
        root: parseFuturesSymbol(fullSymbol),
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
      });
    } else {
      equities.push({
        symbol: (inst.symbol as string) ?? "",
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
      });
    }
  }

  return { options, equities, futures };
}

// ── Account listing ───────────────────────────────────────────────

export interface SchwabAccount {
  accountNumber: string;
  hashValue: string;
  type?: string;
}

export async function fetchSchwabAccounts(): Promise<SchwabAccount[]> {
  // Get account numbers + hashes
  const numbersData = (await traderGet("/accounts/accountNumbers")) as Array<{
    accountNumber: string;
    hashValue: string;
  }>;
  if (!Array.isArray(numbersData)) return [];

  // Enrich with account type from the bulk accounts endpoint
  try {
    const allAccounts = (await traderGet("/accounts")) as unknown[];
    const typeMap = new Map<string, string>();
    if (Array.isArray(allAccounts)) {
      for (const raw of allAccounts) {
        const acct = ((raw as Record<string, unknown>).securitiesAccount ?? raw) as Record<
          string,
          unknown
        >;
        const num = acct?.accountNumber as string;
        const type = acct?.type as string;
        if (num && type) typeMap.set(num, type);
      }
    }

    return numbersData.map((a) => ({
      ...a,
      type: typeMap.get(a.accountNumber),
    }));
  } catch {
    // Fall back to numbers-only if bulk fails
    return numbersData;
  }
}

// ── Exported positions fetcher (used by market-data API) ──────────

export async function fetchSchwabPositions(accountHash?: string): Promise<SchwabPositions> {
  let accounts: unknown[];

  if (accountHash) {
    // Fetch positions for a specific account
    const single = await traderGet(`/accounts/${accountHash}?fields=positions`);
    accounts = [single];
  } else {
    // Bulk: all accounts
    const all = (await traderGet("/accounts?fields=positions")) as unknown[];
    accounts = Array.isArray(all) ? all : [];
  }

  const allOptions: OptionPosition[] = [];
  const allEquities: EquityPosition[] = [];
  const allFutures: FuturesPosition[] = [];

  for (const accountData of accounts) {
    const raw = accountData as Record<string, unknown>;
    const acct = (raw.securitiesAccount ?? raw) as Record<string, unknown>;
    const positions = acct?.positions as unknown[];

    if (!positions || !Array.isArray(positions) || positions.length === 0) continue;

    const result = parsePositions(accountData);
    allOptions.push(...result.options);
    allEquities.push(...result.equities);
    allFutures.push(...result.futures);
  }

  return { options: allOptions, equities: allEquities, futures: allFutures };
}
