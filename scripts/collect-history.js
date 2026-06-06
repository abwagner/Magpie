#!/usr/bin/env node
// ── Historical Options Data Collection ───────────────────────────────────
// Fetches historical option chains from MarketData.app, computes IV/Greeks
// via bisection, and writes Parquet files for backtesting.
//
// Usage:
//   node scripts/collect-history.js --symbol SPY --from 2024-01-02 --to 2024-12-31 --token <md_token>
//   node scripts/collect-history.js --symbol SPY --from 2024-01-02 --to 2024-12-31 --resume
//
// Output: data/chains/SPY-2024-01.parquet, SPY-2024-02.parquet, ...
//
// Environment variables:
//   MD_TOKEN  — MarketData.app API token (alternative to --token)
//   RFR       — Risk-free rate for IV computation (default: 0.05)
//   DELAY_MS  — Delay between API requests in ms (default: 200)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import duckdb from "duckdb";
import {
  rawHistoricalChain as historicalChain,
  getLastCredits,
} from "../src/lib/marketdata-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data", "chains");
const MANIFEST_PATH = resolve(DATA_DIR, ".manifest.json");

// ── Args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbol") opts.symbol = args[++i];
    else if (args[i] === "--from") opts.from = args[++i];
    else if (args[i] === "--to") opts.to = args[++i];
    else if (args[i] === "--token") opts.token = args[++i];
    else if (args[i] === "--resume") opts.resume = true;
    else if (args[i] === "--strikeLimit") opts.strikeLimit = parseInt(args[++i], 10);
  }
  opts.token = opts.token || process.env.MD_TOKEN;
  opts.rfr = parseFloat(process.env.RFR || "0.05");
  opts.delay = parseInt(process.env.DELAY_MS || "0", 10);
  opts.strikeLimit = opts.strikeLimit || 50;
  return opts;
}

// ── Manifest (resume support) ────────────────────────────────────────────

function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ── Date helpers ─────────────────────────────────────────────────────────

