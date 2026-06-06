// ── Canonical Symbol Parser/Formatter ──────────────────────────────
// One parser, one formatter. All symbol handling goes through this.
// Defined in: docs/tdd/signal-ingress.md, topic 1

import type { ParsedSymbol, SymbolClass } from "../../src/types/symbols.js";

// ── Constants ──────────────────────────────────────────────────────

const VALID_CLASSES = new Set<string>(["EQ", "OPT", "FUT", "FOP", "V"]);
const TOKEN_RE = /^[A-Z0-9_-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RIGHT_RE = /^[CP]$/;

// ── Parse ──────────────────────────────────────────────────────────

export function parse(s: string): ParsedSymbol {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error("Symbol must be a non-empty string");
  }

  const parts = s.split(":");
  const cls = parts[0] as SymbolClass;

  if (!VALID_CLASSES.has(cls)) {
    throw new Error(`Unknown symbol class: ${cls}`);
  }

  switch (cls) {
    case "EQ": {
      if (parts.length !== 2)
        throw new Error(`EQ symbol must have 2 parts, got ${parts.length}: ${s}`);
      const ticker = parts[1]!;
      if (!TOKEN_RE.test(ticker)) throw new Error(`Invalid ticker: ${ticker}`);
      return { class: "EQ", ticker };
    }

    case "OPT": {
      if (parts.length !== 5)
        throw new Error(`OPT symbol must have 5 parts, got ${parts.length}: ${s}`);
      const [, root, expiry, right, strikeStr] = parts;
      if (!TOKEN_RE.test(root!)) throw new Error(`Invalid root: ${root}`);
      if (!DATE_RE.test(expiry!)) throw new Error(`Invalid expiry date: ${expiry}`);
      if (!RIGHT_RE.test(right!)) throw new Error(`Invalid right: ${right}`);
      const strike = Number(strikeStr);
      if (!Number.isFinite(strike) || strike <= 0) throw new Error(`Invalid strike: ${strikeStr}`);
      return { class: "OPT", root: root!, expiry: expiry!, right: right! as "C" | "P", strike };
    }

    case "FUT": {
      if (parts.length !== 3)
        throw new Error(`FUT symbol must have 3 parts, got ${parts.length}: ${s}`);
      const [, root, contract] = parts;
      if (!TOKEN_RE.test(root!)) throw new Error(`Invalid root: ${root}`);
      if (
        !TOKEN_RE.test(contract!) &&
        !DATE_RE.test(contract!) &&
        !/^\d{4}-\d{2}$/.test(contract!)
      ) {
        throw new Error(`Invalid contract: ${contract}`);
      }
      return { class: "FUT", root: root!, contract: contract! };
    }

    case "FOP": {
      if (parts.length !== 6)
        throw new Error(`FOP symbol must have 6 parts, got ${parts.length}: ${s}`);
      const [, root, contract, expiry, right, strikeStr] = parts;
      // Allow both YYYY-MM and YYYY-MM-DD for contract
      if (!TOKEN_RE.test(root!)) throw new Error(`Invalid root: ${root}`);
      if (!DATE_RE.test(expiry!)) throw new Error(`Invalid expiry date: ${expiry}`);
      if (!RIGHT_RE.test(right!)) throw new Error(`Invalid right: ${right}`);
      const strike = Number(strikeStr);
      if (!Number.isFinite(strike) || strike <= 0) throw new Error(`Invalid strike: ${strikeStr}`);
      return {
        class: "FOP",
        root: root!,
        contract: contract!,
        expiry: expiry!,
        right: right! as "C" | "P",
        strike,
      };
    }

    case "V": {
      if (parts.length !== 2)
        throw new Error(`V symbol must have 2 parts, got ${parts.length}: ${s}`);
      const label = parts[1]!;
      // V symbols allow lowercase per TDD: [a-z0-9_-]+ for labels like "regime-spx-vol"
      if (!/^[A-Za-z0-9_-]+$/.test(label)) throw new Error(`Invalid virtual label: ${label}`);
      return { class: "V", label };
    }

    default:
      throw new Error(`Unhandled symbol class: ${cls}`);
  }
}

// ── Format ─────────────────────────────────────────────────────────

function formatStrike(strike: number): string {
  // No trailing zeros: 500, 4787.5
  return String(strike);
}

export function format(sym: ParsedSymbol): string {
  switch (sym.class) {
    case "EQ":
      return `EQ:${sym.ticker}`;
    case "OPT":
      return `OPT:${sym.root}:${sym.expiry}:${sym.right}:${formatStrike(sym.strike)}`;
    case "FUT":
      return `FUT:${sym.root}:${sym.contract}`;
    case "FOP":
      return `FOP:${sym.root}:${sym.contract}:${sym.expiry}:${sym.right}:${formatStrike(sym.strike)}`;
    case "V":
      return `V:${sym.label}`;
  }
}

// ── Subject Tokens (for NATS subject construction) ─────────────────

export function toSubjectTokens(sym: ParsedSymbol): string[] {
  // NATS uses "." as subject delimiter, so tokens must not contain dots.
  // Fractional strikes (e.g., 4787.5) use "_" as the decimal separator in subjects.
  function strikeToken(strike: number): string {
    return formatStrike(strike).replace(".", "_");
  }

  switch (sym.class) {
    case "EQ":
      return ["EQ", sym.ticker];
    case "OPT":
      return ["OPT", sym.root, sym.expiry, sym.right, strikeToken(sym.strike)];
    case "FUT":
      return ["FUT", sym.root, sym.contract];
    case "FOP":
      return ["FOP", sym.root, sym.contract, sym.expiry, sym.right, strikeToken(sym.strike)];
    case "V":
      return ["V", sym.label];
  }
}

// ── Filename helpers ───────────────────────────────────────────────

export function toFilename(symbolStr: string): string {
  return symbolStr.replace(/:/g, "-");
}

export function fromFilename(filename: string): string {
  // Reverse of toFilename: first token before first dash is the class
  // EQ-SPY → EQ:SPY, OPT-SPY-2026-01-16-C-500 → OPT:SPY:2026-01-16:C:500
  // This is lossy for dates (dashes are ambiguous). Use the class to guide reconstruction.
  const firstDash = filename.indexOf("-");
  if (firstDash === -1) return filename;

  const cls = filename.slice(0, firstDash);
  const rest = filename.slice(firstDash + 1);

  switch (cls) {
    case "EQ":
      return `EQ:${rest}`;
    case "OPT": {
      // SPY-2026-01-16-C-500 → SPY:2026-01-16:C:500
      const m = rest.match(/^([A-Z0-9_-]+?)-(\d{4}-\d{2}-\d{2})-([CP])-(.+)$/);
      if (m) return `OPT:${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
      break;
    }
    case "FUT": {
      // ES-2026-06 → FUT:ES:2026-06
      const m = rest.match(/^([A-Z0-9_-]+?)-(\d{4}-\d{2})$/);
      if (m) return `FUT:${m[1]}:${m[2]}`;
      break;
    }
    case "FOP": {
      const m = rest.match(/^([A-Z0-9_-]+?)-(\d{4}-\d{2})-(\d{4}-\d{2}-\d{2})-([CP])-(.+)$/);
      if (m) return `FOP:${m[1]}:${m[2]}:${m[3]}:${m[4]}:${m[5]}`;
      break;
    }
    case "V":
      return `V:${rest}`;
  }

  // Fallback: naive replacement (will break on dates but better than nothing)
  return filename.replace(/-/g, ":");
}
