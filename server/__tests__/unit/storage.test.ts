// ── server/storage.ts smoke test ─────────────────────────────────
// Round-trip chains data via a temp file:// DATA_URI to validate the
// withDb-backed port: hasData, getDates, getChain, storeChain
// (atomic full-day replacement), getSummary, getSymbolDetail,
// getExpirations, getUnderlyingPrice.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "qf-storage-"));
const originalDataUri = process.env.DATA_URI;
process.env.DATA_URI = `file://${dataDir}`;

// Import after env mutation so joinUri picks up our temp root.
const { createStorage } = await import("../../storage.js");

afterAll(() => {
  if (originalDataUri === undefined) delete process.env.DATA_URI;
  else process.env.DATA_URI = originalDataUri;
  rmSync(dataDir, { recursive: true, force: true });
});

const storage = createStorage();

interface MakeContractArgs {
  expiration: string;
  side: "call" | "put";
  strike: number;
  iv?: number;
  delta?: number;
  spot?: number;
}

function makeContract({
  expiration,
  side,
  strike,
  iv = 0.25,
  delta = 0.5,
  spot = 500,
}: MakeContractArgs) {
  return {
    underlyingPrice: spot,
    expiration,
    side,
    strike,
    dte: 7,
    bid: 1.0,
    ask: 1.1,
    mid: 1.05,
    last: 1.08,
    volume: 100,
    openInterest: 1000,
    iv,
    delta,
    gamma: 0.01,
    theta: -0.05,
    vega: 0.2,
  };
}

describe("server/storage", () => {
  it("storeChain → hasData reports the date is present", async () => {
    await storage.storeChain("SPY", "2026-04-01", [
      makeContract({ expiration: "2026-04-08", side: "call", strike: 500 }),
      makeContract({ expiration: "2026-04-08", side: "put", strike: 500 }),
    ]);
    expect(await storage.hasData("SPY", "2026-04-01")).toBe(true);
    expect(await storage.hasData("SPY", "2026-04-02")).toBe(false);
    expect(await storage.hasData("MISSING", "2026-04-01")).toBe(false);
  });

  it("getChain returns the stored contracts with computed symbol + ITM flag", async () => {
    const chain = await storage.getChain("SPY", "2026-04-01");
    expect(chain).toHaveLength(2);
    const call = chain.find((c) => c.side === "call");
    const put = chain.find((c) => c.side === "put");
    expect(call?.symbol).toBe("SPY 2026-04-08 500 C");
    expect(put?.symbol).toBe("SPY 2026-04-08 500 P");
    // strike 500 == spot 500: not ITM for either side
    expect(call?.inTheMoney).toBe(false);
    expect(put?.inTheMoney).toBe(false);
    // ITM: a 490 strike call vs spot 500 is in the money
    await storage.storeChain("SPY", "2026-04-02", [
      makeContract({ expiration: "2026-04-08", side: "call", strike: 490, spot: 500 }),
    ]);
    const itmChain = await storage.getChain("SPY", "2026-04-02");
    expect(itmChain[0]?.inTheMoney).toBe(true);
  });

  it("storeChain twice for the same date replaces all rows for that date", async () => {
    // Initial snapshot: 3 contracts
    await storage.storeChain("AAPL", "2026-04-15", [
      makeContract({ expiration: "2026-05-15", side: "call", strike: 200 }),
      makeContract({ expiration: "2026-05-15", side: "put", strike: 200 }),
      makeContract({ expiration: "2026-05-15", side: "call", strike: 210 }),
    ]);
    let chain = await storage.getChain("AAPL", "2026-04-15");
    expect(chain).toHaveLength(3);

    // Second snapshot: only 1 contract — the other two should NOT survive
    await storage.storeChain("AAPL", "2026-04-15", [
      makeContract({ expiration: "2026-05-15", side: "call", strike: 200 }),
    ]);
    chain = await storage.getChain("AAPL", "2026-04-15");
    expect(chain).toHaveLength(1);
  });

  it("storeChain preserves rows for other dates in the same monthly file", async () => {
    await storage.storeChain("AAPL", "2026-04-16", [
      makeContract({ expiration: "2026-05-15", side: "call", strike: 200 }),
    ]);
    expect(await storage.getDates("AAPL")).toEqual(["2026-04-15", "2026-04-16"]);
    // Re-write 2026-04-16 — 04-15 should still be present
    await storage.storeChain("AAPL", "2026-04-16", [
      makeContract({ expiration: "2026-05-15", side: "put", strike: 200 }),
    ]);
    expect(await storage.getDates("AAPL")).toEqual(["2026-04-15", "2026-04-16"]);
  });

  it("getSummary returns one row per symbol with min/max date and counts", async () => {
    const summary = await storage.getSummary();
    const symbols = summary.map((s) => s.symbol).sort();
    expect(symbols).toEqual(["AAPL", "SPY"]);
    const spy = summary.find((s) => s.symbol === "SPY");
    expect(spy?.date_min).toBe("2026-04-01");
    expect(spy?.date_max).toBe("2026-04-02");
    expect(spy?.trading_days).toBe(2);
    expect(spy?.total_rows).toBe(3);
  });

  it("getSymbolDetail returns one row per (date, underlyingPrice)", async () => {
    const detail = await storage.getSymbolDetail("SPY");
    expect(detail).toHaveLength(2);
    expect(detail[0]?.date).toBe("2026-04-01");
    expect(detail[0]?.contracts).toBe(2);
    expect(detail[0]?.unique_strikes).toBe(1);
    expect(detail[0]?.expirations).toBe(1);
  });

  it("getExpirations and getUnderlyingPrice return per-date values", async () => {
    expect(await storage.getExpirations("SPY", "2026-04-01")).toEqual(["2026-04-08"]);
    expect(await storage.getUnderlyingPrice("SPY", "2026-04-01")).toBe(500);
    expect(await storage.getUnderlyingPrice("MISSING", "2026-04-01")).toBeNull();
  });
});
