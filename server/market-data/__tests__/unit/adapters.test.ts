import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAdapter as createMarketDataAdapter } from "../../adapters/marketdata.js";
import { createAdapter as createSchwabAdapter } from "../../adapters/schwab.js";
import { createAdapter as createIbkrAdapter } from "../../adapters/ibkr.js";

describe("MarketData.app adapter", () => {
  const originalEnv = process.env.MD_TOKEN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MD_TOKEN = originalEnv;
    } else {
      delete process.env.MD_TOKEN;
    }
  });

  it("has correct name", () => {
    const adapter = createMarketDataAdapter();
    expect(adapter.name).toBe("marketdata");
  });

  it("is available when MD_TOKEN is set", async () => {
    process.env.MD_TOKEN = "test-token";
    const adapter = createMarketDataAdapter();
    expect(await adapter.available()).toBe(true);
  });

  it("is unavailable when MD_TOKEN is empty", async () => {
    delete process.env.MD_TOKEN;
    const adapter = createMarketDataAdapter();
    expect(await adapter.available()).toBe(false);
  });

  it("returns null for stockQuote when unavailable", async () => {
    delete process.env.MD_TOKEN;
    const adapter = createMarketDataAdapter();
    expect(await adapter.stockQuote("SPY")).toBeNull();
  });

  it("does not support streaming", () => {
    const adapter = createMarketDataAdapter();
    expect(adapter.subscribeQuotes!(["SPY"], () => {})).toBeNull();
  });
});

describe("Schwab adapter", () => {
  const KEYS = ["SCHWAB_APP_KEY", "SCHWAB_APP_SECRET", "SCHWAB_REFRESH_TOKEN"];
  const savedKeys: Record<string, string | undefined> = {};
  for (const k of KEYS) savedKeys[k] = process.env[k];

  afterEach(() => {
    for (const k of KEYS) {
      if (savedKeys[k] !== undefined) process.env[k] = savedKeys[k];
      else delete process.env[k];
    }
  });

  it("has correct name", () => {
    const adapter = createSchwabAdapter();
    expect(adapter.name).toBe("schwab");
  });

  it("is unavailable without credentials", async () => {
    for (const k of KEYS) delete process.env[k];
    const adapter = createSchwabAdapter();
    expect(await adapter.available()).toBe(false);
  });

  it("does not support historical chains", async () => {
    const adapter = createSchwabAdapter();
    expect(await adapter.historicalChain("SPY", "2026-01-01", "2026-06-19")).toBeNull();
  });

  it("does not support streaming", () => {
    const adapter = createSchwabAdapter();
    expect(adapter.subscribeQuotes!(["SPY"], () => {})).toBeNull();
  });
});

describe("IBKR adapter", () => {
  it("has correct name", () => {
    const adapter = createIbkrAdapter();
    expect(adapter.name).toBe("ibkr");
  });

  it("does not support historical chains", async () => {
    const adapter = createIbkrAdapter();
    expect(await adapter.historicalChain("SPY", "2026-01-01", "2026-06-19")).toBeNull();
  });

  it("returns null for methods when not connected", async () => {
    const adapter = createIbkrAdapter({ timeout_ms: 100 });
    // Without a running IB Gateway, these should return null or fail gracefully
    expect(await adapter.stockQuote("SPY")).toBeNull();
    expect(await adapter.expirations("SPY")).toBeNull();
    expect(await adapter.chain("SPY", "2026-06-19")).toBeNull();
  });
});
