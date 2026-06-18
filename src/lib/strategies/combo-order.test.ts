import { describe, expect, it } from "vitest";
import type { Contract } from "../../types/market-data.js";
import type { ChainsByExpiration } from "../../types/option-strategy.js";
import { STRATEGY_TEMPLATES } from "./option-strategy-templates.js";
import { buildStrategy } from "./build-strategy.js";
import {
  allocateComboFillLegs,
  builtStrategyToComboLegs,
  builtStrategyToIntent,
  comboNetPrice,
} from "./combo-order.js";

const SPOT = 100;
const STRIKES = [90, 95, 100, 105, 110];
const EXP = "2026-07-17";

function chain(): Contract[] {
  return STRIKES.flatMap((k): Contract[] =>
    (["call", "put"] as const).map((side) => {
      const intrinsic = side === "call" ? Math.max(SPOT - k, 0) : Math.max(k - SPOT, 0);
      const mid = Number((intrinsic + Math.max(0, 3 - Math.abs(k - SPOT) / 10)).toFixed(2));
      return {
        symbol: `SPY_${side}${k}`,
        underlying: "SPY",
        expiration: EXP,
        side,
        strike: k,
        dte: 30,
        bid: mid - 0.05,
        ask: mid + 0.05,
        mid,
        last: mid,
        volume: 1,
        openInterest: 1,
        underlyingPrice: SPOT,
        iv: 0.2,
        delta: side === "call" ? 0.5 : -0.5,
        gamma: 0.02,
        theta: -0.04,
        vega: 0.1,
      };
    }),
  );
}

const CHAINS: ChainsByExpiration = new Map([[EXP, chain()]]);
const vertical = buildStrategy(STRATEGY_TEMPLATES["vertical-call-debit"], CHAINS, {
  expirations: [EXP],
});

describe("builtStrategyToComboLegs", () => {
  it("maps each resolved leg to a spec with symbol/strike/side/ratio", () => {
    const legs = builtStrategyToComboLegs(vertical);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ right: "call", side: "buy", ratio: 1, strike: 100 });
    expect(legs[1]).toMatchObject({ right: "call", side: "sell", strike: 105 });
    expect(legs[0]!.option_symbol).toBe("SPY_call100");
    expect(new Set(legs.map((l) => l.leg_id)).size).toBe(2); // unique ids
  });
});

describe("comboNetPrice", () => {
  it("is a positive net debit for a bull call spread (buy lower, sell higher)", () => {
    const net = comboNetPrice(vertical.legs);
    expect(net).toBeGreaterThan(0);
    // buy 100C mid − sell 105C mid
    const buy = vertical.legs[0]!.contract.mid;
    const sell = vertical.legs[1]!.contract.mid;
    expect(net).toBeCloseTo(buy - sell, 4);
  });
});

describe("builtStrategyToIntent", () => {
  const intent = builtStrategyToIntent(vertical, {
    intent_id: "i1",
    portfolio: "p1",
    strategy_id: "s1",
    quantity: 3,
    reason: "test",
    created_at: "2026-07-01T00:00:00Z",
    order_type: "limit",
  });

  it("produces a combo intent: underlying symbol, child legs, net limit price", () => {
    expect(intent.symbol).toBe("SPY");
    expect(intent.quantity).toBe(3);
    expect(intent.legs).toHaveLength(2);
    expect(intent.order_type).toBe("limit");
    expect(intent.limit_price).toBeCloseTo(comboNetPrice(vertical.legs), 4);
  });

  it("defaults to a market combo when order_type omitted", () => {
    const mkt = builtStrategyToIntent(vertical, {
      intent_id: "i2",
      portfolio: "p1",
      strategy_id: "s1",
      quantity: 1,
      reason: "t",
      created_at: "2026-07-01T00:00:00Z",
    });
    expect(mkt.order_type).toBeUndefined();
    expect(mkt.legs).toHaveLength(2);
  });
});

describe("allocateComboFillLegs", () => {
  it("allocates filled quantity as combo units × leg ratio", () => {
    const legs = builtStrategyToComboLegs(
      buildStrategy(STRATEGY_TEMPLATES["call-butterfly"], CHAINS, { expirations: [EXP] }),
    );
    const filled = allocateComboFillLegs(legs, 2); // 2 combo units
    // butterfly body has ratio 2 → 4 contracts; wings ratio 1 → 2 each
    expect(filled.find((l) => l.ratio === 2)!.filled_quantity).toBe(4);
    expect(filled.filter((l) => l.ratio === 1).every((l) => l.filled_quantity === 2)).toBe(true);
  });

  it("attaches per-leg avg price when leg mids are supplied", () => {
    const legs = builtStrategyToComboLegs(vertical);
    const filled = allocateComboFillLegs(legs, 1, { [legs[0]!.leg_id]: 2.5 });
    expect(filled[0]!.average_fill_price).toBe(2.5);
    expect(filled[1]!.average_fill_price).toBeUndefined();
  });
});
