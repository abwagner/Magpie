// Pure parse tests for the FMP dividends + splits kinds (QF-188).
// The HTTP/parquet pipeline is exercised by the live cron — these
// tests only assert the response-row → parquet-row transformation.

import { describe, it, expect } from "vitest";
import { parseDividendRows, parseSplitRows } from "../../fmp.js";

const TS = "2026-05-16 12:00:00";

describe("FMP dividends parse", () => {
  it("flattens the historical[] envelope into per-event rows", () => {
    const resp = {
      symbol: "AAPL",
      historical: [
        {
          date: "2026-02-08",
          label: "February 08, 26",
          adjDividend: 0.25,
          dividend: 0.25,
          recordDate: "2026-02-09",
          paymentDate: "2026-02-16",
          declarationDate: "2026-02-01",
        },
        {
          date: "2025-11-09",
          label: "November 09, 25",
          adjDividend: 0.24,
          dividend: 0.24,
          recordDate: "2025-11-10",
          paymentDate: "2025-11-17",
          declarationDate: "2025-11-02",
        },
      ],
    };
    const rows = parseDividendRows("AAPL", resp, TS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      ticker: "AAPL",
      date: "2026-02-08",
      dividend: 0.25,
      adj_dividend: 0.25,
      label: "February 08, 26",
      declaration_date: "2026-02-01",
      record_date: "2026-02-09",
      payment_date: "2026-02-16",
      last_updated_at: TS,
    });
  });

  it("returns empty when historical is missing or empty", () => {
    expect(parseDividendRows("AAPL", {}, TS)).toEqual([]);
    expect(parseDividendRows("AAPL", { historical: [] }, TS)).toEqual([]);
  });

  it("normalises null numeric fields to null (not NaN)", () => {
    const rows = parseDividendRows(
      "AAPL",
      { historical: [{ date: "2026-01-01", adjDividend: null, dividend: null }] },
      TS,
    );
    expect(rows[0]?.dividend).toBeNull();
    expect(rows[0]?.adj_dividend).toBeNull();
  });
});

describe("FMP splits parse", () => {
  it("flattens the historical[] envelope", () => {
    const resp = {
      symbol: "AAPL",
      historical: [
        { date: "2020-08-31", label: "4:1", numerator: 4, denominator: 1 },
        { date: "2014-06-09", label: "7:1", numerator: 7, denominator: 1 },
      ],
    };
    const rows = parseSplitRows("AAPL", resp, TS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      ticker: "AAPL",
      date: "2020-08-31",
      numerator: 4,
      denominator: 1,
      last_updated_at: TS,
    });
  });

  it("returns empty when historical is missing", () => {
    expect(parseSplitRows("AAPL", {}, TS)).toEqual([]);
  });
});
