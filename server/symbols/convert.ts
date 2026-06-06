// ── Symbol Conversion ──────────────────────────────────────────────
// The ONLY place where contract ↔ canonical conversion happens.
// Defined in: docs/TRADING-SYSTEM-TDD.md, "Symbol formats and conversion"

import { parse, format } from "./symbol.js";
import type { ParsedSymbol } from "../../src/types/symbols.js";

// ── Contract → Canonical ───────────────────────────────────────────

interface ContractFields {
  underlying: string;
  strike?: number;
  side?: "call" | "put";
  expiration?: string;
}

export function contractToCanonical(contract: ContractFields): string {
  if (contract.strike != null && contract.side != null && contract.expiration != null) {
    return format({
      class: "OPT",
      root: contract.underlying,
      expiry: contract.expiration,
      right: contract.side === "call" ? "C" : "P",
      strike: contract.strike,
    });
  }

  // Equity
  return format({ class: "EQ", ticker: contract.underlying });
}

// ── Canonical → Contract Fields ────────────────────────────────────

export function canonicalToContractFields(canonicalSymbol: string): ContractFields {
  const parsed = parse(canonicalSymbol);

  switch (parsed.class) {
    case "EQ":
      return { underlying: parsed.ticker };

    case "OPT":
      return {
        underlying: parsed.root,
        strike: parsed.strike,
        side: parsed.right === "C" ? "call" : "put",
        expiration: parsed.expiry,
      };

    case "FUT":
      return { underlying: parsed.root };

    case "FOP":
      return {
        underlying: parsed.root,
        strike: parsed.strike,
        side: parsed.right === "C" ? "call" : "put",
        expiration: parsed.expiry,
      };

    case "V":
      return { underlying: parsed.label };
  }
}

// ── Canonical → Underlying ─────────────────────────────────────────

export function canonicalToUnderlying(canonicalSymbol: string): string {
  const parsed = parse(canonicalSymbol);

  switch (parsed.class) {
    case "EQ":
      return parsed.ticker;
    case "OPT":
      return parsed.root;
    case "FUT":
      return parsed.root;
    case "FOP":
      return parsed.root;
    case "V":
      return parsed.label;
  }
}
