// ── Symbol Classification ──────────────────────────────────────────
// Single source of truth for "is this ticker an index?" — used by every
// market-data adapter to decide routing. Each adapter keeps its own
// vendor-specific transform (Schwab's $ prefix, MD's /indices path, etc.)
// but reads classification from here so we don't drift as we add tickers.

// Canonical index tickers (unprefixed common form). Add entries here
// when a new index needs supported; each adapter's transform table
// should key off these same tickers.
export const INDEX_TICKERS = new Set<string>([
  "VIX",
  "VIX9D",
  "VVIX",
  "SPX",
  "NDX",
  "RUT",
  "DJI",
  "COMPX",
]);

export function isIndex(symbol: string): boolean {
  return INDEX_TICKERS.has(symbol.toUpperCase());
}

// Futures symbols start with `/` (e.g. /ES, /CL, /NQ).
export function isFutures(symbol: string): boolean {
  return symbol.startsWith("/");
}
