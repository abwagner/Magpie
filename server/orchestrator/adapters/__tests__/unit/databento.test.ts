// Pure-helper tests for the Databento Historical adapter (QF-238).
// HTTP + parquet I/O are exercised by the live cron and a smoke
// run in production; here we just cover the pieces that don't talk
// to the network.

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// outputUriFor → joinUri → resolveDataUri demands DATA_URI; set a
// stub before the adapter module loads.
const ORIG_DATA_URI = process.env.DATA_URI;
beforeAll(() => {
  process.env.DATA_URI = "file:///tmp/qf-test";
});
afterAll(() => {
  if (ORIG_DATA_URI === undefined) delete process.env.DATA_URI;
  else process.env.DATA_URI = ORIG_DATA_URI;
});

import {
  parentSymbol,
  schemaToFilename,
  outputUriFor,
  shouldRefuseOnCost,
  defaultStart,
  utcMidnightToday,
  parseCsvToRows,
} from "../../databento.js";

describe("databento adapter — pure helpers", () => {
  describe("parentSymbol", () => {
    it("appends .fut for continuous futures symbology", () => {
      expect(parentSymbol("CL")).toBe("CL.fut");
      expect(parentSymbol("ES")).toBe("ES.fut");
    });
  });

  describe("schemaToFilename", () => {
    it("hyphens → underscores so parquet filenames are shell-friendly", () => {
      expect(schemaToFilename("ohlcv-1d")).toBe("ohlcv_1d");
      expect(schemaToFilename("mbp-1")).toBe("mbp_1");
      expect(schemaToFilename("trades")).toBe("trades");
    });
  });

  describe("outputUriFor", () => {
    it("lowercases symbol + underscored schema under futures/", () => {
      // DATA_URI from the test env is the only environmental dep;
      // we just check the suffix, not the resolved base.
      const uri = outputUriFor("CL", "mbp-1");
      expect(uri.endsWith("/futures/cl/mbp_1.parquet")).toBe(true);
    });
    it("matches the existing 2026-05-09 seed layout for trades", () => {
      expect(outputUriFor("ES", "trades").endsWith("/futures/es/trades.parquet")).toBe(true);
    });
  });

  describe("shouldRefuseOnCost", () => {
    it("refuses anything above $0 (the pull_now invariant)", () => {
      expect(shouldRefuseOnCost(0.01)).toBe(true);
      expect(shouldRefuseOnCost(1.0)).toBe(true);
    });
    it("accepts $0 exactly", () => {
      expect(shouldRefuseOnCost(0)).toBe(false);
    });
    it("accepts sub-nanocent floating-point noise as zero", () => {
      expect(shouldRefuseOnCost(1e-12)).toBe(false);
    });
  });

  describe("utcMidnightToday + defaultStart", () => {
    it("clamps end to UTC midnight (00:00:00Z, no in-progress day)", () => {
      const fixed = new Date("2026-05-20T15:30:42.123Z");
      const end = utcMidnightToday(fixed);
      expect(end).toBe("2026-05-20T00:00:00.000Z");
    });
    it("defaultStart is 30 days before utcMidnightToday", () => {
      const fixed = new Date("2026-05-20T15:30:42.123Z");
      const start = defaultStart(fixed);
      expect(start).toBe("2026-04-20T00:00:00.000Z");
    });
  });

  describe("parseCsvToRows", () => {
    it("returns [] for empty / header-only CSV", () => {
      expect(parseCsvToRows("")).toEqual([]);
      expect(parseCsvToRows("ts_event,instrument_id,open\n")).toEqual([]);
    });
    it("coerces nanosecond ts_event to ISO 8601 millis", () => {
      // 2026-05-20T00:00:00Z = 1779574400000ms = 1779235200000000000ns
      const csv =
        "ts_event,instrument_id,open,high,low,close,volume\n" +
        "1779235200000000000,17,71.5,72.0,71.0,71.8,12345\n";
      const [row] = parseCsvToRows(csv);
      expect(row?.ts_event).toBe("2026-05-20T00:00:00.000Z");
      expect(row?.instrument_id).toBe(17);
      expect(row?.open).toBe(71.5);
      expect(row?.volume).toBe(12345);
    });
    it("nulls empty cells", () => {
      const csv = "ts_event,instrument_id,open\n1779235200000000000,17,\n";
      const [row] = parseCsvToRows(csv);
      expect(row?.open).toBeNull();
    });
    it("preserves string columns (e.g. trade side) unmodified", () => {
      const csv = "ts_event,instrument_id,side,price,size\n1779235200000000000,17,A,71.5,1\n";
      const [row] = parseCsvToRows(csv);
      expect(row?.side).toBe("A");
      expect(row?.price).toBe(71.5);
      expect(row?.size).toBe(1);
    });
    it("handles multiple rows", () => {
      const csv =
        "ts_event,instrument_id,close\n" +
        "1779235200000000000,17,71.0\n" +
        "1779574460000000000,17,71.5\n";
      const rows = parseCsvToRows(csv);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.close).toBe(71.0);
      expect(rows[1]?.close).toBe(71.5);
    });
  });
});