function tradingDays(from, to) {
  const days = [];
  const d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      // skip weekends
      days.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function monthKey(date) {
  return date.slice(0, 7); // "2024-01-15" → "2024-01"
}

// ── DuckDB Parquet writer ────────────────────────────────────────────────

function createDb() {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(":memory:", (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, ...params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function initTable(db) {
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS chains (
      date DATE,
      underlying VARCHAR,
      underlyingPrice DOUBLE,
      expiration DATE,
      side VARCHAR,
      strike DOUBLE,
      dte INTEGER,
      bid DOUBLE,
      ask DOUBLE,
      mid DOUBLE,
      last DOUBLE,
      volume INTEGER,
      openInterest INTEGER,
      iv DOUBLE,
      delta DOUBLE,
      gamma DOUBLE,
      theta DOUBLE,
      vega DOUBLE,
      source VARCHAR
    )
  `,
  );
}

async function insertContracts(db, date, contracts) {
  const stmt = await new Promise((resolve, reject) => {
    const s = db.prepare(
      `INSERT INTO chains VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      (err) => {
        if (err) reject(err);
        else resolve(s);
      },
    );
  });

  for (const c of contracts) {
    await new Promise((resolve, reject) => {
      stmt.run(
        date,
        c.underlying,
        c.underlyingPrice,
        c.expiration,
        c.side,
        c.strike,
        c.dte,
        c.bid,
        c.ask,
        c.mid,
        c.last,
        c.volume || 0,
        c.openInterest || 0,
        c.iv,
        c.delta,
        c.gamma,
        c.theta,
        c.vega,
        "marketdata",
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }

  await new Promise((resolve, reject) => {
    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function flushToParquet(db, symbol, month) {
  const file = resolve(DATA_DIR, `${symbol}-${month}.parquet`);
  // If file exists, read it into the table first so we append
  if (existsSync(file)) {
    await run(
      db,
      `INSERT INTO chains SELECT * FROM read_parquet('${file}') WHERE date NOT IN (SELECT DISTINCT date FROM chains)`,
    );
  }
  await run(
    db,
    `COPY (SELECT * FROM chains ORDER BY date, expiration, strike, side) TO '${file}' (FORMAT PARQUET, OVERWRITE)`,
  );
  await run(db, `DELETE FROM chains`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  if (!opts.symbol || !opts.from || !opts.to || !opts.token) {
    console.log(
      "Usage: node scripts/collect-history.js --symbol SPY --from 2024-01-02 --to 2024-12-31 --token <token>",
    );
    console.log("  or set MD_TOKEN environment variable");
    process.exit(1);
  }

  const { symbol, from, to, token, rfr, delay, strikeLimit, resume } = opts;
  console.log(`\nCollecting historical chains for ${symbol}`);
  console.log(`  Range: ${from} → ${to}`);
  console.log(
    `  Strike limit: ${strikeLimit}, RFR: ${rfr}${delay > 0 ? `, Delay: ${delay}ms` : ""}`,
  );
  console.log(`  Output: ${DATA_DIR}/${symbol}-YYYY-MM.parquet\n`);

  const manifest = loadManifest();
  let startDate = from;
  if (resume && manifest[symbol]?.lastDate) {
    // Resume from the day after the last completed date
    const last = new Date(manifest[symbol].lastDate + "T12:00:00Z");
    last.setUTCDate(last.getUTCDate() + 1);
    startDate = last.toISOString().slice(0, 10);
    if (startDate > to) {
      console.log(`Already complete through ${manifest[symbol].lastDate}`);
      process.exit(0);
    }
    console.log(`  Resuming from ${startDate} (last completed: ${manifest[symbol].lastDate})\n`);
  }

  const allDays = tradingDays(startDate, to);

  const db = await createDb();
  await initTable(db);

  // Scan existing parquet files to skip dates we already have
  const existingDates = new Set();
  try {
    const glob = resolve(DATA_DIR, `${symbol}-*.parquet`);
    const files = (await import("node:fs"))
      .readdirSync(DATA_DIR)
      .filter((f) => f.startsWith(`${symbol}-`) && f.endsWith(".parquet"));
    if (files.length > 0) {
      const rows = await new Promise((resolve, reject) => {
        db.all(`SELECT DISTINCT date FROM read_parquet('${glob}')`, (err, rows) => {
          if (err) reject(err);
          else resolve(rows ?? []);
        });
      });
      for (const r of rows) {
        const d = typeof r.date === "string" ? r.date : r.date.toISOString().slice(0, 10);
        existingDates.add(d);
      }
    }
  } catch {
    /* no existing data — collect everything */
  }

  const days = allDays.filter((d) => !existingDates.has(d));
  const skipped = allDays.length - days.length;
  console.log(
    `  ${allDays.length} trading days in range${skipped > 0 ? ` (${skipped} already stored, ${days.length} to fetch)` : ""}\n`,
  );

  let totalContracts = 0;
  let totalCreditsConsumed = 0;
  let creditsRemaining = null;
  let currentMonth = null;

  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    const month = monthKey(date);

    // Flush when month changes
    if (currentMonth && month !== currentMonth) {
      await flushToParquet(db, symbol, currentMonth);
      console.log(`  → Wrote ${symbol}-${currentMonth}.parquet\n`);
    }
    currentMonth = month;

    process.stdout.write(`  [${i + 1}/${days.length}] ${date} ... `);

    try {
      // Fetch all expirations for this historical date in a single call
      // (passing null expiration fetches all available expirations)
      let dayContracts = 0;
      try {
        const contracts = await historicalChain(symbol, date, null, token, strikeLimit, rfr);
        if (contracts.length) {
          await insertContracts(db, date, contracts);
          dayContracts = contracts.length;
        }
        const credits = getLastCredits();
        totalCreditsConsumed += credits.consumed;
        creditsRemaining = credits.remaining;
        if (delay > 0) await sleep(delay);
      } catch (e) {
        if (e.status === 429) {
          console.log("\n  Rate limited — stopping. Resume with --resume tomorrow.");
          break;
        }
        console.warn(`\n    ${date}: ${e.message}`);
      }

      totalContracts += dayContracts;
      const remainStr =
        creditsRemaining != null ? ` [${creditsRemaining.toLocaleString()} remaining]` : "";
      console.log(`${dayContracts} contracts (${totalCreditsConsumed} credits used${remainStr})`);

      // Update manifest
      manifest[symbol] = { lastDate: date, totalContracts, totalCredits: totalCreditsConsumed };
      saveManifest(manifest);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      if (e.status === 429) {
        console.log("  Rate limited — stopping. Resume with --resume tomorrow.");
        break;
      }
    }
  }

  // Flush remaining data
  if (currentMonth) {
    await flushToParquet(db, symbol, currentMonth);
    console.log(`  → Wrote ${symbol}-${currentMonth}.parquet`);
  }

  console.log(`\nDone! ${totalContracts} contracts, ${totalCreditsConsumed} credits used.`);
  if (creditsRemaining != null) {
    console.log(`Credits remaining today: ${creditsRemaining.toLocaleString()}`);
  }
  db.close();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
