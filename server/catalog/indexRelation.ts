// ── Symbol → Index Relation Lookup ────────────────────────────────
// Single-file classifier that answers "what is this symbol relative to
// the major indexes we care about?". Universe membership is parsed
// from config/universe.txt at construction time so the lists stay in
// sync with the trading universe.

import { readFileSync } from "node:fs";
import type { IndexRelation } from "./types.js";

const BROAD_ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "IVV", "VOO"]);
const VIX_DERIVED = new Set(["VIX", "VXX", "UVXY", "SVXY", "VIXY", "VIXM", "TVIX"]);
const SECTOR_ETFS = new Set([
  "XLE",
  "XLF",
  "XLI",
  "XLK",
  "XLP",
  "XLU",
  "XLV",
  "XLY",
  "XLB",
  "XLC",
  "XLRE",
  "XOP",
  "USO",
  "UNG",
  "DBA",
  "MOO",
  "JETS",
  "BDRY",
  "GDX",
  "SLV",
  "GLD",
]);

// Futures roots (after stripping a leading "/" and any month/year suffix)
const COMMODITY_ROOTS = new Set([
  "CL",
  "NG",
  "HO",
  "RB",
  "BZ",
  "GC",
  "SI",
  "HG",
  "PL",
  "PA",
  "ZC",
  "ZS",
  "ZW",
  "ZM",
  "ZL",
  "CT",
  "SB",
  "KC",
  "CC",
  "OJ",
]);

// FRED series / macro codes
const RATES_CODES = new Set([
  "fed_funds_rate",
  "treasury_2y",
  "treasury_10y",
  "treasury_10y2y_spread",
  "DGS2",
  "DGS10",
  "DGS30",
  "DFF",
  "T10Y2Y",
]);
const CREDIT_CODES = new Set(["hy_oas_spread", "BAMLH0A0HYM2", "BAMLC0A0CM"]);
const FX_CODES = new Set(["DTWEXBGS", "DXY"]);

export interface IndexRelationLookup {
  classify(symbol: string): IndexRelation;
}

// Strip common prefixes applied by producers so "EQ:SPY", "/CL", "CL.c.0",
// and "SPY" all collapse to the underlying ticker.
function normalize(raw: string): string {
  let s = raw.toUpperCase();
  if (s.includes(":")) s = s.slice(s.indexOf(":") + 1);
  if (s.startsWith("/")) s = s.slice(1);
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot);
  return s.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "");
}

// Parse config/universe.txt so component classification stays in sync
// with the list scripts/collect-nightly.sh uses.
function parseUniverse(path: string): { spx: Set<string>; ndxExtras: Set<string> } {
  const spx = new Set<string>();
  const ndxExtras = new Set<string>();
  let section: "broad" | "sector" | "spx" | "ndx" | "other" = "other";

  try {
    const text = readFileSync(path, "utf-8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("# ──") || /^#\s*S&P\s*500\s*Constituents/i.test(line)) {
        if (/Broad Market/i.test(line)) section = "broad";
        else if (/Sector|Thematic/i.test(line)) section = "sector";
        else if (/S&P\s*500\s*Constituents/i.test(line)) section = "spx";
        else if (/NASDAQ-100/i.test(line)) section = "ndx";
        else section = "other";
        continue;
      }
      if (!line || line.startsWith("#")) continue;
      if (section === "spx") spx.add(line);
      else if (section === "ndx") ndxExtras.add(line);
    }
  } catch {
    // Fall through with empty sets — classification degrades to "unrelated"
    // for components, which is acceptable rather than crashing startup.
  }
  return { spx, ndxExtras };
}

export function createIndexRelationLookup(universePath: string): IndexRelationLookup {
  const { spx, ndxExtras } = parseUniverse(universePath);

  return {
    classify(symbol: string): IndexRelation {
      if (!symbol) return "unrelated";
      const code = symbol.trim();

      // Direct-code matches (macro series, exact keys)
      if (RATES_CODES.has(code)) return "rates";
      if (CREDIT_CODES.has(code)) return "credit";
      if (FX_CODES.has(code)) return "fx";

      const ticker = normalize(code);
      if (BROAD_ETFS.has(ticker)) return "spx-index";
      if (VIX_DERIVED.has(ticker)) return "vix-derived";
      if (SECTOR_ETFS.has(ticker)) return "sector-etf";
      if (COMMODITY_ROOTS.has(ticker)) return "commodity";
      if (spx.has(ticker)) return "spx-component";
      if (ndxExtras.has(ticker)) return "ndx-extra";
      return "unrelated";
    },
  };
}
