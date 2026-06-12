// ── Schwab position parser (shared) ────────────────────────────────
// Pure, source-agnostic parser for Schwab account-snapshot position
// rows into the categorized `{options, equities, futures}` shape the
// GUI consumes. Extracted from schwab-rest.ts (QF-272) so the same
// logic serves BOTH sources of those rows:
//   * the schwab-rest REST fallback (direct /accounts?fields=positions)
//   * the NautilusTrader bridge (forwards the identical raw Schwab rows)
// Both paths feed `parseSchwabPositionRows` so /api/positions is
// byte-identical regardless of which source served the data.
//
// Greeks (delta/gamma/theta/vega) are intentionally null here: Schwab's
// positions snapshot omits them. Populating them from the market-data
// chain/streaming greeks is a separate follow-up — see QF-272 notes.

// ── Types ──────────────────────────────────────────────────────────

export interface OptionPosition {
  symbol: string;
  underlying: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface EquityPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
}

export interface FuturesPosition {
  // Full contract symbol (e.g. "/CLM26"). Contract month is encoded
  // in the third character: F G H J K M N Q U V X Z.
  symbol: string;
  // Root (e.g. "/CL"). Useful for grouping all CL contract months.
  root: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  dayPnl: number;
  unrealizedPnl: number;
}

export interface SchwabPositions {
  options: OptionPosition[];
  equities: EquityPosition[];
  futures: FuturesPosition[];
}

// ── Symbol parsing ─────────────────────────────────────────────────

export function parseOccSymbol(
  occ: string,
): { underlying: string; expiration: string; side: "call" | "put"; strike: number } | null {
  // OCC format: "SPY   260425P00638000" → underlying=SPY, exp=2026-04-25, side=put, strike=638
  const trimmed = occ.trim();
  const match = trimmed.match(/^(\w+)\s+(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, underlying, dateStr, pc, strikeStr] = match;
  const yy = dateStr!.slice(0, 2);
  const mm = dateStr!.slice(2, 4);
  const dd = dateStr!.slice(4, 6);
  return {
    underlying: underlying!,
    expiration: `20${yy}-${mm}-${dd}`,
    side: pc === "C" ? "call" : "put",
    strike: parseInt(strikeStr!, 10) / 1000,
  };
}

export function parseFuturesSymbol(symbol: string): string {
  // Schwab futures: "/CLM26" → "/CL", "./CLM26" → "/CL"
  const cleaned = symbol.replace(/^\./, "");
  const match = cleaned.match(/^(\/\w+)/);
  return match ? match[1]! : cleaned;
}

function parseFuturesOptionSymbol(inst: Record<string, unknown>): {
  underlying: string;
  expiration: string;
  side: "call" | "put";
  strike: number;
} {
  // Schwab futures options instrument fields:
  // symbol: "./CLM26 C85" or similar, putCall: "CALL"/"PUT",
  // strikePrice: 85, expirationDate: "2026-05-14"
  const symbol = (inst.symbol as string) ?? "";
  const underlying = parseFuturesSymbol(symbol.split(/\s/)[0] ?? symbol);
  const putCall = (inst.putCall as string) ?? "";
  const strike = (inst.strikePrice as number) ?? 0;
  const expDate = (inst.expirationDate as string) ?? "";
  // expirationDate may be ISO "2026-05-14T..." or "2026-05-14"
  const expiration = expDate.slice(0, 10);

  return {
    underlying,
    expiration,
    side: putCall.toUpperCase().startsWith("P") ? "put" : "call",
    strike,
  };
}

// ── Position parsing ───────────────────────────────────────────────

/**
 * Parse an array of raw Schwab position rows (the `positions` array from
 * a `/accounts?fields=positions` snapshot) into categorized positions.
 * Source-agnostic: the same rows arrive either from the REST fallback or
 * forwarded verbatim by the NT bridge.
 */
export function parseSchwabPositionRows(positions: Array<Record<string, unknown>>): SchwabPositions {
  const options: OptionPosition[] = [];
  const equities: EquityPosition[] = [];
  const futures: FuturesPosition[] = [];

  for (const pos of positions) {
    const inst = pos.instrument as Record<string, unknown> | undefined;
    if (!inst) continue;

    const assetType = inst.assetType as string;
    const longQty = (pos.longQuantity as number) ?? 0;
    const shortQty = (pos.shortQuantity as number) ?? 0;
    const quantity = longQty - shortQty;
    const avgCost = (pos.averagePrice as number) ?? 0;
    const mktVal = (pos.marketValue as number) ?? 0;
    const dayPnl = (pos.currentDayProfitLoss as number) ?? 0;
    const isOptionLike = assetType === "OPTION" || assetType === "FUTURE_OPTION";
    const multiplier = isOptionLike ? 100 : 1;
    const unrealizedPnl = mktVal - avgCost * Math.abs(quantity) * multiplier;

    if (assetType === "OPTION") {
      const occSym = (inst.symbol as string) ?? "";
      const parsed = parseOccSymbol(occSym);
      const putCall = (inst.putCall as string) ?? "";

      options.push({
        symbol: occSym,
        underlying: parsed?.underlying ?? (inst.underlyingSymbol as string) ?? "",
        side: parsed?.side ?? (putCall.toLowerCase().startsWith("p") ? "put" : "call"),
        strike: parsed?.strike ?? 0,
        expiration: parsed?.expiration ?? "",
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
      });
    } else if (assetType === "FUTURE_OPTION") {
      const parsed = parseFuturesOptionSymbol(inst);

      options.push({
        symbol: (inst.symbol as string) ?? "",
        underlying: parsed.underlying,
        side: parsed.side,
        strike: parsed.strike,
        expiration: parsed.expiration,
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
      });
    } else if (assetType === "FUTURE") {
      const fullSymbol = (inst.symbol as string) ?? "";
      futures.push({
        symbol: fullSymbol,
        root: parseFuturesSymbol(fullSymbol),
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
      });
    } else {
      equities.push({
        symbol: (inst.symbol as string) ?? "",
        quantity,
        averageCost: avgCost,
        marketValue: mktVal,
        dayPnl,
        unrealizedPnl,
      });
    }
  }

  return { options, equities, futures };
}

/**
 * Extract the `positions` array from a Schwab account snapshot (which
 * may be wrapped in `securitiesAccount`) and parse it. Convenience for
 * the REST path, which holds the full account object.
 */
export function parseSchwabAccountSnapshot(accountData: unknown): SchwabPositions {
  const raw = (accountData ?? {}) as Record<string, unknown>;
  const acct = (raw.securitiesAccount ?? raw) as Record<string, unknown>;
  const positions = (acct?.positions ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(positions)) return { options: [], equities: [], futures: [] };
  return parseSchwabPositionRows(positions);
}
