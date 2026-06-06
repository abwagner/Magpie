// ── Yahoo Financial Adapter ───────────────────────────────────────
// Free-tier fundamentals fallback (FMP is the paid primary). Native TS
// port of data-signals/data-sources/pipelines/yfin.py.
//
// Five kinds:
//   universe                → S&P 500 (Wikipedia scrape) + SOX seed
//   fundamentals            → per-ticker yahoo-finance2 quote + summary
//   fundamentals_append     → daily history append
//   earnings                → per-ticker next earnings date
//   gics                    → sector/industry classification
//
// Manifest source slug: `yfinancial` (renamed from the old "yfin" Python
// shim — there's no Python self-import collision in TS land).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yahooFinance from "yahoo-finance2";
import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { exists, joinUri, mergeAndWriteParquet, readParquet, writeParquet } from "../storage.js";

const SP500_WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const WIKI_USER_AGENT = "Magpie/yfinancial-adapter (https://github.com/your-org/Magpie)";

// yahoo-finance2 has no published rate cap; keep concurrency modest.
const MAX_CONCURRENT = 6;
const RATE_LIMIT_PER_SEC = Number(process.env.YFINANCIAL_RATE_LIMIT_PER_SEC ?? "10");

const SEED_DIR = resolve(import.meta.dirname ?? ".", "..", "seeds");
const SOX_SEED_CSV = resolve(SEED_DIR, "sox.csv");
const TECH_CLUSTERS_CSV = resolve(SEED_DIR, "tech-clusters.csv");

// ── Helpers (shared with fmp.ts shape) ────────────────────────────

class RateLimiter {
  private nextAllowed = 0;
  private readonly interval: number;
  constructor(perSec: number) {
    this.interval = 1000 / perSec;
  }
  async acquire(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAllowed) await new Promise((r) => setTimeout(r, this.nextAllowed - now));
    this.nextAllowed = Math.max(now, this.nextAllowed) + this.interval;
  }
}

function nowUtcNoTz(): string {
  return new Date()
    .toISOString()
    .replace(/T/, " ")
    .replace(/\.\d+Z$/, "");
}
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
function toFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function safePeg(fwdPe: number | null, growthPct: number | null): number | null {
  if (fwdPe === null || growthPct === null || growthPct <= 1) return null;
  return fwdPe / growthPct;
}
function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!;
}

function parseCsv(content: string): Record<string, string>[] {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = lines[0]!.split(",").map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, j) => (row[h] = (fields[j] ?? "").trim()));
    out.push(row);
  }
  return out;
}

function loadSoxSeed(): Array<{ ticker: string; name: string }> {
  return parseCsv(readFileSync(SOX_SEED_CSV, "utf-8")).map((r) => ({
    ticker: String(r.ticker),
    name: String(r.name ?? ""),
  }));
}

function loadTechClustersSeed(): Array<{ ticker: string; cluster: string }> {
  return parseCsv(readFileSync(TECH_CLUSTERS_CSV, "utf-8")).map((r) => ({
    ticker: String(r.ticker),
    cluster: String(r.cluster),
  }));
}

// ── Wikipedia S&P 500 scrape ──────────────────────────────────────
// Extracts the constituents table. Wikipedia's HTML is stable enough
// that a focused regex avoids pulling in cheerio.

interface SpRow {
  ticker: string;
  name: string;
  sector: string;
  sub_industry: string;
}

