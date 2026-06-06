import { describe, it, expect } from "vitest";
import { computeFillPrice } from "../../fill-model.js";

describe("fill-model", () => {
  describe("basic spread mechanics", () => {
    it("buy fills above mid, sell fills below mid", () => {
      const buy = computeFillPrice({ bid: 10, ask: 11, direction: "buy" });
      const sell = computeFillPrice({ bid: 10, ask: 11, direction: "sell" });
      expect(buy.price).toBeGreaterThan(buy.mid);
      expect(sell.price).toBeLessThan(sell.mid);
    });

    it("mid is average of bid and ask", () => {
      const result = computeFillPrice({ bid: 10, ask: 12, direction: "buy" });
      expect(result.mid).toBe(11);
      expect(result.spread).toBe(2);
    });

    it("zero spread fills at mid", () => {
      const buy = computeFillPrice({ bid: 10, ask: 10, direction: "buy" });
      expect(buy.price).toBe(10);
      expect(buy.spread).toBe(0);
    });

    it("price never exceeds ask for buys", () => {
      const result = computeFillPrice({
        bid: 10,
        ask: 11,
        direction: "buy",
        volume: 0,
        openInterest: 0,
        quantity: 1000,
      });
      expect(result.price).toBeLessThanOrEqual(11);
    });

    it("price never goes below bid for sells", () => {
      const result = computeFillPrice({
        bid: 10,
        ask: 11,
        direction: "sell",
        volume: 0,
        openInterest: 0,
        quantity: 1000,
      });
      expect(result.price).toBeGreaterThanOrEqual(10);
    });
  });

  describe("liquidity scoring", () => {
    it("high volume + high OI → fills closer to mid", () => {
      const liquid = computeFillPrice({
        bid: 10,
        ask: 11,
        direction: "buy",
        volume: 50000,
        openInterest: 100000,
      });
      const illiquid = computeFillPrice({
        bid: 10,
        ask: 11,
        direction: "buy",
        volume: 1,
        openInterest: 1,
      });
      expect(liquid.price).toBeLessThan(illiquid.price);
      expect(liquid.liquidityScore).toBeGreaterThan(illiquid.liquidityScore);
    });

    it("missing volume/OI uses moderate default (~0.5)", () => {
      const result = computeFillPrice({ bid: 10, ask: 11, direction: "buy" });
      // Default liquidity = 0.5 * 0.5 = 0.25 (no data for either)
      // But actually DEFAULT_LIQUIDITY is used for each missing field
      expect(result.liquidityScore).toBe(0.25);
    });

    it("volume=10000 and OI=10000 gives liquidity near 1.0", () => {
      const result = computeFillPrice({
        bid: 10,
        ask: 11,
        direction: "buy",
        volume: 10000,
        openInterest: 10000,
      });
      expect(result.liquidityScore).toBeCloseTo(1, 1);
    });

    it("volume=0 gives minimum volume score", () => {
      const result = computeFillPrice({
        bid: 10,
        ask: 11,
        direction: "buy",
        volume: 0,
        openInterest: 10000,
      });
      // log10(max(1,0))/4 = 0
      expect(result.liquidityScore).toBe(0);
    });
  });

  describe("size impact", () => {
    it("small orders (<=10) have no size impact", () => {
      const one = computeFillPrice({ bid: 10, ask: 11, direction: "buy", quantity: 1 });
      const ten = computeFillPrice({ bid: 10, ask: 11, direction: "buy", quantity: 10 });
      expect(one.slippageFraction).toBe(ten.slippageFraction);
    });

    it("large orders get worse fills", () => {
      const small = computeFillPrice({ bid: 10, ask: 11, direction: "buy", quantity: 1 });
      const large = computeFillPrice({ bid: 10, ask: 11, direction: "buy", quantity: 100 });
      expect(large.price).toBeGreaterThan(small.price);
      expect(large.slippageFraction).toBeGreaterThan(small.slippageFraction);
    });
  });

  describe("degraded mode (backtest compatibility)", () => {
    it("works with only bid/ask/direction (no volume/OI)", () => {
      const result = computeFillPrice({ bid: 5, ask: 6, direction: "buy" });
      expect(result.price).toBeGreaterThan(5);
      expect(result.price).toBeLessThanOrEqual(6);
      // Should approximate the old 75% model:
      // mid=5.5, default liquidity=0.25, slippage=0.5+0.4*(1-0.25)=0.8
      // price = 5.5 + 0.8 * 0.5 = 5.9 → close to 75% toward ask
      expect(result.price).toBeCloseTo(5.9, 1);
    });

    it("closely matches old 75% model when no liquidity data", () => {
      // Old model: mid + 0.75 * spread/2
      const bid = 10,
        ask = 12;
      const oldPrice = (bid + ask) / 2 + (0.75 * (ask - bid)) / 2; // 11 + 0.75 = 11.75
      const newResult = computeFillPrice({ bid, ask, direction: "buy" });
      // Should be in the same ballpark (within 10% of spread)
      expect(Math.abs(newResult.price - oldPrice)).toBeLessThan(0.2);
    });
  });

  describe("rounding", () => {
    it("rounds to cents", () => {
      const result = computeFillPrice({ bid: 10.123, ask: 10.456, direction: "buy" });
      const decimals = result.price.toString().split(".")[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(2);
    });
  });
});
