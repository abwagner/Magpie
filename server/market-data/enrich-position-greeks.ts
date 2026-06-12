// ── Position greek enrichment (QF-355) ─────────────────────────────
// Schwab's positions snapshot omits per-contract greeks, so held
// options arrive with delta/gamma/theta/vega = null (see
// parse-schwab-positions.ts). This joins each held option to the live
// option-chain greeks the MarketDataService already serves (Schwab
// /chains, with the Black-76 compute-fallback for futures options),
// keyed by (underlying, expiration, strike, side), and fills the
// fields.
//
// Source-agnostic: runs over the categorized positions regardless of
// whether they arrived via the NT bridge or the schwab-rest fallback.
// A chain fetch that fails (or an option with no matching contract)
// leaves that option's greeks null rather than failing the request —
// /api/positions degrades to the pre-QF-355 behaviour for that row.

import type { MarketDataService, Contract } from "../../src/types/market-data.js";
import type { SchwabPositions } from "../order/positions/parse-schwab-positions.js";
import type { Logger } from "../logger.js";

// Schwab strikes are clean decimals (e.g. 425, 638.5); match with a
// tolerance anyway so float round-trips through JSON never miss.
const STRIKE_EPS = 1e-6;

export async function enrichPositionGreeks(
  positions: SchwabPositions,
  service: MarketDataService,
  logger: Logger,
): Promise<SchwabPositions> {
  if (positions.options.length === 0) return positions;

  // One chain fetch per distinct (underlying, expiration); the service
  // caches, but de-duping here keeps a multi-leg position to a single
  // round trip per expiry.
  const targets = new Map<string, { underlying: string; expiration: string }>();
  for (const opt of positions.options) {
    targets.set(chainKey(opt.underlying, opt.expiration), {
      underlying: opt.underlying,
      expiration: opt.expiration,
    });
  }

  const chains = new Map<string, Contract[]>();
  await Promise.all(
    [...targets].map(async ([key, t]) => {
      try {
        chains.set(key, await service.getChain(t.underlying, t.expiration));
      } catch (e) {
        logger.warn("greek enrichment: chain fetch failed", {
          underlying: t.underlying,
          expiration: t.expiration,
          error: String(e),
        });
      }
    }),
  );

  const options = positions.options.map((opt) => {
    const chain = chains.get(chainKey(opt.underlying, opt.expiration));
    const match = chain?.find(
      (c) => c.side === opt.side && Math.abs(c.strike - opt.strike) < STRIKE_EPS,
    );
    if (!match) return opt;
    return {
      ...opt,
      delta: match.delta,
      gamma: match.gamma,
      theta: match.theta,
      vega: match.vega,
    };
  });

  return { ...positions, options };
}

function chainKey(underlying: string, expiration: string): string {
  return `${underlying} ${expiration}`;
}