function parseWikiSp500(html: string): SpRow[] {
  // Find <table id="constituents">…</table>. Wikipedia uses sortable tables.
  const tableMatch = html.match(/<table[^>]*id=["']constituents["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) throw new Error("Wikipedia: constituents table not found");
  const rows: SpRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  for (const r of tableMatch[1]!.matchAll(rowRe)) {
    const cells: string[] = [];
    for (const c of r[1]!.matchAll(cellRe)) {
      // Strip nested tags + decode common HTML entities.
      const text = c[1]!
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();
      cells.push(text);
    }
    // Header rows have <th> only and produce ticker like "Symbol"; skip those.
    if (cells.length < 4) continue;
    const ticker = cells[0]!.replace(/\./g, "-");
    if (!ticker || ticker.toLowerCase() === "symbol") continue;
    rows.push({
      ticker,
      name: cells[1] ?? "",
      sector: cells[2] ?? "",
      sub_industry: cells[3] ?? "",
    });
  }
  return rows;
}

async function fetchSp500Constituents(): Promise<SpRow[]> {
  const resp = await fetch(SP500_WIKI_URL, { headers: { "User-Agent": WIKI_USER_AGENT } });
  if (!resp.ok) throw new Error(`Wikipedia HTTP ${resp.status}`);
  return parseWikiSp500(await resp.text());
}

// ── Kind: universe ────────────────────────────────────────────────

async function cmdUniverse(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const indices = (req.args.indices as string[] | undefined) ?? ["sp500", "sox"];
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];

  if (indices.includes("sp500")) {
    const sp = await fetchSp500Constituents();
    for (const r of sp) {
      if (!r.ticker || seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      rows.push({
        ticker: r.ticker,
        name: r.name || null,
        sector: r.sector || null,
        sub_industry: r.sub_industry || null,
        source_index: "sp500",
      });
    }
  }
  if (indices.includes("sox")) {
    for (const r of loadSoxSeed()) {
      if (seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      rows.push({
        ticker: r.ticker,
        name: r.name,
        sector: "Information Technology",
        sub_industry: "Semiconductors",
        source_index: "sox",
      });
    }
  }

  const ts = nowUtcNoTz();
  for (const r of rows) r.last_updated_at = ts;

  await writeParquet({
    uri: req.output,
    schema:
      "(ticker VARCHAR, name VARCHAR, sector VARCHAR, sub_industry VARCHAR, source_index VARCHAR, last_updated_at TIMESTAMP)",
    rows,
    orderBy: "ticker",
  });
  return { request: req, ok: true, dataThrough: todayDate() };
}

// ── Kind: fundamentals ────────────────────────────────────────────

interface FundamentalRow {
  ticker: string;
  fwd_pe: number | null;
  trailing_pe: number | null;
  fwd_eps: number | null;
  trailing_eps: number | null;
  fwd_growth_pct: number | null;
  ttm_growth_pct: number | null;
  peg_yf_5y: number | null;
  peg_long_term: number | null;
  peg_fwd_1y: number | null;
  peg_fwd_ttm: number | null;
  peg_median: number | null;
  mcap_b: number | null;
  price: number | null;
  currency: string | null;
  data_source: string;
}

interface YahooQuote {
  forwardPE?: number;
  trailingPE?: number;
  epsForward?: number;
  epsTrailingTwelveMonths?: number;
  regularMarketPrice?: number;
  marketCap?: number;
  currency?: string;
}
interface YahooSummary {
  defaultKeyStatistics?: { pegRatio?: number };
  earningsTrend?: { trend?: Array<{ period?: string; growth?: number | null }> };
  calendarEvents?: { earnings?: { earningsDate?: Date | string | Array<Date | string> } };
  assetProfile?: { sector?: string; industry?: string };
}

async function fetchOneFundamental(
  ticker: string,
  limiter: RateLimiter,
): Promise<FundamentalRow | null> {
  await limiter.acquire();
  let q: YahooQuote | null;
  let summary: YahooSummary | null;
  try {
    q = (await yahooFinance.quote(ticker)) as unknown as YahooQuote;
    summary = (await yahooFinance.quoteSummary(ticker, {
      modules: ["defaultKeyStatistics", "summaryDetail", "earningsTrend"],
    })) as unknown as YahooSummary;
  } catch (e) {
    console.error(`[yfinancial] ${ticker} failed:`, (e as Error).message);
    return null;
  }
  if (!q) return null;

  const fwdPe = toFloat(q.forwardPE);
  const trailingPe = toFloat(q.trailingPE);
  const fwdEps = toFloat(q.epsForward);
  const trailingEps = toFloat(q.epsTrailingTwelveMonths);
  const price = toFloat(q.regularMarketPrice);
  const mcap = toFloat(q.marketCap);
  const peg5y = toFloat(summary?.defaultKeyStatistics?.pegRatio);

  // Forward growth: prefer earningsTrend's earnings-growth on the +1y trend
  let fwdGrowthPct: number | null = null;
  const trends = summary?.earningsTrend?.trend ?? [];
  for (const t of trends) {
    if (t.period === "+1y" && t.growth !== undefined && t.growth !== null) {
      const g = toFloat(t.growth);
      if (g !== null) fwdGrowthPct = g * 100;
    }
  }
  if (fwdGrowthPct === null && fwdEps !== null && trailingEps !== null && trailingEps > 0) {
    fwdGrowthPct = ((fwdEps - trailingEps) / trailingEps) * 100;
  }

  // TTM growth: from earningsTrend "0y" or earningsQuarterlyGrowth
  let ttmGrowthPct: number | null = null;
  for (const t of trends) {
    if (t.period === "0y" && t.growth !== undefined && t.growth !== null) {
      const g = toFloat(t.growth);
      if (g !== null) ttmGrowthPct = g * 100;
    }
  }

  const pegFwd1y = safePeg(fwdPe, fwdGrowthPct);
  const pegFwdTtm = safePeg(fwdPe, ttmGrowthPct);
  const pegMedian = median([peg5y, pegFwd1y, pegFwdTtm].filter((v): v is number => v !== null));

  return {
    ticker,
    fwd_pe: fwdPe,
    trailing_pe: trailingPe,
    fwd_eps: fwdEps,
    trailing_eps: trailingEps,
    fwd_growth_pct: fwdGrowthPct,
    ttm_growth_pct: ttmGrowthPct,
    peg_yf_5y: peg5y,
    peg_long_term: peg5y,
    peg_fwd_1y: pegFwd1y,
    peg_fwd_ttm: pegFwdTtm,
    peg_median: pegMedian,
    mcap_b: mcap === null ? null : mcap / 1e9,
    price,
    currency: typeof q.currency === "string" ? q.currency : null,
    data_source: "yfinancial",
  };
}

const FUNDAMENTAL_SCHEMA = `(
  ticker VARCHAR, fwd_pe DOUBLE, trailing_pe DOUBLE, fwd_eps DOUBLE, trailing_eps DOUBLE,
  fwd_growth_pct DOUBLE, ttm_growth_pct DOUBLE,
  peg_yf_5y DOUBLE, peg_long_term DOUBLE, peg_fwd_1y DOUBLE, peg_fwd_ttm DOUBLE, peg_median DOUBLE,
  mcap_b DOUBLE, price DOUBLE, currency VARCHAR, data_source VARCHAR,
  asof_date DATE, last_updated_at TIMESTAMP
)`;

async function cmdFundamentals(req: DataRequest, append: boolean): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(`[yfinancial] fundamentals: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC}/sec`);

  const today = todayDate();
  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];

  // Bounded concurrency
  const inFlight: Array<Promise<void>> = [];
  let cursor = 0;
  let completed = 0;
  const total = tickers.length;
  await new Promise<void>((resolveAll, reject) => {
    const launch = (): void => {
      while (inFlight.length < MAX_CONCURRENT && cursor < total) {
        const t = tickers[cursor++]!;
        const p = (async (): Promise<void> => {
          const row = await fetchOneFundamental(t, limiter);
          if (row) rows.push({ ...row, asof_date: today, last_updated_at: ts });
          completed++;
          if (completed % 50 === 0) {
            console.log(`[yfinancial] fundamentals progress: ${completed}/${total}`);
          }
        })();
        inFlight.push(p);
        p.then(() => {
          inFlight.splice(inFlight.indexOf(p), 1);
          if (cursor >= total && inFlight.length === 0) resolveAll();
          else launch();
        }, reject);
      }
      if (cursor >= total && inFlight.length === 0) resolveAll();
    };
    launch();
  });

  if (rows.length === 0) return { request: req, ok: false, error: "no rows fetched" };

  if (append) {
    await mergeAndWriteParquet({
      uri: req.output,
      schema: FUNDAMENTAL_SCHEMA,
      dedupKey: "asof_date, ticker",
      rows,
      orderBy: "asof_date, ticker",
    });
  } else {
    await writeParquet({ uri: req.output, schema: FUNDAMENTAL_SCHEMA, rows, orderBy: "ticker" });
  }
  return { request: req, ok: true, dataThrough: today };
}

