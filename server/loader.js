// ── Background Data Loader ───────────────────────────────────────────────
// Fetches historical chain data in the background, triggered by API.
// Reuses data-sources.js for fetching and storage.js for persistence.

import * as dataSources from "./data-sources.js";

let loadJob = null;

function tradingDays(from, to) {
  const days = [];
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
  storage,
  { symbol, from, to, strikeLimit = 50, rfr = 0.05, delayMs = 200 },
) {
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
  runLoad(storage, days, symbol, strikeLimit, rfr, delayMs).catch((e) => {
    console.error(`Load error: ${e.message}`);
    if (loadJob) {
      loadJob.running = false;
      loadJob.errors.push(e.message);
    }
  });

  return { started: true, totalDays: days.length };
}

async function runLoad(storage, days, symbol, strikeLimit, rfr, delayMs) {
  for (let i = 0; i < days.length; i++) {
    if (loadJob.cancelled) {
      loadJob.running = false;
      return;
    }

    const date = days[i];
    loadJob.currentDate = date;
    loadJob.progress = i;

    try {
      // Check if we already have data for this date
      if (await storage.hasData(symbol, date)) {
        continue; // skip — already stored
      }

      // Fetch expirations for this date
      let exps;
      try {
        exps = await dataSources.expirations(symbol);
      } catch {
        // If expirations fail, try fetching chain without specific expiration
        exps = [null];
      }
      await sleep(delayMs);

      // Fetch chain for each expiration
      let dayContracts = [];
      for (const exp of exps) {
        try {
          const contracts = await dataSources.historicalChain(symbol, date, exp, strikeLimit, rfr);
          if (contracts.length) dayContracts.push(...contracts);
          await sleep(delayMs);
        } catch (e) {
          // Some expirations may not have data — skip silently
          if (e.status === 429) {
            loadJob.errors.push(`Rate limited on ${date}`);
            loadJob.running = false;
            return;
          }
        }
      }

      // Store in Parquet
      if (dayContracts.length) {
        await storage.storeChain(symbol, date, dayContracts, "marketdata");
        loadJob.contractsLoaded += dayContracts.length;
      }
    } catch (e) {
      loadJob.errors.push(`${date}: ${e.message}`);
    }
  }

  loadJob.progress = days.length;
  loadJob.running = false;
}

export function getLoadStatus() {
  if (!loadJob) return { running: false };
  return { ...loadJob };
}

export function cancelLoad() {
  if (loadJob?.running) {
    loadJob.cancelled = true;
    return { cancelled: true };
  }
  return { cancelled: false, message: "No load running" };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
