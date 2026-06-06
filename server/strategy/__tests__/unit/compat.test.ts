import { describe, it, expect } from "vitest";
import { wrapLegacyStrategy, isLegacyStrategy, isCanonicalStrategy } from "../../compat.js";
import type { LegacyStrategy, StrategyContext } from "../../compat.js";

const mockLegacy: LegacyStrategy = {
  name: "test-strategy",
  shouldEnter(ctx) {
    if (ctx.spot > 0) {
      return [{ strike: 500, type: "Call", direction: "Short", qty: 1, expiration: "2026-06-19" }];
    }
    return [];
  },
  shouldExit(_ctx, openPositions) {
    return openPositions.filter((p) => p.type === "Call").map((p) => p.id);
  },
};

function makeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    spot: 500,
    chain: [],
    date: "2026-04-08",
    positions: [],
    cash: 100000,
    equity: 100000,
    mode: "backtest",
    ...overrides,
  };
}

describe("compat", () => {
  describe("wrapLegacyStrategy", () => {
    it("produces close actions from shouldExit before open from shouldEnter", () => {
      const wrapped = wrapLegacyStrategy(mockLegacy);
      const ctx = makeCtx({
        positions: [
          {
            position_id: "pos-1",
            symbol: "OPT:SPY:2026-06-19:C:500",
            strike: 500,
            type: "Call",
            direction: "Short",
            expiration: "2026-06-19",
          },
        ],
      });

      const actions = wrapped.evaluate(ctx);
      expect(actions.length).toBe(2);
      expect(actions[0]!.action).toBe("close");
      expect(actions[0]!.position_id).toBe("pos-1");
      expect(actions[1]!.action).toBe("open");
      expect(actions[1]!.strike).toBe(500);
    });

    it("preserves strategy name", () => {
      const wrapped = wrapLegacyStrategy(mockLegacy);
      expect(wrapped.name).toBe("test-strategy");
    });

    it("returns empty actions when no signals", () => {
      const noEntryStrategy: LegacyStrategy = {
        name: "no-entry",
        shouldEnter: () => [],
        shouldExit: () => [],
      };
      const wrapped = wrapLegacyStrategy(noEntryStrategy);
      expect(wrapped.evaluate(makeCtx())).toEqual([]);
    });
  });

  describe("detection helpers", () => {
    it("detects legacy strategy", () => {
      expect(isLegacyStrategy(mockLegacy)).toBe(true);
      expect(isLegacyStrategy({ evaluate: () => [] })).toBe(false);
    });

    it("detects canonical strategy", () => {
      const wrapped = wrapLegacyStrategy(mockLegacy);
      expect(isCanonicalStrategy(wrapped)).toBe(true);
      expect(isCanonicalStrategy(mockLegacy)).toBe(false);
    });
  });
});