// ── Kind: earnings ────────────────────────────────────────────────

async function fetchOneEarning(
  ticker: string,
  limiter: RateLimiter,
): Promise<{ ticker: string; next_earnings_date: string } | null> {
  await limiter.acquire();
  try {
    const summary = (await yahooFinance.quoteSummary(ticker, {
      modules: ["calendarEvents"],
    })) as unknown as YahooSummary;
    const dates = summary?.calendarEvents?.earnings?.earningsDate;
    if (!dates || (Array.isArray(dates) && dates.length === 0)) return null;
    const first = Array.isArray(dates) ? dates[0] : dates;
    if (!first) return null;
    const d = first instanceof Date ? first : new Date(String(first));
    if (Number.isNaN(d.getTime())) return null;
    return { ticker, next_earnings_date: d.toISOString().slice(0, 10) };
  } catch (e) {
    console.error(`[yfinancial] earnings ${ticker} failed:`, (e as Error).message);
    return null;
  }
}

async function cmdEarnings(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(`[yfinancial] earnings: ${tickers.length} tickers`);

  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];
  let completed = 0;
  const total = tickers.length;

  await new Promise<void>((resolveAll, reject) => {
    const inFlight: Array<Promise<void>> = [];
    let cursor = 0;
    const launch = (): void => {
      while (inFlight.length < MAX_CONCURRENT && cursor < total) {
        const t = tickers[cursor++]!;
        const p = (async (): Promise<void> => {
          const row = await fetchOneEarning(t, limiter);
          if (row) rows.push({ ...row, last_updated_at: ts });
          completed++;
          if (completed % 50 === 0) {
            console.log(`[yfinancial] earnings progress: ${completed}/${total}`);
          }
        })();
        inFlight.push(p);
        p.then(() => {
          inFlight.splice(inFlight.indexOf(p), 1);
          if (cursor >= total && inFlight.length === 0) resolveAll();
          else launch();
        }, reject);
      }
      if (cursor >= total && inFlight.length === 0) resolveAll();
    };
    launch();
  });

  if (rows.length === 0) return { request: req, ok: false, error: "no earnings rows" };
  await writeParquet({
    uri: req.output,
    schema: "(ticker VARCHAR, next_earnings_date DATE, last_updated_at TIMESTAMP)",
    rows,
    orderBy: "ticker",
  });
  return { request: req, ok: true, dataThrough: todayDate() };
}

