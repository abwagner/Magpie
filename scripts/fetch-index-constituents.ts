#!/usr/bin/env -S npx tsx
// ── Fetch iShares ETF Holdings → Universe Diff ────────────────────
// One-shot helper used to expand config/universe.txt with the
// constituents of named iShares index ETFs. Prints a ready-to-append
// block (grouped by index, deduped against the current universe and
// across the requested ETFs) to stdout.
//
// Usage:
//   npx tsx scripts/fetch-index-constituents.ts SOXX IJH IJR IWM
//
// Defaults to the four ETFs above when no args given. Writes nothing
// to disk on its own — operator pastes the output into
// config/universe.txt.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── ETF catalog (URL pieces are stable per-product) ─────────────────

interface EtfSpec {
  productId: string;
  slug: string;
  label: string;
}

const ETFS: Record<string, EtfSpec> = {
  SOXX: {
    productId: "239705",
    slug: "ishares-phlx-semiconductor-etf",
    label: "SOX (PHLX Semiconductor) via SOXX",
  },
  IJH: {
    productId: "239763",
    slug: "ishares-core-sp-mid-cap-etf",
    label: "S&P 400 Mid-Cap via IJH",
  },
  IJR: {
    productId: "239774",
    slug: "ishares-core-sp-small-cap-etf",
    label: "S&P 600 Small-Cap via IJR",
  },
  IWM: { productId: "239710", slug: "ishares-russell-2000-etf", label: "Russell 2000 via IWM" },
  IWB: { productId: "239707", slug: "ishares-russell-1000-etf", label: "Russell 1000 via IWB" },
};

const HOLDINGS_PATH = "1467271812596.ajax";

function holdingsUrl(spec: EtfSpec, etfTicker: string): string {
  return `https://www.ishares.com/us/products/${spec.productId}/${spec.slug}/${HOLDINGS_PATH}?fileType=csv&fileName=${etfTicker}_holdings&dataType=fund`;
}

// ── Universe parsing ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const UNIVERSE_PATH = resolve(ROOT, "config/universe.txt");

function loadCurrentUniverse(): Set<string> {
  const txt = readFileSync(UNIVERSE_PATH, "utf-8");
  const out = new Set<string>();
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.add(line.toUpperCase());
  }
  return out;
}

// ── CSV parsing ───────────────────────────────────────────────────

interface Row {
  ticker: string;
  name: string;
  assetClass: string;
  location: string;
  exchange: string;
}

function parseCsv(text: string): Row[] {
  // Strip UTF-8 BOM if present (U+FEFF — written via escape so eslint
  // no-irregular-whitespace doesn't flag a literal BOM character).
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);

  // iShares CSVs prepend ~8 metadata lines, a blank line, then a
  // header row. Locate the header by name; this is more robust than
  // a fixed offset.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("Ticker,")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error("CSV header not found");

  const cols = (lines[headerIdx] ?? "").split(",").map((s) => s.trim());
  const idx = {
    ticker: cols.indexOf("Ticker"),
    name: cols.indexOf("Name"),
    assetClass: cols.indexOf("Asset Class"),
    location: cols.indexOf("Location"),
    exchange: cols.indexOf("Exchange"),
  };

  const out: Row[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const parts = splitCsvLine(line);
    if (parts.length < cols.length) continue;
    out.push({
      ticker: (parts[idx.ticker] ?? "").trim(),
      name: (parts[idx.name] ?? "").trim(),
      assetClass: (parts[idx.assetClass] ?? "").trim(),
      location: (parts[idx.location] ?? "").trim(),
      exchange: (parts[idx.exchange] ?? "").trim(),
    });
  }
  return out;
}

// Minimal RFC-4180-ish splitter — the iShares CSV uses double-quoted
// fields with literal commas inside. No escaped quotes occur in
// practice.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ── Ticker normalization ──────────────────────────────────────────

// Reject cash sweeps, currency hedges, escrow CUSIPs, anything not a
// US-listed common-stock ticker we'd hand to MarketData.app.
// Values observed in iShares CSVs (SOXX, IJH, IJR, IWM, IWB).
// "NO MARKET (E.G. UNLISTED)" and "Non-Nms Quotation Service (Nnqs)"
// indicate delisted/escrow positions and are rejected.
const ALLOWED_EXCHANGES = new Set([
  "NASDAQ",
  "NYSE",
  "NYSE MKT LLC",
  "NYSE ARCA",
  "BATS",
  "CBOE BZX",
]);

function isUsableTicker(row: Row): boolean {
  if (row.assetClass !== "Equity") return false;
  if (row.location && row.location !== "United States") return false;
  const t = row.ticker;
  if (!t || t === "-") return false;
  if (t.length > 6) return false;
  if (!/^[A-Z][A-Z.\-/]*$/.test(t)) return false; // letters + class separators only — kills CUSIPs like P5N994
  // Exchange must be a major US listing venue. iShares marks escrow /
  // delisted positions with "Non-Nms Quotation Service (Nnqs)".
  if (row.exchange && !ALLOWED_EXCHANGES.has(row.exchange.toUpperCase())) return false;
  return true;
}

// MarketData.app accepts dotted class shares as e.g. "BRK.B". iShares
// prints them the same way; preserve.
function normalizeTicker(t: string): string {
  return t.toUpperCase().trim();
}

// ── Fetch + emit ──────────────────────────────────────────────────

async function fetchHoldings(etfTicker: string): Promise<Row[]> {
  const spec = ETFS[etfTicker];
  if (!spec) throw new Error(`Unknown ETF: ${etfTicker}`);
  const url = holdingsUrl(spec, etfTicker);
  const res = await fetch(url, {
    headers: { "User-Agent": "magpie/fetch-index-constituents" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${etfTicker} holdings`);
  return parseCsv(await res.text());
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const etfList = requested.length ? requested : ["SOXX", "IJH", "IJR", "IWM"];

  const current = loadCurrentUniverse();
  const seenAcrossEtfs = new Set<string>(current);
  const blocks: { label: string; etf: string; tickers: string[] }[] = [];

  for (const etf of etfList) {
    process.stderr.write(`Fetching ${etf}... `);
    let rows: Row[];
    try {
      rows = await fetchHoldings(etf);
    } catch (err) {
      process.stderr.write(`FAILED: ${(err as Error).message}\n`);
      continue;
    }
    const tickers = rows
      .filter(isUsableTicker)
      .map((r) => normalizeTicker(r.ticker))
      .filter((t) => {
        if (seenAcrossEtfs.has(t)) return false;
        seenAcrossEtfs.add(t);
        return true;
      })
      .sort();
    process.stderr.write(`${rows.length} holdings → ${tickers.length} new tickers\n`);
    const spec = ETFS[etf];
    if (!spec) continue;
    blocks.push({ label: spec.label, etf, tickers });
  }

  // Emit ready-to-append text on stdout.
  console.log("");
  for (const b of blocks) {
    if (b.tickers.length === 0) {
      console.log(`# ── ${b.label} (no new tickers — fully covered) ────────`);
      console.log("");
      continue;
    }
    console.log(`# ── ${b.label} ────`);
    console.log(
      `# Source: iShares ${b.etf} holdings (https://www.ishares.com/us/products/${ETFS[b.etf]?.productId})`,
    );
    console.log(
      `# Fetched: ${new Date().toISOString().slice(0, 10)} — ${b.tickers.length} net-new tickers`,
    );
    for (const t of b.tickers) console.log(t);
    console.log("");
  }
}

await main();
