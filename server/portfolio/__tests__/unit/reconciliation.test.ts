import { describe, it, expect } from "vitest";
import { reconcile } from "../../reconciliation.js";
import type { PortfolioEngine } from "../../engine.js";
import type { BrokerPosition } from "../../../../src/types/order.js";

function mockEngine(
  positions: Array<{ symbol: string; direction: string; quantity: number }>,
): PortfolioEngine {
  return {
    getState: () => ({
      positions: positions.map((p, i) => ({
        position_id: `pos-${i}`,
        ...p,
      })),
      cash: 100000,
      equity: 100000,
      daily_realized_pnl: 0,
      halted: false,
      halt_reason: null,
    }),
  } as unknown as PortfolioEngine;
}

describe("reconciliation", () => {
  it("reports match when positions are identical", () => {
    const engine = mockEngine([{ symbol: "OPT:SPY:C:500", direction: "Short", quantity: 1 }]);
    const broker: BrokerPosition[] = [{ symbol: "OPT:SPY:C:500", direction: "Short", quantity: 1 }];

    const result = reconcile(engine, "main", broker);
    expect(result.match).toBe(true);
    expect(result.drifts).toEqual([]);
  });

  it("detects quantity mismatch", () => {
    const engine = mockEngine([{ symbol: "OPT:SPY:C:500", direction: "Short", quantity: 2 }]);
    const broker: BrokerPosition[] = [{ symbol: "OPT:SPY:C:500", direction: "Short", quantity: 1 }];

    const result = reconcile(engine, "main", broker);
    expect(result.match).toBe(false);
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]!.type).toBe("quantity_mismatch");
    expect(result.drifts[0]!.internal_qty).toBe(2);
    expect(result.drifts[0]!.broker_qty).toBe(1);
  });

  it("detects missing at broker", () => {
    const engine = mockEngine([{ symbol: "OPT:SPY:C:500", direction: "Short", quantity: 1 }]);

    const result = reconcile(engine, "main", []);
    expect(result.match).toBe(false);
    expect(result.drifts[0]!.type).toBe("missing_at_broker");
    expect(result.drifts[0]!.broker_qty).toBe(0);
  });

  it("detects missing internally", () => {
    const engine = mockEngine([]);
    const broker: BrokerPosition[] = [{ symbol: "OPT:SPY:C:500", direction: "Short", quantity: 1 }];

    const result = reconcile(engine, "main", broker);
    expect(result.match).toBe(false);
    expect(result.drifts[0]!.type).toBe("missing_internally");
    expect(result.drifts[0]!.internal_qty).toBe(0);
  });

  it("handles multiple positions with mixed matches", () => {
    const engine = mockEngine([
      { symbol: "OPT:SPY:C:500", direction: "Short", quantity: 1 }, // matches
      { symbol: "OPT:SPY:P:500", direction: "Short", quantity: 2 }, // mismatch
    ]);
    const broker: BrokerPosition[] = [
      { symbol: "OPT:SPY:C:500", direction: "Short", quantity: 1 },
      { symbol: "OPT:SPY:P:500", direction: "Short", quantity: 1 },
    ];

    const result = reconcile(engine, "main", broker);
    expect(result.match).toBe(false);
    expect(result.drifts).toHaveLength(1);
    // reconcile splits key on ":" and takes first token for symbol
    expect(result.drifts[0]!.symbol).toBe("OPT");
  });

  it("reports match for empty positions on both sides", () => {
    const result = reconcile(mockEngine([]), "main", []);
    expect(result.match).toBe(true);
    expect(result.drifts).toEqual([]);
  });
});
