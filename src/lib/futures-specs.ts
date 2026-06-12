// ── Futures Contract Specifications ──────────────────────────────────────
// Multiplier, tick size, and metadata for common futures contracts.
// Used to determine position sizing, P&L scaling, and display formatting.

export interface FuturesSpec {
  name: string;
  multiplier: number;
  tickSize: number;
  tickValue: number;
  unit: string;
  exchange: string;
}

export const FUTURES_SPECS: Record<string, FuturesSpec> = {
  CL: {
    name: "Crude Oil",
    multiplier: 1000,
    tickSize: 0.01,
    tickValue: 10,
    unit: "bbl",
    exchange: "NYMEX",
  },
  ES: {
    name: "E-mini S&P 500",
    multiplier: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    unit: "idx",
    exchange: "CME",
  },
  NQ: {
    name: "E-mini Nasdaq 100",
    multiplier: 20,
    tickSize: 0.25,
    tickValue: 5.0,
    unit: "idx",
    exchange: "CME",
  },
  YM: {
    name: "E-mini Dow",
    multiplier: 5,
    tickSize: 1,
    tickValue: 5.0,
    unit: "idx",
    exchange: "CBOT",
  },
  RTY: {
    name: "E-mini Russell 2000",
    multiplier: 50,
    tickSize: 0.1,
    tickValue: 5.0,
    unit: "idx",
    exchange: "CME",
  },
  GC: {
    name: "Gold",
    multiplier: 100,
    tickSize: 0.1,
    tickValue: 10.0,
    unit: "oz",
    exchange: "COMEX",
  },
  SI: {
    name: "Silver",
    multiplier: 5000,
    tickSize: 0.005,
    tickValue: 25.0,
    unit: "oz",
    exchange: "COMEX",
  },
  HG: {
    name: "Copper",
    multiplier: 25000,
    tickSize: 0.0005,
    tickValue: 12.5,
    unit: "lb",
    exchange: "COMEX",
  },
  NG: {
    name: "Natural Gas",
    multiplier: 10000,
    tickSize: 0.001,
    tickValue: 10.0,
    unit: "mmBtu",
    exchange: "NYMEX",
  },
  ZB: {
    name: "30-Year T-Bond",
    multiplier: 1000,
    tickSize: 1 / 32,
    tickValue: 31.25,
    unit: "pts",
    exchange: "CBOT",
  },
  ZN: {
    name: "10-Year T-Note",
    multiplier: 1000,
    tickSize: 1 / 64,
    tickValue: 15.625,
    unit: "pts",
    exchange: "CBOT",
  },
  ZC: {
    name: "Corn",
    multiplier: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    unit: "bu",
    exchange: "CBOT",
  },
  ZS: {
    name: "Soybeans",
    multiplier: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    unit: "bu",
    exchange: "CBOT",
  },
  ZW: {
    name: "Wheat",
    multiplier: 50,
    tickSize: 0.25,
    tickValue: 12.5,
    unit: "bu",
    exchange: "CBOT",
  },
  "6E": {
    name: "Euro FX",
    multiplier: 125000,
    tickSize: 0.00005,
    tickValue: 6.25,
    unit: "EUR",
    exchange: "CME",
  },
};

// Extract the root symbol from a futures symbol like /CLM26 → CL
export function futuresRoot(symbol: string): string {
  const cleaned = symbol.replace(/^[./]+/, ""); // strip leading / or ./
  // Match 1-3 letter root, then month code + year digits
  const m = cleaned.match(/^([A-Z0-9]{1,3})[FGHJKMNQUVXZ]\d{1,2}$/);
  return m && m[1] !== undefined ? m[1] : cleaned;
}

// Get spec for a futures symbol
export function getFuturesSpec(symbol: string): FuturesSpec | null {
  return FUTURES_SPECS[futuresRoot(symbol)] || null;
}

// Check if a symbol looks like a futures symbol
export function isFuturesSymbol(symbol: string): boolean {
  return /^[./]/.test(symbol);
}
