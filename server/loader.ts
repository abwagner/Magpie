// ── Background Data Loader ───────────────────────────────────────────────
// Fetches historical chain data in the background, triggered by API.
// Reuses data-sources.js for fetching and storage.js for persistence.

import * as dataSources from "./data-sources.js";
import type { Storage, StoreContract } from "./storage.js";
import type { MDContract } from "../src/lib/marketdata-api.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface LoadJob {
  running: boolean;
  symbol: string;
  from: string;
  to: string;
  progress: number;
  total: number;
  currentDate: string | null;
  contractsLoaded: number;
  errors: string[];
  cancelled: boolean;
}

export interface StartLoadParams {
  symbol: string;
  from: string;
  to: string;
  strikeLimit?: number;
  rfr?: number;
  delayMs?: number;
}

export interface StartLoadResult {
  started: boolean;
  totalDays: number;
}

export type LoadStatus = { running: false } | (LoadJob & { running: boolean });

interface StatusError extends Error {
  status?: number;
}

let loadJob: LoadJob | null = null;

function tradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

export function startLoad(
  storage: Storage,
  { symbol, from, to, strikeLimit = 50, rfr = 0.05, delayMs = 200 }: StartLoadParams,
): StartLoadResult {
  if (loadJob?.running) {
    throw new Error(`Load already in progress: ${loadJob.symbol}`);
  }

  const days = tradingDays(from, to);

  loadJob = {
    running: true,
    symbol,
    from,
    to,
    progress: 0,
    total: days.length,
    currentDate: null,
    contractsLoaded: 0,
    errors: [],
    cancelled: false,
  };

  // Run in background (don't await)
  runLoad(storage, days, symbol, strikeLimit, rfr, delayMs).catch((e: unknown) => {
    const message = (e as Error).message;
    console.error(`Load error: ${message}`);
    if (loadJob) {
      loadJob.running = false;
      loadJob.errors.push(message);
    }
  });

  return { started: true, totalDays: days.length };
}

async function runLoad(
  storage: Storage,
  days: string[],
  symbol: string,
  strikeLimit: number,
  rfr: number,
  delayMs: number,
): Promise<void> {
  for (let i = 0; i < days.length; i++) {
    if (!loadJob || loadJob.cancelled) {
      if (loadJob) loadJob.running = false;
      return;
    }

    const date = days[i] as string;
    loadJob.currentDate = date;
    loadJob.progress = i;

    try {
      // Check if we already have data for this date
      if (await storage.hasData(symbol, date)) {
        continue; // skip — already stored
      }

      // Fetch expirations for this date
      let exps: (string | null)[];
      try {
        exps = await dataSources.expirations(symbol);
      } catch {
        // If expirations fail, try fetching chain without specific expiration
        exps = [null];
      }
      await sleep(delayMs);

      // Fetch chain for each expiration
      const dayContracts: MDContract[] = [];
      for (const exp of exps) {
        try {
          const contracts = await dataSources.historicalChain(symbol, date, exp, strikeLimit, rfr);
          if (contracts.length) dayContracts.push(...contracts);
          await sleep(delayMs);
        } catch (e) {
          // Some expirations may not have data — skip silently
          if ((e as StatusError).status === 429) {
            loadJob.errors.push(`Rate limited on ${date}`);
            loadJob.running = false;
            return;
          }
        }
      }

      // Store in Parquet
      if (dayContracts.length) {
        // MDContract types numeric fields as nullable (vendor responses may
        // omit them); StoreContract requires them. Real chains populate them,
        // so this cast preserves the pre-migration (untyped .js) behavior
        // rather than adding runtime narrowing. See QF-343.
        await storage.storeChain(
          symbol,
          date,
          dayContracts as unknown as StoreContract[],
          "marketdata",
        );
        loadJob.contractsLoaded += dayContracts.length;
      }
    } catch (e) {
      loadJob.errors.push(`${date}: ${(e as Error).message}`);
    }
  }

  if (loadJob) {
    loadJob.progress = days.length;
    loadJob.running = false;
  }
}

export function getLoadStatus(): LoadStatus {
  if (!loadJob) return { running: false };
  return { ...loadJob };
}

export function cancelLoad(): { cancelled: boolean; message?: string } {
  if (loadJob?.running) {
    loadJob.cancelled = true;
    return { cancelled: true };
  }
  return { cancelled: false, message: "No load running" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
