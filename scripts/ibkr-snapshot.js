#!/usr/bin/env node
// ── IBKR Daily Chain Snapshot ────────────────────────────────────────────
// Connects to IB Gateway, snapshots chains for configured instruments,
// and appends to monthly Parquet files for backtesting.
//
// Usage:
//   node scripts/ibkr-snapshot.js
//   node scripts/ibkr-snapshot.js --symbols CL,ES
//
// Designed for cron: 30 17 * * 1-5 node /path/to/ibkr-snapshot.js
//
// Environment variables:
//   IBKR_HOST       (default: 127.0.0.1)
//   IBKR_PORT       (default: 4002)
//   IBKR_CLIENT_ID  (default: 1)   ← different from bridge default to avoid conflicts

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "@stoqey/ib";
import duckdb from "duckdb";

const { IBApi, EventName, TickType, SecType, OptionType } = pkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data", "chains");

// ── Config ───────────────────────────────────────────────────────────────

const IBKR_HOST = process.env.IBKR_HOST || "127.0.0.1";
const IBKR_PORT = parseInt(process.env.IBKR_PORT || "4002", 10);
const IBKR_CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || "1", 10);
const REQUEST_TIMEOUT = 15000;
const CHAIN_TIMEOUT = 60000;
const BATCH_SIZE = 50;

const DEFAULT_SYMBOLS = ["CL", "ES"];

const EXCHANGE_MAP = {
  CL: "NYMEX",
  RB: "NYMEX",
  NG: "NYMEX",
  HO: "NYMEX",
  ES: "CME",
  NQ: "CME",
  RTY: "CME",
  "6E": "CME",
  YM: "CBOT",
  ZB: "CBOT",
  ZN: "CBOT",
  ZC: "CBOT",
  ZS: "CBOT",
  ZW: "CBOT",
  GC: "COMEX",
  SI: "COMEX",
  HG: "COMEX",
};

// ── IB Connection ────────────────────────────────────────────────────────

let ib;
let connected = false;
let nextReqId = 5000;

function getReqId() {
  return nextReqId++;
}

function connect() {
  return new Promise((resolve, reject) => {
    ib = new IBApi({ host: IBKR_HOST, port: IBKR_PORT });

    const timeout = setTimeout(() => {
      reject(new Error(`Connection timeout — is IB Gateway running on ${IBKR_HOST}:${IBKR_PORT}?`));
    }, 10000);

    ib.on(EventName.connected, () => {
      connected = true;
      clearTimeout(timeout);
      resolve();
    });

    ib.on(EventName.error, (err, code) => {
      if (code === -1 || [2104, 2106, 2158].includes(code)) return;
      console.error(`  [IB error] code=${code}: ${err.message}`);
    });

    ib.connect(IBKR_CLIENT_ID);
  });
}

// ── Contract resolution (same logic as bridge) ──────────────────────────

