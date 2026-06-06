import { describe, it, expect } from "vitest";
import { createAdapter, toDatabentoSymbol } from "../databento.js";

describe("toDatabentoSymbol", () => {
  it("converts /ES futures symbol to ES.c.0 continuous form", () => {
    expect(toDatabentoSymbol("/ES")).toBe("ES.c.0");
  });

  it("uppercases lowercase futures", () => {
    expect(toDatabentoSymbol("/cl")).toBe("CL.c.0");
  });

  it("leaves already-mapped symbols alone", () => {
    expect(toDatabentoSymbol("ES.c.0")).toBe("ES.c.0");
  });

  it("uppercases bare equity symbols", () => {
    expect(toDatabentoSymbol("spy")).toBe("SPY");
  });
});

describe("Databento adapter (no NATS)", () => {
  it("has correct name", () => {
    const adapter = createAdapter();
    expect(adapter.name).toBe("databento");
  });

  it("is unavailable when NATS connection is missing", async () => {
    const adapter = createAdapter();
    expect(await adapter.available()).toBe(false);
  });

  it("returns null for stockQuote without cached data", async () => {
    const adapter = createAdapter();
    expect(await adapter.stockQuote("/ES")).toBeNull();
  });

  it("returns null for chain (live adapter is quotes/trades only)", async () => {
    const adapter = createAdapter();
    expect(await adapter.chain("/ES", "2026-06-19")).toBeNull();
  });

  it("returns null for historicalChain (Parquet path is separate)", async () => {
    const adapter = createAdapter();
    expect(await adapter.historicalChain("/ES", "2024-01-01", "2026-06-19")).toBeNull();
  });

  it("subscribeQuotes returns a subscription that can be unsubscribed", () => {
    const adapter = createAdapter();
    const sub = adapter.subscribeQuotes!(["/ES"], () => {});
    expect(sub).not.toBeNull();
    expect(typeof sub!.unsubscribe).toBe("function");
    sub!.unsubscribe();
  });
});
