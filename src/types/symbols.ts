// ── Symbol Types ───────────────────────────────────────────────────
// Parsed canonical-symbol shapes shared across the order, portfolio,
// and symbol-conversion paths. Relocated out of src/types/signal.ts
// (QF-281) so they survive the retirement of the signal subsystem —
// these types are broker/instrument concerns, not signal-wire concerns.

export type SymbolClass = "EQ" | "OPT" | "FUT" | "FOP" | "V";

export interface EqSymbol {
  class: "EQ";
  ticker: string;
}

export interface OptSymbol {
  class: "OPT";
  root: string;
  expiry: string;
  right: "C" | "P";
  strike: number;
}

export interface FutSymbol {
  class: "FUT";
  root: string;
  contract: string;
}

export interface FopSymbol {
  class: "FOP";
  root: string;
  contract: string;
  expiry: string;
  right: "C" | "P";
  strike: number;
}

export interface VSymbol {
  class: "V";
  label: string;
}

export type ParsedSymbol = EqSymbol | OptSymbol | FutSymbol | FopSymbol | VSymbol;
