// QF-272 — shared Schwab position parser. Pins the categorized output
// (options / equities / futures) so /api/positions is identical whether
// the rows arrive via the REST fallback or the NT bridge. Greeks stay
// null (Schwab's positions snapshot omits them).

import { describe, it, expect } from "vitest";
import {
  parseSchwabPositionRows,
  parseSchwabAccountSnapshot,
  parseOccSymbol,
  parseFuturesSymbol,
} from "../../parse-schwab-positions.js";

describe("parseOccSymbol", () => {
  it("parses a standard OCC option symbol", () => {
    expect(parseOccSymbol("SPY   260619C00500000")).toEqual({
      underlying: "SPY",
      expiration: "2026-06-19",
      side: "call",
      strike: 500,
    });
  });

  it("parses a put with a fractional strike", () => {
    expect(parseOccSymbol("SPY   260425P00638500")).toEqual({
      underlying: "SPY",
      expiration: "2026-04-25",
      side: "put",
      strike: 638.5,
    });
  });

  it("returns null for a non-OCC symbol", () => {
    expect(parseOccSymbol("AAPL")).toBeNull();
  });
});

describe("parseFuturesSymbol", () => {
  it("strips a leading dot from the contract symbol", () => {
    // NB: the regex is greedy (\w+), so this returns the full contract,
    // not a 2-char root — behavior preserved verbatim from schwab-rest.
    expect(parseFuturesSymbol("/CLM26")).toBe("/CLM26");
    expect(parseFuturesSymbol("./CLM26")).toBe("/CLM26");
  });
});

describe("parseSchwabPositionRows", () => {
  it("categorizes an equity row", () => {
    const out = parseSchwabPositionRows([
      {
        instrument: { assetType: "EQUITY", symbol: "AAPL" },
        longQuantity: 100,
        shortQuantity: 0,
        averagePrice: 145.5,
        marketValue: 15000,
        currentDayProfitLoss: 120,
      },
    ]);
    expect(out.equities).toHaveLength(1);
    expect(out.options).toHaveLength(0);
    expect(out.futures).toHaveLength(0);
    expect(out.equities[0]).toMatchObject({
      symbol: "AAPL",
      quantity: 100,
      averageCost: 145.5,
      marketValue: 15000,
      dayPnl: 120,
    });
    // unrealizedPnl = mktVal - avgCost*|qty|*1
    expect(out.equities[0]!.unrealizedPnl).toBeCloseTo(15000 - 145.5 * 100, 5);
  });

  it("categorizes an option row (OCC) with null greeks + 100x multiplier", () => {
    const out = parseSchwabPositionRows([
      {
        instrument: {
          assetType: "OPTION",
          symbol: "SPY   260619C00500000",
          putCall: "CALL",
        },
        longQuantity: 0,
        shortQuantity: 2,
        averagePrice: 4.1,
        marketValue: -900,
        currentDayProfitLoss: -30,
      },
    ]);
    expect(out.options).toHaveLength(1);
    const opt = out.options[0]!;
    expect(opt).toMatchObject({
      symbol: "SPY   260619C00500000",
      underlying: "SPY",
      side: "call",
      strike: 500,
      expiration: "2026-06-19",
      quantity: -2,
    });
    expect(opt.delta).toBeNull();
    expect(opt.gamma).toBeNull();
    expect(opt.theta).toBeNull();
    expect(opt.vega).toBeNull();
    // 100x multiplier on option unrealizedPnl.
    expect(opt.unrealizedPnl).toBeCloseTo(-900 - 4.1 * 2 * 100, 5);
  });

  it("categorizes a futures row with its root", () => {
    const out = parseSchwabPositionRows([
      {
        instrument: { assetType: "FUTURE", symbol: "/CLM26" },
        longQuantity: 1,
        shortQuantity: 0,
        averagePrice: 78.2,
        marketValue: 78200,
        currentDayProfitLoss: 50,
      },
    ]);
    expect(out.futures).toHaveLength(1);
    expect(out.futures[0]).toMatchObject({ symbol: "/CLM26", root: "/CLM26", quantity: 1 });
  });

  it("skips rows without an instrument", () => {
    expect(parseSchwabPositionRows([{ longQuantity: 1 }])).toEqual({
      options: [],
      equities: [],
      futures: [],
    });
  });
});

describe("parseSchwabAccountSnapshot", () => {
  it("unwraps securitiesAccount.positions", () => {
    const out = parseSchwabAccountSnapshot({
      securitiesAccount: {
        positions: [
          {
            instrument: { assetType: "EQUITY", symbol: "MSFT" },
            longQuantity: 10,
            shortQuantity: 0,
            averagePrice: 400,
            marketValue: 4200,
            currentDayProfitLoss: 5,
          },
        ],
      },
    });
    expect(out.equities[0]?.symbol).toBe("MSFT");
  });

  it("returns empty when there are no positions", () => {
    expect(parseSchwabAccountSnapshot({ securitiesAccount: {} })).toEqual({
      options: [],
      equities: [],
      futures: [],
    });
  });
});
