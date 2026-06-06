// ── FMP Adapter ────────────────────────────────────────────────────
// Financial Modeling Prep — fundamentals + analyst estimates + earnings.
// Native TS implementation; replaces the shell-out to data-signals'
// fmp.py pipeline.
//
// Six kinds (selected via DataRequest.args.kind):
//   universe                    → S&P 500 (FMP) + SOX seed
//   fundamentals                → per-ticker snapshot (forward PEG variants)
//   fundamentals_append         → daily history append
//   earnings                    → bulk forward earnings calendar
//   gics                        → sector/industry classification
//   analyst_estimates_history   → per-ticker forward fiscal-year estimates
//
// Rate limited for FMP Starter (300 req/min) by default; override with
// FMP_RATE_LIMIT_PER_SEC for Premium (12.5/sec) or Ultimate (50/sec).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DataAdapter, DataRequest, DataResult } from "../adapter.js";
import { joinUri, mergeAndWriteParquet, readParquet, writeParquet } from "../storage.js";

// Convention: orchestrator pre-resolves manifest `output` to an absolute URI
// (file:// or s3://) before invoking adapters; adapters write to req.output
// directly without re-joining. Mirrors the Python `ingest_all.py + storage.join()`
// flow that the Python pipelines depend on.

const API_BASE = "https://financialmodelingprep.com/api";
const RATE_LIMIT_PER_SEC = Number(process.env.FMP_RATE_LIMIT_PER_SEC ?? "4");

const SEED_DIR = resolve(import.meta.dirname ?? ".", "..", "seeds");
const SOX_SEED_CSV = resolve(SEED_DIR, "sox.csv");
const TECH_CLUSTERS_CSV = resolve(SEED_DIR, "tech-clusters.csv");

// ── Types ──────────────────────────────────────────────────────────

interface FmpProfile {
  sector?: string | null;
  industry?: string | null;
}
interface FmpQuote {
  pe?: number | null;
  eps?: number | null;
  price?: number | null;
  marketCap?: number | null;
  currency?: string | null;
}
interface FmpKeyMetricsTtm {
  peRatioTTM?: number | null;
  pegRatioTTM?: number | null;
  netIncomeGrowthTTM?: number | null;
  epsgrowthTTM?: number | null;
}
interface FmpAnalystEstimate {
  date?: string;
  estimatedEpsAvg?: number | null;
  estimatedEpsLow?: number | null;
  estimatedEpsHigh?: number | null;
  estimatedRevenueAvg?: number | null;
  numberAnalystEstimatedRevenue?: number | null;
  numberAnalystsEstimatedEps?: number | null;
}
interface FmpSp500Row {
  symbol: string;
  name?: string;
  sector?: string;
  subSector?: string;
}
interface FmpEarningRow {
  symbol?: string;
  date?: string;
}

// ── Rate limiter ───────────────────────────────────────────────────

class RateLimiter {
  private nextAllowed = 0;
  private readonly interval: number;
  constructor(perSec: number) {
    this.interval = 1000 / perSec;
  }
  async acquire(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAllowed) {
      await new Promise((r) => setTimeout(r, this.nextAllowed - now));
    }
    this.nextAllowed = Math.max(now, this.nextAllowed) + this.interval;
  }
}

// ── HTTP ───────────────────────────────────────────────────────────

class FmpError extends Error {}

function apiKey(): string {
  const k = (process.env.FMP_API_KEY ?? "").trim();
  if (!k) throw new FmpError("FMP_API_KEY not set");
  return k;
}