// ── Kind: gics ────────────────────────────────────────────────────

async function cmdGics(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{
    ticker: string;
    name: string | null;
    sector: string | null;
    sub_industry: string | null;
    source_index: string | null;
  }>(universeUri);

  const ts = nowUtcNoTz();
  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  const out: Array<Record<string, unknown>> = [];

  for (const r of universe) {
    let { sector, sub_industry } = r;
    let industry: string | null = null;
    if (!sector || !sub_industry) {
      // Refine via yahoo-finance2 assetProfile module
      try {
        await limiter.acquire();
        const summary = (await yahooFinance.quoteSummary(r.ticker, {
          modules: ["assetProfile"],
        })) as unknown as YahooSummary;
        const ap = summary?.assetProfile;
        sector = sector ?? ap?.sector ?? null;
        industry = ap?.industry ?? null;
        sub_industry = sub_industry ?? industry;
      } catch (e) {
        console.error(`[yfinancial] gics ${r.ticker} failed:`, (e as Error).message);
      }
    }
    out.push({
      ticker: r.ticker,
      name: r.name ?? null,
      sector,
      industry_group: null,
      industry,
      sub_industry,
      last_updated_at: ts,
    });
  }

  await writeParquet({
    uri: req.output,
    schema:
      "(ticker VARCHAR, name VARCHAR, sector VARCHAR, industry_group VARCHAR, industry VARCHAR, sub_industry VARCHAR, last_updated_at TIMESTAMP)",
    rows: out,
    orderBy: "ticker",
  });
  await seedTechClustersIfMissing(req.output);
  return { request: req, ok: true, dataThrough: todayDate() };
}

async function seedTechClustersIfMissing(gicsAbsoluteUri: string): Promise<void> {
  const parent = gicsAbsoluteUri.replace(/\/[^/]+$/, "");
  const clustersUri = `${parent}/tech_clusters.parquet`;
  if (await exists(clustersUri)) return;
  const seed = loadTechClustersSeed();
  const ts = nowUtcNoTz();
  await writeParquet({
    uri: clustersUri,
    schema: "(ticker VARCHAR, cluster VARCHAR, source VARCHAR, last_updated_at TIMESTAMP)",
    rows: seed.map((r) => ({
      ticker: r.ticker,
      cluster: r.cluster,
      source: "manual",
      last_updated_at: ts,
    })),
    orderBy: "ticker",
  });
  console.log(`[yfinancial] seeded tech_clusters.parquet (${seed.length} rows)`);
}

// ── Adapter wiring ────────────────────────────────────────────────

export function createYfinancialAdapter(): DataAdapter {
  return {
    id: "yfinancial",
    capabilities: { batch: true, streaming: false, maxConcurrent: 1 },
    async fetch(requests: DataRequest[]): Promise<DataResult[]> {
      const results: DataResult[] = [];
      for (const req of requests) {
        const kind = String(req.args.kind ?? "");
        try {
          let res: DataResult;
          switch (kind) {
            case "universe":
              res = await cmdUniverse(req);
              break;
            case "fundamentals":
              res = await cmdFundamentals(req, false);
              break;
            case "fundamentals_append":
              res = await cmdFundamentals(req, true);
              break;
            case "earnings":
              res = await cmdEarnings(req);
              break;
            case "gics":
              res = await cmdGics(req);
              break;
            default:
              res = { request: req, ok: false, error: `unknown kind: ${kind}` };
          }
          results.push(res);
        } catch (e) {
          results.push({ request: req, ok: false, error: String((e as Error).message ?? e) });
        }
      }
      return results;
    },
    supportsRequest(args: Record<string, unknown>): boolean {
      return ["universe", "fundamentals", "fundamentals_append", "earnings", "gics"].includes(
        String(args.kind ?? ""),
      );
    },
  };
}