function resolveContract(symbol) {
  return new Promise((resolve, reject) => {
    const root = symbol.replace(/^[./]+/, "");
    const exchange = EXCHANGE_MAP[root] || "NYMEX";
    const contract = { symbol: root, secType: SecType.FUT, exchange, currency: "USD" };

    const reqId = getReqId();
    const details = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Contract timeout: ${symbol}`));
    }, REQUEST_TIMEOUT);

    function onDetails(_id, detail) {
      if (_id === reqId) details.push(detail);
    }
    function onEnd(_id) {
      if (_id !== reqId) return;
      cleanup();
      if (!details.length) {
        reject(new Error(`No contract found: ${symbol}`));
        return;
      }
      const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const future = details
        .filter((d) => (d.contract.lastTradeDateOrContractMonth || "") >= now)
        .sort((a, b) =>
          (a.contract.lastTradeDateOrContractMonth || "").localeCompare(
            b.contract.lastTradeDateOrContractMonth || "",
          ),
        );
      resolve(future[0] || details[0]);
    }
    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
    }

    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, contract);
  });
}

// ── Snapshot market data ─────────────────────────────────────────────────

function requestSnapshot(contract, timeoutMs = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const reqId = getReqId();
    const ticks = { bid: 0, ask: 0, last: 0, volume: 0 };
    const greeks = { iv: null, delta: null, gamma: null, theta: null, vega: null, undPrice: null };
    let gotData = false;

    const timer = setTimeout(() => {
      cleanup();
      if (gotData) resolve({ ticks, greeks });
      else reject(new Error("Snapshot timeout"));
    }, timeoutMs);

    function onTickPrice(_id, type, value) {
      if (_id !== reqId || value === -1) return;
      gotData = true;
      if (type === TickType.BID) ticks.bid = value;
      else if (type === TickType.ASK) ticks.ask = value;
      else if (type === TickType.LAST) ticks.last = value;
    }
    function onTickSize(_id, type, value) {
      if (_id !== reqId || value === -1) return;
      gotData = true;
      if (type === TickType.VOLUME) ticks.volume = value;
    }
    function onTickOption(_id, type, _ta, iv, delta, _op, _pv, gamma, vega, theta, undPrice) {
      if (_id !== reqId) return;
      gotData = true;
      if (iv > 0 && iv < 10) greeks.iv = iv;
      if (delta > -2 && delta < 2) greeks.delta = delta;
      if (gamma >= 0) greeks.gamma = gamma;
      if (theta !== undefined) greeks.theta = theta;
      if (vega !== undefined) greeks.vega = vega;
      if (undPrice > 0) greeks.undPrice = undPrice;
    }
    function onSnapshotEnd(_id) {
      if (_id === reqId) {
        cleanup();
        resolve({ ticks, greeks });
      }
    }
    function onError(err, code, _id) {
      if (_id === reqId) {
        cleanup();
        reject(new Error(`IB error ${code}: ${err.message}`));
      }
    }
    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.tickPrice, onTickPrice);
      ib.off(EventName.tickSize, onTickSize);
      ib.off(EventName.tickOptionComputation, onTickOption);
      ib.off(EventName.tickSnapshotEnd, onSnapshotEnd);
      ib.off(EventName.error, onError);
      try {
        ib.cancelMktData(reqId);
      } catch {}
    }

    ib.on(EventName.tickPrice, onTickPrice);
    ib.on(EventName.tickSize, onTickSize);
    ib.on(EventName.tickOptionComputation, onTickOption);
    ib.on(EventName.tickSnapshotEnd, onSnapshotEnd);
    ib.on(EventName.error, onError);
    ib.reqMktData(reqId, contract, "106", true, false);
  });
}

// ── Option params ────────────────────────────────────────────────────────

function requestOptionParams(root, conId) {
  return new Promise((resolve, reject) => {
    const reqId = getReqId();
    const results = [];
    const timer = setTimeout(() => {
      cleanup();
      results.length ? resolve(results) : reject(new Error("Option params timeout"));
    }, REQUEST_TIMEOUT);

    function onParam(_id, exchange, _uc, tradingClass, multiplier, expirations, strikes) {
      if (_id === reqId)
        results.push({
          exchange,
          tradingClass,
          multiplier,
          expirations: [...expirations],
          strikes: [...strikes],
        });
    }
    function onEnd(_id) {
      if (_id === reqId) {
        cleanup();
        resolve(results);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.securityDefinitionOptionParameter, onParam);
      ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
    }

    ib.on(EventName.securityDefinitionOptionParameter, onParam);
    ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
    ib.reqSecDefOptParams(reqId, root, EXCHANGE_MAP[root] || "NYMEX", SecType.FUT, conId);
  });
}

// ── Date/helpers ─────────────────────────────────────────────────────────

function ibDateToIso(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
function daysUntil(iso) {
  return Math.max(0, Math.ceil((new Date(iso + "T00:00:00Z") - new Date()) / 86400000));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── DuckDB Parquet writer ────────────────────────────────────────────────

function openDb() {
  return new Promise((res, rej) => {
    const db = new duckdb.Database(":memory:", (err) => (err ? rej(err) : res(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((res, rej) => {
    db.run(sql, ...params, (err) => (err ? rej(err) : res()));
  });
}

async function writeParquet(db, contracts, symbol, date) {
  const month = date.slice(0, 7);
  const file = resolve(DATA_DIR, `${symbol}-${month}.parquet`);

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS snap (
    date DATE, underlying VARCHAR, underlyingPrice DOUBLE, expiration DATE,
    side VARCHAR, strike DOUBLE, dte INTEGER, bid DOUBLE, ask DOUBLE,
    mid DOUBLE, last DOUBLE, volume INTEGER, openInterest INTEGER,
    iv DOUBLE, delta DOUBLE, gamma DOUBLE, theta DOUBLE, vega DOUBLE, source VARCHAR
  )`,
  );

  // Load existing parquet if present (dedup by date)
  if (existsSync(file)) {
    await run(db, `INSERT INTO snap SELECT * FROM read_parquet('${file}') WHERE date != '${date}'`);
  }

  const stmt = await new Promise((res, rej) => {
    const s = db.prepare(
      "INSERT INTO snap VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      (err) => (err ? rej(err) : res(s)),
    );
  });

  for (const c of contracts) {
    await new Promise((res, rej) => {
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
        c.volume,
        0,
        c.iv,
        c.delta,
        c.gamma,
        c.theta,
        c.vega,
        "ibkr",
        (err) => (err ? rej(err) : res()),
      );
    });
  }
  await new Promise((res, rej) => {
    stmt.finalize((err) => (err ? rej(err) : res()));
  });

  await run(
    db,
    `COPY (SELECT * FROM snap ORDER BY date, expiration, strike, side) TO '${file}' (FORMAT PARQUET, OVERWRITE)`,
  );
  await run(db, "DROP TABLE snap");

  return file;
}

// ── Snapshot one instrument ──────────────────────────────────────────────