async function getJson<T>(
  path: string,
  params: Record<string, string> = {},
  version = "v3",
  limiter?: RateLimiter,
): Promise<T> {
  if (limiter) await limiter.acquire();
  const url = new URL(`${API_BASE}/${version}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", apiKey());

  let resp = await fetch(url.toString());
  if (resp.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    resp = await fetch(url.toString());
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new FmpError(`FMP ${version}/${path} HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const body = (await resp.json()) as T | { "Error Message"?: string };
  if (body && typeof body === "object" && "Error Message" in body && body["Error Message"]) {
    throw new FmpError(`FMP ${version}/${path}: ${String(body["Error Message"])}`);
  }
  return body as T;
}

// ── Helpers ────────────────────────────────────────────────────────

function nowUtcNoTz(): string {
  return new Date()
    .toISOString()
    .replace(/T/, " ")
    .replace(/\.\d+Z$/, "");
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
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

// ── Kind: universe ────────────────────────────────────────────────

async function cmdUniverse(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const indices = (req.args.indices as string[] | undefined) ?? ["sp500", "sox"];
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];

  if (indices.includes("sp500")) {
    const sp = await getJson<FmpSp500Row[]>("sp500_constituent");
    for (const r of sp) {
      const t = (r.symbol ?? "").replace(/\./g, "-");
      if (!t || seen.has(t)) continue;
      seen.add(t);
      rows.push({
        ticker: t,
        name: r.name ?? null,
        sector: r.sector ?? null,
        sub_industry: r.subSector ?? null,
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
  peg_long_term: number | null;
  peg_yf_5y: number | null;
  peg_fwd_1y: number | null;
  peg_fwd_ttm: number | null;
  peg_median: number | null;
  mcap_b: number | null;
  price: number | null;
  currency: string | null;
  data_source: string;
}

async function fetchOneFundamental(
  ticker: string,
  limiter: RateLimiter,
): Promise<FundamentalRow | null> {
  let quote: FmpQuote = {};
  let km: FmpKeyMetricsTtm = {};
  let est: FmpAnalystEstimate[] = [];
  try {
    quote = ((await getJson<FmpQuote[]>(`quote/${ticker}`, {}, "v3", limiter))[0] ??
      {}) as FmpQuote;
    km = ((await getJson<FmpKeyMetricsTtm[]>(`key-metrics-ttm/${ticker}`, {}, "v3", limiter))[0] ??
      {}) as FmpKeyMetricsTtm;
    est = await getJson<FmpAnalystEstimate[]>(
      `analyst-estimates/${ticker}`,
      { period: "annual" },
      "v3",
      limiter,
    );
  } catch (e) {
    console.error(`[fmp] fundamentals ${ticker} failed:`, (e as Error).message);
    return null;
  }

  const today = todayDate();
  const sorted = [...est].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const future = sorted.filter((r) => (r.date ?? "") >= today);
  const past = sorted.filter((r) => (r.date ?? "") < today);
  const estNext = future[0];
  const estCurr = past[past.length - 1];

  const trailingEps = toFloat(quote.eps);
  const fwdEps = toFloat(estNext?.estimatedEpsAvg);
  const epsCurrYear = toFloat(estCurr?.estimatedEpsAvg) ?? trailingEps;
  let fwdPe = toFloat(quote.pe);
  const trailingPe = toFloat(km.peRatioTTM) ?? toFloat(quote.pe);
  const price = toFloat(quote.price);
  const mcap = toFloat(quote.marketCap);

  let fwdGrowthPct: number | null = null;
  if (fwdEps !== null && epsCurrYear !== null && epsCurrYear > 0) {
    fwdGrowthPct = ((fwdEps - epsCurrYear) / epsCurrYear) * 100;
  } else if (fwdEps !== null && trailingEps !== null && trailingEps > 0) {
    fwdGrowthPct = ((fwdEps - trailingEps) / trailingEps) * 100;
  }
  if (price !== null && fwdEps !== null && fwdEps > 0) fwdPe = price / fwdEps;

  const pegLongTerm = toFloat(km.pegRatioTTM);
  const niGrowth = toFloat(km.netIncomeGrowthTTM ?? km.epsgrowthTTM);
  const ttmGrowthPct =
    niGrowth === null ? null : Math.abs(niGrowth) < 5 ? niGrowth * 100 : niGrowth;

  const pegFwd1y = safePeg(fwdPe, fwdGrowthPct);
  const pegFwdTtm = safePeg(fwdPe, ttmGrowthPct);
  const pegMedian = median(
    [pegLongTerm, pegFwd1y, pegFwdTtm].filter((v): v is number => v !== null),
  );

  return {
    ticker,
    fwd_pe: fwdPe,
    trailing_pe: trailingPe,
    fwd_eps: fwdEps,
    trailing_eps: trailingEps,
    fwd_growth_pct: fwdGrowthPct,
    ttm_growth_pct: ttmGrowthPct,
    peg_long_term: pegLongTerm,
    peg_yf_5y: pegLongTerm,
    peg_fwd_1y: pegFwd1y,
    peg_fwd_ttm: pegFwdTtm,
    peg_median: pegMedian,
    mcap_b: mcap === null ? null : mcap / 1e9,
    price,
    currency: typeof quote.currency === "string" ? quote.currency : null,
    data_source: "fmp",
  };
}

const FUNDAMENTAL_SCHEMA = `(
  ticker VARCHAR, fwd_pe DOUBLE, trailing_pe DOUBLE, fwd_eps DOUBLE, trailing_eps DOUBLE,
  fwd_growth_pct DOUBLE, ttm_growth_pct DOUBLE,
  peg_long_term DOUBLE, peg_yf_5y DOUBLE, peg_fwd_1y DOUBLE, peg_fwd_ttm DOUBLE, peg_median DOUBLE,
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
  console.log(`[fmp] fundamentals: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC} req/sec`);

  const rows: Array<Record<string, unknown>> = [];
  const today = todayDate();
  const ts = nowUtcNoTz();
  let completed = 0;
  for (const t of tickers) {
    const row = await fetchOneFundamental(t, limiter);
    completed++;
    if (row) rows.push({ ...row, asof_date: today, last_updated_at: ts });
    if (completed % 50 === 0)
      console.log(`[fmp] fundamentals progress: ${completed}/${tickers.length}`);
  }

  if (rows.length === 0) return { request: req, ok: false, error: "no rows fetched" };

  const targetUri = req.output;
  if (append) {
    await mergeAndWriteParquet({
      uri: targetUri,
      schema: FUNDAMENTAL_SCHEMA,
      dedupKey: "asof_date, ticker",
      rows,
      orderBy: "asof_date, ticker",
    });
  } else {
    await writeParquet({
      uri: targetUri,
      schema: FUNDAMENTAL_SCHEMA,
      rows,
      orderBy: "ticker",
    });
  }
  return { request: req, ok: true, dataThrough: today };
}

// ── Kind: earnings (bulk) ─────────────────────────────────────────

async function cmdEarnings(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const universeSet = new Set(universe.map((r) => r.ticker).filter(Boolean));

  const today = todayDate();
  const horizon = plusDays(today, 90);
  const list = await getJson<FmpEarningRow[]>("earning_calendar", { from: today, to: horizon });

  const earliest = new Map<string, string>();
  for (const r of list) {
    const sym = String(r.symbol ?? "").replace(/\./g, "-");
    const date = r.date;
    if (!sym || !date || !universeSet.has(sym)) continue;
    const cur = earliest.get(sym);
    if (!cur || date < cur) earliest.set(sym, date);
  }

  const ts = nowUtcNoTz();
  const rows = [...earliest.entries()].map(([ticker, next_earnings_date]) => ({
    ticker,
    next_earnings_date,
    last_updated_at: ts,
  }));
  if (rows.length === 0) return { request: req, ok: false, error: "no earnings rows" };

  await writeParquet({
    uri: req.output,
    schema: "(ticker VARCHAR, next_earnings_date DATE, last_updated_at TIMESTAMP)",
    rows,
    orderBy: "ticker",
  });
  return { request: req, ok: true, dataThrough: today };
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
  const sp500Tickers = new Set(
    universe.filter((r) => r.source_index === "sp500").map((r) => r.ticker),
  );
  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  const out: Array<Record<string, unknown>> = [];

  for (const r of universe) {
    let sector = r.sector;
    let subIndustry = r.sub_industry;
    let industry: string | null = null;

    // SOX-only names: refine from /profile
    if (r.source_index === "sox" && !sp500Tickers.has(r.ticker)) {
      try {
        const profArr = await getJson<FmpProfile[]>(`profile/${r.ticker}`, {}, "v3", limiter);
        const prof = profArr[0] ?? {};
        sector = sector ?? prof.sector ?? null;
        industry = prof.industry ?? null;
        subIndustry = subIndustry ?? prof.industry ?? null;
      } catch (e) {
        console.error(`[fmp] gics ${r.ticker} failed:`, (e as Error).message);
      }
    }

    out.push({
      ticker: r.ticker,
      name: r.name ?? null,
      sector,
      industry_group: null,
      industry,
      sub_industry: subIndustry,
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

  // Seed tech_clusters.parquet alongside (idempotent — only if missing)
  await seedTechClustersIfMissing(req.output);

  return { request: req, ok: true, dataThrough: todayDate() };
}

async function seedTechClustersIfMissing(gicsAbsoluteUri: string): Promise<void> {
  const parent = gicsAbsoluteUri.replace(/\/[^/]+$/, "");
  const clustersUri = `${parent}/tech_clusters.parquet`;
  const { exists } = await import("../storage.js");
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
  console.log(`[fmp] seeded tech_clusters.parquet (${seed.length} rows)`);
}

// ── Kind: analyst_estimates_history ───────────────────────────────

async function cmdAnalystEstimatesHistory(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };
  const period = (req.args.period as string | undefined) ?? "annual";

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(
    `[fmp] analyst_estimates_history: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC} req/sec`,
  );

  const today = todayDate();
  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];
  let completed = 0;

  for (const t of tickers) {
    let est: FmpAnalystEstimate[] = [];
    try {
      est = await getJson<FmpAnalystEstimate[]>(
        `analyst-estimates/${t}`,
        { period },
        "v3",
        limiter,
      );
    } catch (e) {
      console.error(`[fmp] estimates ${t} failed:`, (e as Error).message);
    }
    for (const r of est) {
      rows.push({
        ticker: t,
        snapshot_date: today,
        fiscal_period_end: r.date ?? null,
        eps_estimate_avg: toFloat(r.estimatedEpsAvg),
        eps_estimate_low: toFloat(r.estimatedEpsLow),
        eps_estimate_high: toFloat(r.estimatedEpsHigh),
        revenue_estimate_avg: toFloat(r.estimatedRevenueAvg),
        n_analysts_eps: toFloat(r.numberAnalystsEstimatedEps),
        n_analysts_revenue: toFloat(r.numberAnalystEstimatedRevenue),
        period,
        last_updated_at: ts,
      });
    }
    completed++;
    if (completed % 50 === 0) {
      console.log(`[fmp] estimates progress: ${completed}/${tickers.length}`);
    }
  }

  if (rows.length === 0) return { request: req, ok: false, error: "no estimate rows" };

  await mergeAndWriteParquet({
    uri: req.output,
    schema: `(
      ticker VARCHAR, snapshot_date DATE, fiscal_period_end DATE,
      eps_estimate_avg DOUBLE, eps_estimate_low DOUBLE, eps_estimate_high DOUBLE,
      revenue_estimate_avg DOUBLE, n_analysts_eps DOUBLE, n_analysts_revenue DOUBLE,
      period VARCHAR, last_updated_at TIMESTAMP
    )`,
    dedupKey: "snapshot_date, ticker, fiscal_period_end, period",
    rows,
    orderBy: "snapshot_date, ticker, fiscal_period_end",
  });
  return { request: req, ok: true, dataThrough: today };
}

// ── Kind: dividends ───────────────────────────────────────────────
// `historical-price-full/stock_dividend/{symbol}` returns a `historical`
// array per ticker. Full overwrite — these are historical records, not
// snapshots, so a re-run replaces the prior pull cleanly.

interface FmpDividendRow {
  date?: string;
  label?: string | null;
  adjDividend?: number | null;
  dividend?: number | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  declarationDate?: string | null;
}
interface FmpDividendResp {
  symbol?: string;
  historical?: FmpDividendRow[];
}

export function parseDividendRows(
  ticker: string,
  resp: FmpDividendResp,
  ts: string,
): Array<Record<string, unknown>> {
  return (resp.historical ?? []).map((r) => ({
    ticker,
    date: r.date ?? null,
    dividend: toFloat(r.dividend),
    adj_dividend: toFloat(r.adjDividend),
    label: r.label ?? null,
    declaration_date: r.declarationDate ?? null,
    record_date: r.recordDate ?? null,
    payment_date: r.paymentDate ?? null,
    last_updated_at: ts,
  }));
}

const DIVIDEND_SCHEMA = `(
  ticker VARCHAR, date DATE, dividend DOUBLE, adj_dividend DOUBLE,
  label VARCHAR, declaration_date DATE, record_date DATE, payment_date DATE,
  last_updated_at TIMESTAMP
)`;

async function cmdDividends(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(`[fmp] dividends: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC} req/sec`);

  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];
  let completed = 0;
  for (const t of tickers) {
    try {
      const resp = await getJson<FmpDividendResp>(
        `historical-price-full/stock_dividend/${t}`,
        {},
        "v3",
        limiter,
      );
      rows.push(...parseDividendRows(t, resp, ts));
    } catch (e) {
      console.error(`[fmp] dividends ${t} failed:`, (e as Error).message);
    }
    completed++;
    if (completed % 50 === 0) {
      console.log(`[fmp] dividends progress: ${completed}/${tickers.length}`);
    }
  }

  if (rows.length === 0) return { request: req, ok: false, error: "no dividend rows" };

  await writeParquet({
    uri: req.output,
    schema: DIVIDEND_SCHEMA,
    rows,
    orderBy: "ticker, date",
  });
  return { request: req, ok: true, dataThrough: todayDate() };
}

// ── Kind: splits ──────────────────────────────────────────────────

interface FmpSplitRow {
  date?: string;
  label?: string | null;
  numerator?: number | null;
  denominator?: number | null;
}
interface FmpSplitResp {
  symbol?: string;
  historical?: FmpSplitRow[];
}

export function parseSplitRows(
  ticker: string,
  resp: FmpSplitResp,
  ts: string,
): Array<Record<string, unknown>> {
  return (resp.historical ?? []).map((r) => ({
    ticker,
    date: r.date ?? null,
    numerator: toFloat(r.numerator),
    denominator: toFloat(r.denominator),
    last_updated_at: ts,
  }));
}

const SPLIT_SCHEMA = `(
  ticker VARCHAR, date DATE, numerator DOUBLE, denominator DOUBLE,
  last_updated_at TIMESTAMP
)`;

async function cmdSplits(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(`[fmp] splits: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC} req/sec`);

  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];
  let completed = 0;
  for (const t of tickers) {
    try {
      const resp = await getJson<FmpSplitResp>(
        `historical-price-full/stock_split/${t}`,
        {},
        "v3",
        limiter,
      );
      rows.push(...parseSplitRows(t, resp, ts));
    } catch (e) {
      console.error(`[fmp] splits ${t} failed:`, (e as Error).message);
    }
    completed++;
    if (completed % 50 === 0) {
      console.log(`[fmp] splits progress: ${completed}/${tickers.length}`);
    }
  }

  if (rows.length === 0) return { request: req, ok: false, error: "no split rows" };

  await writeParquet({
    uri: req.output,
    schema: SPLIT_SCHEMA,
    rows,
    orderBy: "ticker, date",
  });
  return { request: req, ok: true, dataThrough: todayDate() };
}

// ── Kinds: income / balance sheet / cash flow ────────────────────
// FMP returns a flat array of quarterly statements per ticker. Schema
// is a curated subset of the ~80 fields each endpoint exposes —
// covers fundamental-analysis basics (revenue/margins, working
// capital, total debt, free cash flow). Extending: add another
// `[fmpField, parquetCol]` row to the relevant field map below and
// the matching column to the schema DDL.

interface FmpStatementRow {
  date?: string;
  symbol?: string;
  reportedCurrency?: string | null;
  period?: string | null;
  [k: string]: unknown;
}

const STATEMENT_SPINE_SCHEMA = `ticker VARCHAR, fiscal_period_end DATE, period VARCHAR, reported_currency VARCHAR, last_updated_at TIMESTAMP`;

export function projectStatement(
  ticker: string,
  rows: FmpStatementRow[],
  fieldMap: ReadonlyArray<readonly [string, string]>,
  ts: string,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {
      ticker,
      fiscal_period_end: row.date ?? null,
      period: row.period ?? null,
      reported_currency: row.reportedCurrency ?? null,
      last_updated_at: ts,
    };
    for (const [src, dst] of fieldMap) {
      out[dst] = toFloat(row[src]);
    }
    return out;
  });
}

const INCOME_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["revenue", "revenue"],
  ["costOfRevenue", "cost_of_revenue"],
  ["grossProfit", "gross_profit"],
  ["grossProfitRatio", "gross_profit_ratio"],
  ["operatingExpenses", "operating_expenses"],
  ["ebitda", "ebitda"],
  ["ebitdaratio", "ebitda_ratio"],
  ["operatingIncome", "operating_income"],
  ["operatingIncomeRatio", "operating_income_ratio"],
  ["interestIncome", "interest_income"],
  ["interestExpense", "interest_expense"],
  ["depreciationAndAmortization", "depreciation_and_amortization"],
  ["incomeBeforeTax", "income_before_tax"],
  ["incomeTaxExpense", "income_tax_expense"],
  ["netIncome", "net_income"],
  ["netIncomeRatio", "net_income_ratio"],
  ["eps", "eps"],
  ["epsdiluted", "eps_diluted"],
  ["weightedAverageShsOut", "weighted_average_shs_out"],
  ["weightedAverageShsOutDil", "weighted_average_shs_out_dil"],
];

const INCOME_SCHEMA = `(${STATEMENT_SPINE_SCHEMA},
  revenue DOUBLE, cost_of_revenue DOUBLE, gross_profit DOUBLE, gross_profit_ratio DOUBLE,
  operating_expenses DOUBLE, ebitda DOUBLE, ebitda_ratio DOUBLE,
  operating_income DOUBLE, operating_income_ratio DOUBLE,
  interest_income DOUBLE, interest_expense DOUBLE, depreciation_and_amortization DOUBLE,
  income_before_tax DOUBLE, income_tax_expense DOUBLE,
  net_income DOUBLE, net_income_ratio DOUBLE,
  eps DOUBLE, eps_diluted DOUBLE,
  weighted_average_shs_out DOUBLE, weighted_average_shs_out_dil DOUBLE)`;

const BALANCE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["cashAndCashEquivalents", "cash_and_cash_equivalents"],
  ["shortTermInvestments", "short_term_investments"],
  ["cashAndShortTermInvestments", "cash_and_short_term_investments"],
  ["netReceivables", "net_receivables"],
  ["inventory", "inventory"],
  ["totalCurrentAssets", "total_current_assets"],
  ["propertyPlantEquipmentNet", "property_plant_equipment_net"],
  ["goodwill", "goodwill"],
  ["intangibleAssets", "intangible_assets"],
  ["totalNonCurrentAssets", "total_non_current_assets"],
  ["totalAssets", "total_assets"],
  ["accountPayables", "account_payables"],
  ["shortTermDebt", "short_term_debt"],
  ["totalCurrentLiabilities", "total_current_liabilities"],
  ["longTermDebt", "long_term_debt"],
  ["totalNonCurrentLiabilities", "total_non_current_liabilities"],
  ["totalLiabilities", "total_liabilities"],
  ["commonStock", "common_stock"],
  ["retainedEarnings", "retained_earnings"],
  ["totalStockholdersEquity", "total_stockholders_equity"],
  ["totalDebt", "total_debt"],
  ["netDebt", "net_debt"],
];

const BALANCE_SCHEMA = `(${STATEMENT_SPINE_SCHEMA},
  cash_and_cash_equivalents DOUBLE, short_term_investments DOUBLE,
  cash_and_short_term_investments DOUBLE, net_receivables DOUBLE, inventory DOUBLE,
  total_current_assets DOUBLE, property_plant_equipment_net DOUBLE, goodwill DOUBLE,
  intangible_assets DOUBLE, total_non_current_assets DOUBLE, total_assets DOUBLE,
  account_payables DOUBLE, short_term_debt DOUBLE, total_current_liabilities DOUBLE,
  long_term_debt DOUBLE, total_non_current_liabilities DOUBLE, total_liabilities DOUBLE,
  common_stock DOUBLE, retained_earnings DOUBLE, total_stockholders_equity DOUBLE,
  total_debt DOUBLE, net_debt DOUBLE)`;

const CASH_FLOW_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["netIncome", "net_income"],
  ["depreciationAndAmortization", "depreciation_and_amortization"],
  ["stockBasedCompensation", "stock_based_compensation"],
  ["changeInWorkingCapital", "change_in_working_capital"],
  ["netCashProvidedByOperatingActivities", "net_cash_provided_by_operating_activities"],
  ["investmentsInPropertyPlantAndEquipment", "investments_in_property_plant_and_equipment"],
  ["acquisitionsNet", "acquisitions_net"],
  ["netCashUsedForInvestingActivites", "net_cash_used_for_investing_activities"],
  ["debtRepayment", "debt_repayment"],
  ["commonStockIssued", "common_stock_issued"],
  ["commonStockRepurchased", "common_stock_repurchased"],
  ["dividendsPaid", "dividends_paid"],
  ["netCashUsedProvidedByFinancingActivities", "net_cash_used_provided_by_financing_activities"],
  ["netChangeInCash", "net_change_in_cash"],
  ["cashAtEndOfPeriod", "cash_at_end_of_period"],
  ["operatingCashFlow", "operating_cash_flow"],
  ["capitalExpenditure", "capital_expenditure"],
  ["freeCashFlow", "free_cash_flow"],
];

const CASH_FLOW_SCHEMA = `(${STATEMENT_SPINE_SCHEMA},
  net_income DOUBLE, depreciation_and_amortization DOUBLE, stock_based_compensation DOUBLE,
  change_in_working_capital DOUBLE, net_cash_provided_by_operating_activities DOUBLE,
  investments_in_property_plant_and_equipment DOUBLE, acquisitions_net DOUBLE,
  net_cash_used_for_investing_activities DOUBLE, debt_repayment DOUBLE,
  common_stock_issued DOUBLE, common_stock_repurchased DOUBLE, dividends_paid DOUBLE,
  net_cash_used_provided_by_financing_activities DOUBLE, net_change_in_cash DOUBLE,
  cash_at_end_of_period DOUBLE, operating_cash_flow DOUBLE, capital_expenditure DOUBLE,
  free_cash_flow DOUBLE)`;

async function cmdStatement(
  req: DataRequest,
  pathPrefix: string,
  fieldMap: ReadonlyArray<readonly [string, string]>,
  schema: string,
  label: string,
): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };
  const period = (req.args.period as string | undefined) ?? "quarter";

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(`[fmp] ${label}: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC} req/sec`);

  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];
  let completed = 0;
  for (const t of tickers) {
    try {
      const resp = await getJson<FmpStatementRow[]>(
        `${pathPrefix}/${t}`,
        { period },
        "v3",
        limiter,
      );
      rows.push(...projectStatement(t, resp, fieldMap, ts));
    } catch (e) {
      console.error(`[fmp] ${label} ${t} failed:`, (e as Error).message);
    }
    completed++;
    if (completed % 50 === 0) {
      console.log(`[fmp] ${label} progress: ${completed}/${tickers.length}`);
    }
  }

  if (rows.length === 0) return { request: req, ok: false, error: `no ${label} rows` };

  await mergeAndWriteParquet({
    uri: req.output,
    schema,
    dedupKey: "ticker, fiscal_period_end, period",
    rows,
    orderBy: "ticker, fiscal_period_end",
  });
  return { request: req, ok: true, dataThrough: todayDate() };
}

async function cmdIncomeStatement(req: DataRequest): Promise<DataResult> {
  return cmdStatement(req, "income-statement", INCOME_FIELDS, INCOME_SCHEMA, "income_statement");
}

async function cmdBalanceSheet(req: DataRequest): Promise<DataResult> {
  return cmdStatement(
    req,
    "balance-sheet-statement",
    BALANCE_FIELDS,
    BALANCE_SCHEMA,
    "balance_sheet",
  );
}

async function cmdCashFlow(req: DataRequest): Promise<DataResult> {
  return cmdStatement(req, "cash-flow-statement", CASH_FLOW_FIELDS, CASH_FLOW_SCHEMA, "cash_flow");
}

// ── Kinds: historical key metrics + ratings ──────────────────────
// PEG-backtest enablers. `historical-key-metrics` returns quarterly
// fundamental ratios going back to ~2009; `historical-rating` returns
// daily FMP composite ratings (DCF / ROE / ROA / D-E / PE / PB
// sub-scores) on the same timescale.

const HISTORICAL_KEY_METRICS_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["peRatio", "pe"],
  ["pegRatio", "peg"],
  ["enterpriseValueOverEBITDA", "ev_ebitda"],
  ["debtToEquity", "debt_to_equity"],
  ["roe", "roe"],
  ["roic", "roic"],
  ["currentRatio", "current_ratio"],
  ["grossProfitMargin", "gross_margin"],
  ["operatingProfitMargin", "operating_margin"],
  ["netProfitMargin", "net_margin"],
];

const HISTORICAL_KEY_METRICS_SCHEMA = `(
  ticker VARCHAR, fiscal_period_end DATE, period VARCHAR, reported_currency VARCHAR,
  pe DOUBLE, peg DOUBLE, ev_ebitda DOUBLE, debt_to_equity DOUBLE,
  roe DOUBLE, roic DOUBLE, current_ratio DOUBLE,
  gross_margin DOUBLE, operating_margin DOUBLE, net_margin DOUBLE,
  last_updated_at TIMESTAMP
)`;

async function cmdHistoricalKeyMetrics(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };
  const period = (req.args.period as string | undefined) ?? "quarter";

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(
    `[fmp] historical_key_metrics: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC} req/sec`,
  );

  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];
  let completed = 0;
  for (const t of tickers) {
    try {
      const resp = await getJson<FmpStatementRow[]>(
        `historical-key-metrics/${t}`,
        { period },
        "v3",
        limiter,
      );
      rows.push(...projectStatement(t, resp, HISTORICAL_KEY_METRICS_FIELDS, ts));
    } catch (e) {
      console.error(`[fmp] historical_key_metrics ${t} failed:`, (e as Error).message);
    }
    completed++;
    if (completed % 50 === 0) {
      console.log(`[fmp] historical_key_metrics progress: ${completed}/${tickers.length}`);
    }
  }

  if (rows.length === 0) return { request: req, ok: false, error: "no key-metrics rows" };

  await mergeAndWriteParquet({
    uri: req.output,
    schema: HISTORICAL_KEY_METRICS_SCHEMA,
    dedupKey: "ticker, fiscal_period_end, period",
    rows,
    orderBy: "ticker, fiscal_period_end",
  });
  return { request: req, ok: true, dataThrough: todayDate() };
}

interface FmpHistoricalRatingRow {
  symbol?: string;
  date?: string;
  rating?: string | null;
  ratingScore?: number | null;
  ratingRecommendation?: string | null;
  ratingDetailsDCFScore?: number | null;
  ratingDetailsROEScore?: number | null;
  ratingDetailsROAScore?: number | null;
  ratingDetailsDEScore?: number | null;
  ratingDetailsPEScore?: number | null;
  ratingDetailsPBScore?: number | null;
}

export function parseHistoricalRatingRows(
  ticker: string,
  resp: FmpHistoricalRatingRow[],
  ts: string,
): Array<Record<string, unknown>> {
  return (resp ?? []).map((r) => ({
    ticker,
    date: r.date ?? null,
    rating: r.rating ?? null,
    rating_score: toFloat(r.ratingScore),
    rating_recommendation: r.ratingRecommendation ?? null,
    dcf_score: toFloat(r.ratingDetailsDCFScore),
    roe_score: toFloat(r.ratingDetailsROEScore),
    roa_score: toFloat(r.ratingDetailsROAScore),
    de_score: toFloat(r.ratingDetailsDEScore),
    pe_score: toFloat(r.ratingDetailsPEScore),
    pb_score: toFloat(r.ratingDetailsPBScore),
    last_updated_at: ts,
  }));
}

const HISTORICAL_RATING_SCHEMA = `(
  ticker VARCHAR, date DATE, rating VARCHAR, rating_score INTEGER,
  rating_recommendation VARCHAR,
  dcf_score INTEGER, roe_score INTEGER, roa_score INTEGER,
  de_score INTEGER, pe_score INTEGER, pb_score INTEGER,
  last_updated_at TIMESTAMP
)`;

async function cmdHistoricalRating(req: DataRequest): Promise<DataResult> {
  if (!req.output) return { request: req, ok: false, error: "missing output" };
  const universeRef = req.args.universe_parquet as string | undefined;
  if (!universeRef) return { request: req, ok: false, error: "missing args.universe_parquet" };

  const universeUri = universeRef.includes("://") ? universeRef : joinUri(universeRef);
  const universe = await readParquet<{ ticker: string }>(universeUri, { columns: ["ticker"] });
  const tickers = [...new Set(universe.map((r) => r.ticker).filter(Boolean))];

  const limiter = new RateLimiter(RATE_LIMIT_PER_SEC);
  console.log(`[fmp] historical_rating: ${tickers.length} tickers @ ${RATE_LIMIT_PER_SEC} req/sec`);

  const ts = nowUtcNoTz();
  const rows: Array<Record<string, unknown>> = [];
  let completed = 0;
  for (const t of tickers) {
    try {
      const resp = await getJson<FmpHistoricalRatingRow[]>(
        `historical-rating/${t}`,
        {},
        "v3",
        limiter,
      );
      rows.push(...parseHistoricalRatingRows(t, resp, ts));
    } catch (e) {
      console.error(`[fmp] historical_rating ${t} failed:`, (e as Error).message);
    }
    completed++;
    if (completed % 50 === 0) {
      console.log(`[fmp] historical_rating progress: ${completed}/${tickers.length}`);
    }
  }

  if (rows.length === 0) return { request: req, ok: false, error: "no rating rows" };

  await mergeAndWriteParquet({
    uri: req.output,
    schema: HISTORICAL_RATING_SCHEMA,
    dedupKey: "ticker, date",
    rows,
    orderBy: "ticker, date",
  });
  return { request: req, ok: true, dataThrough: todayDate() };
}

// ── Backfill registry ─────────────────────────────────────────────
// Used by scripts/fmp-backfill.ts (QF-191) to pull historical data
// per-ticker before any strategy backtests need it. The registry
// declares each kind's API path + parser + schema + dedup so the
// backfill script stays a thin orchestration layer rather than a
// duplicate of the adapter's per-kind code.
//
// The kind names are *output* names ("historical_dividends" etc.)
// and intentionally differ from the adapter's request kinds. The
// adapter is for scheduled cron refreshes; the backfill is a
// separate one-shot pipeline. Adapter kinds keep their existing
// names ("dividends", "splits", …) so the live manifests don't
// need to change.

export interface FmpBackfillSpec {
  /** Output identifier; also the parquet filename stem. */
  kind: string;
  /** FMP API path with the ticker substituted in. */
  apiPath: (ticker: string) => string;
  /** Optional URL params (e.g., `{ period: "quarter" }`). */
  apiParams?: Record<string, string>;
  /** Transform the raw JSON into row objects matching `schema`. */
  parse: (ticker: string, resp: unknown, ts: string) => Array<Record<string, unknown>>;
  /** DuckDB DDL for `mergeAndWriteParquet`. */
  schema: string;
  /** Comma-joined column list; rows uniqued on this in re-runs. */
  dedupKey: string;
  /** Comma-joined sort spec for the output parquet. */
  orderBy: string;
}

export const FMP_BACKFILL_KINDS: ReadonlyArray<FmpBackfillSpec> = [
  {
    kind: "historical_dividends",
    apiPath: (t) => `historical-price-full/stock_dividend/${t}`,
    parse: (t, resp, ts) => parseDividendRows(t, resp as FmpDividendResp, ts),
    schema: DIVIDEND_SCHEMA,
    dedupKey: "ticker, date",
    orderBy: "ticker, date",
  },
  {
    kind: "historical_splits",
    apiPath: (t) => `historical-price-full/stock_split/${t}`,
    parse: (t, resp, ts) => parseSplitRows(t, resp as FmpSplitResp, ts),
    schema: SPLIT_SCHEMA,
    dedupKey: "ticker, date",
    orderBy: "ticker, date",
  },
  {
    kind: "historical_income_statement",
    apiPath: (t) => `income-statement/${t}`,
    apiParams: { period: "quarter" },
    parse: (t, resp, ts) => projectStatement(t, resp as FmpStatementRow[], INCOME_FIELDS, ts),
    schema: INCOME_SCHEMA,
    dedupKey: "ticker, fiscal_period_end, period",
    orderBy: "ticker, fiscal_period_end",
  },
  {
    kind: "historical_balance_sheet",
    apiPath: (t) => `balance-sheet-statement/${t}`,
    apiParams: { period: "quarter" },
    parse: (t, resp, ts) => projectStatement(t, resp as FmpStatementRow[], BALANCE_FIELDS, ts),
    schema: BALANCE_SCHEMA,
    dedupKey: "ticker, fiscal_period_end, period",
    orderBy: "ticker, fiscal_period_end",
  },
  {
    kind: "historical_cash_flow",
    apiPath: (t) => `cash-flow-statement/${t}`,
    apiParams: { period: "quarter" },
    parse: (t, resp, ts) => projectStatement(t, resp as FmpStatementRow[], CASH_FLOW_FIELDS, ts),
    schema: CASH_FLOW_SCHEMA,
    dedupKey: "ticker, fiscal_period_end, period",
    orderBy: "ticker, fiscal_period_end",
  },
  {
    kind: "historical_key_metrics",
    apiPath: (t) => `historical-key-metrics/${t}`,
    apiParams: { period: "quarter" },
    parse: (t, resp, ts) =>
      projectStatement(t, resp as FmpStatementRow[], HISTORICAL_KEY_METRICS_FIELDS, ts),
    schema: HISTORICAL_KEY_METRICS_SCHEMA,
    dedupKey: "ticker, fiscal_period_end, period",
    orderBy: "ticker, fiscal_period_end",
  },
  {
    kind: "historical_rating",
    apiPath: (t) => `historical-rating/${t}`,
    parse: (t, resp, ts) => parseHistoricalRatingRows(t, resp as FmpHistoricalRatingRow[], ts),
    schema: HISTORICAL_RATING_SCHEMA,
    dedupKey: "ticker, date",
    orderBy: "ticker, date",
  },
];

/** FMP HTTP entry point exposed for scripts/fmp-backfill.ts. */
export async function fmpGetJson<T>(
  path: string,
  params: Record<string, string> = {},
  version = "v3",
): Promise<T> {
  return getJson<T>(path, params, version);
}

/** Construct a fresh rate limiter for ad-hoc callers (e.g., the backfill). */
export function makeFmpRateLimiter(perSec: number = RATE_LIMIT_PER_SEC): {
  acquire: () => Promise<void>;
} {
  return new RateLimiter(perSec);
}

// ── Adapter wiring ────────────────────────────────────────────────

export function createFmpAdapter(): DataAdapter {
  return {
    id: "fmp",
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
            case "analyst_estimates_history":
              res = await cmdAnalystEstimatesHistory(req);
              break;
            case "dividends":
              res = await cmdDividends(req);
              break;
            case "splits":
              res = await cmdSplits(req);
              break;
            case "income_statement":
              res = await cmdIncomeStatement(req);
              break;
            case "balance_sheet":
              res = await cmdBalanceSheet(req);
              break;
            case "cash_flow":
              res = await cmdCashFlow(req);
              break;
            case "historical_key_metrics":
              res = await cmdHistoricalKeyMetrics(req);
              break;
            case "historical_rating":
              res = await cmdHistoricalRating(req);
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
      const kind = String(args.kind ?? "");
      return [
        "universe",
        "fundamentals",
        "fundamentals_append",
        "earnings",
        "gics",
        "analyst_estimates_history",
        "dividends",
        "splits",
        "income_statement",
        "balance_sheet",
        "cash_flow",
        "historical_key_metrics",
        "historical_rating",
      ].includes(kind);
    },
  };
}
