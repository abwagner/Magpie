// QF-355 — join held option positions to the live MD chain greeks.
// Verifies matched options get filled, unmatched / failed-chain options
// keep null greeks, chains are de-duped per (underlying, expiration),
// and equities/futures pass through untouched.

import { describe, it, expect, vi } from "vitest";
import type { MarketDataService, Contract } from "../../../../src/types/market-data.js";
import type {
  OptionPosition,
  SchwabPositions,
} from "../../../order/positions/parse-schwab-positions.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import { enrichPositionGreeks } from "../../enrich-position-greeks.js";

function contract(over: Partial<Contract>): Contract {
  return {
    symbol: "SPY",
    underlying: "SPY",
    expiration: "2026-06-19",
    side: "call",
    strike: 500,
    dte: 13,
    bid: 1,
    ask: 1.1,
    mid: 1.05,
    last: 1.05,
    volume: 0,
    openInterest: 0,
    underlyingPrice: 505,
    iv: 0.2,
    delta: 0.5,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.03,
    ...over,
  };
}

function opt(over: Partial<OptionPosition>): OptionPosition {
  return {
    symbol: "SPY   260619C00500000",
    underlying: "SPY",
    side: "call",
    strike: 500,
    expiration: "2026-06-19",
    quantity: 1,
    averageCost: 4,
    marketValue: 105,
    dayPnl: 0,
    unrealizedPnl: 0,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    ...over,
  };
}

function positions(over: Partial<SchwabPositions>): SchwabPositions {
  return { options: [], equities: [], futures: [], ...over };
}

function serviceWith(getChain: MarketDataService["getChain"]): MarketDataService {
  return { getChain } as unknown as MarketDataService;
}

describe("enrichPositionGreeks", () => {
  it("fills greeks for an option matched in the chain", async () => {
    const svc = serviceWith(
      vi.fn().mockResolvedValue([
        contract({ strike: 495, delta: 0.6 }),
        contract({ strike: 500, delta: 0.52, gamma: 0.015, theta: -0.08, vega: 0.22 }),
      ]),
    );
    const out = await enrichPositionGreeks(
      positions({ options: [opt({ strike: 500 })] }),
      svc,
      createTestLogger(),
    );
    expect(out.options[0]).toMatchObject({
      delta: 0.52,
      gamma: 0.015,
      theta: -0.08,
      vega: 0.22,
    });
  });

  it("matches strike + side (a put is not filled from a call row)", async () => {
    const svc = serviceWith(
      vi.fn().mockResolvedValue([
        contract({ side: "call", strike: 500, delta: 0.52 }),
        contract({ side: "put", strike: 500, delta: -0.48 }),
      ]),
    );
    const out = await enrichPositionGreeks(
      positions({ options: [opt({ side: "put", strike: 500 })] }),
      svc,
      createTestLogger(),
    );
    expect(out.options[0]!.delta).toBe(-0.48);
  });

  it("leaves greeks null when the strike isn't in the chain", async () => {
    const svc = serviceWith(vi.fn().mockResolvedValue([contract({ strike: 495 })]));
    const out = await enrichPositionGreeks(
      positions({ options: [opt({ strike: 777 })] }),
      svc,
      createTestLogger(),
    );
    expect(out.options[0]).toMatchObject({
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
    });
  });

  it("leaves greeks null (and keeps serving) when the chain fetch fails", async () => {
    const svc = serviceWith(vi.fn().mockRejectedValue(new Error("MD down")));
    const out = await enrichPositionGreeks(
      positions({ options: [opt({})] }),
      svc,
      createTestLogger(),
    );
    expect(out.options[0]!.delta).toBeNull();
  });

  it("de-dupes chain fetches per (underlying, expiration)", async () => {
    const getChain = vi.fn().mockResolvedValue([
      contract({ strike: 500, delta: 0.52 }),
      contract({ strike: 510, delta: 0.4 }),
    ]);
    const out = await enrichPositionGreeks(
      positions({
        options: [
          opt({ strike: 500 }),
          opt({ strike: 510, symbol: "SPY   260619C00510000" }),
        ],
      }),
      serviceWith(getChain),
      createTestLogger(),
    );
    // Two legs, same underlying+expiry → one chain fetch.
    expect(getChain).toHaveBeenCalledTimes(1);
    expect(getChain).toHaveBeenCalledWith("SPY", "2026-06-19");
    expect(out.options[0]!.delta).toBe(0.52);
    expect(out.options[1]!.delta).toBe(0.4);
  });

  it("fetches a separate chain per distinct expiration", async () => {
    const getChain = vi
      .fn()
      .mockResolvedValueOnce([contract({ expiration: "2026-06-19", strike: 500 })])
      .mockResolvedValueOnce([contract({ expiration: "2026-07-17", strike: 500, delta: 0.7 })]);
    const out = await enrichPositionGreeks(
      positions({
        options: [
          opt({ expiration: "2026-06-19" }),
          opt({ expiration: "2026-07-17" }),
        ],
      }),
      serviceWith(getChain),
      createTestLogger(),
    );
    expect(getChain).toHaveBeenCalledTimes(2);
    expect(out.options[1]!.delta).toBe(0.7);
  });

  it("no options → returns input without touching the service", async () => {
    const getChain = vi.fn();
    const input = positions({ equities: [{ symbol: "AAPL" } as never] });
    const out = await enrichPositionGreeks(input, serviceWith(getChain), createTestLogger());
    expect(getChain).not.toHaveBeenCalled();
    expect(out).toBe(input);
  });
});