async function snapshotInstrument(db, symbol) {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n── ${symbol} ──`);

  // 1. Resolve front-month futures contract
  const detail = await resolveContract(symbol);
  const contract = detail.contract;
  console.log(
    `  Contract: ${contract.symbol} ${contract.lastTradeDateOrContractMonth} (conId=${contract.conId})`,
  );

  // 2. Get underlying quote
  const { ticks: undTicks } = await requestSnapshot(contract);
  const underlyingPrice = undTicks.last || undTicks.bid;
  if (!underlyingPrice) {
    console.log("  No underlying price — skipping");
    return 0;
  }
  console.log(`  Price: ${underlyingPrice}`);

  // 3. Get expirations and strikes
  const params = await requestOptionParams(contract.symbol, contract.conId);
  if (!params.length) {
    console.log("  No option params — skipping");
    return 0;
  }

  const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const allExps = new Set();
  for (const p of params) {
    for (const exp of p.expirations) {
      if (exp >= now) allExps.add(exp);
    }
  }
  const expirations = [...allExps].sort().slice(0, 12); // limit to nearest 12 expirations
  console.log(`  ${expirations.length} expirations`);

  // 4. Fetch chains for each expiration
  const allContracts = [];

  for (const expIb of expirations) {
    const expIso = ibDateToIso(expIb);
    const dte = daysUntil(expIso);

    // Get strikes for this expiration
    let strikes = new Set();
    let tradingClass = contract.symbol;
    for (const p of params) {
      if (p.expirations.includes(expIb)) {
        for (const s of p.strikes) strikes.add(s);
        tradingClass = p.tradingClass || tradingClass;
      }
    }

    // Filter to ±30 strikes from ATM
    let sortedStrikes = [...strikes].sort((a, b) => a - b);
    let atmIdx = 0,
      minDist = Infinity;
    for (let i = 0; i < sortedStrikes.length; i++) {
      const dist = Math.abs(sortedStrikes[i] - underlyingPrice);
      if (dist < minDist) {
        minDist = dist;
        atmIdx = i;
      }
    }
    sortedStrikes = sortedStrikes.slice(Math.max(0, atmIdx - 30), atmIdx + 31);

    // Build option contracts
    const optContracts = [];
    for (const strike of sortedStrikes) {
      for (const right of [OptionType.Call, OptionType.Put]) {
        optContracts.push({
          ibContract: {
            symbol: contract.symbol,
            secType: SecType.FOP,
            exchange: contract.exchange,
            currency: "USD",
            lastTradeDateOrContractMonth: expIb,
            strike,
            right,
            tradingClass,
          },
          strike,
          side: right === OptionType.Call ? "call" : "put",
          expIso,
          dte,
        });
      }
    }

    // Batch snapshot
    process.stdout.write(`  ${expIso} (${sortedStrikes.length} strikes): `);
    let fetched = 0;

    for (let i = 0; i < optContracts.length; i += BATCH_SIZE) {
      const batch = optContracts.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((o) =>
          requestSnapshot(o.ibContract, CHAIN_TIMEOUT).then((snap) => ({ ...o, snap })),
        ),
      );

      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const o = r.value;
        allContracts.push({
          underlying: contract.symbol,
          underlyingPrice,
          expiration: o.expIso,
          side: o.side,
          strike: o.strike,
          dte: o.dte,
          bid: o.snap.ticks.bid,
          ask: o.snap.ticks.ask,
          mid:
            o.snap.ticks.bid && o.snap.ticks.ask
              ? (o.snap.ticks.bid + o.snap.ticks.ask) / 2
              : o.snap.ticks.last || 0,
          last: o.snap.ticks.last,
          volume: o.snap.ticks.volume,
          iv: o.snap.greeks.iv,
          delta: o.snap.greeks.delta,
          gamma: o.snap.greeks.gamma,
          theta: o.snap.greeks.theta,
          vega: o.snap.greeks.vega,
        });
        fetched++;
      }

      if (i + BATCH_SIZE < optContracts.length) await sleep(200);
    }
    console.log(`${fetched} contracts`);
  }

  // 5. Write to Parquet
  if (allContracts.length) {
    const file = await writeParquet(db, allContracts, symbol, today);
    console.log(`  → ${allContracts.length} contracts written to ${file}`);
  }

  return allContracts.length;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let symbols = DEFAULT_SYMBOLS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbols") symbols = args[++i].split(",");
  }

  console.log("IBKR Daily Chain Snapshot");
  console.log(`  Gateway: ${IBKR_HOST}:${IBKR_PORT} (clientId=${IBKR_CLIENT_ID})`);
  console.log(`  Instruments: ${symbols.join(", ")}`);
  console.log(`  Output: ${DATA_DIR}/`);

  await connect();
  console.log(`✓ Connected to IB Gateway`);

  const db = await openDb();
  let total = 0;

  for (const sym of symbols) {
    try {
      total += await snapshotInstrument(db, sym);
    } catch (e) {
      console.error(`  ERROR on ${sym}: ${e.message}`);
    }
  }

  console.log(`\nDone! ${total} total contracts snapshotted.`);
  db.close();
  ib.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
