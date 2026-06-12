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
// Position shapes + the categorization parser live in the shared
// module (QF-272) so the NT bridge path and this REST path produce
// identical /api/positions output. Re-exported here for back-compat
// with existing importers.

import {
  parseSchwabAccountSnapshot,
  type EquityPosition,
  type FuturesPosition,
  type OptionPosition,
  type SchwabPositions,
} from "../positions/parse-schwab-positions.js";

export type { EquityPosition, FuturesPosition, OptionPosition, SchwabPositions };

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
    const result = parseSchwabAccountSnapshot(accountData);
    allOptions.push(...result.options);
    allEquities.push(...result.equities);
    allFutures.push(...result.futures);
  }

  return { options: allOptions, equities: allEquities, futures: allFutures };
}
