// Pure parse tests for the FMP statement kinds (QF-189). HTTP +
// parquet I/O is exercised by the live cron and the QF-191 backfill;
// these tests assert the response-row → parquet-row projection only.

import { describe, it, expect } from "vitest";
import { projectStatement } from "../../fmp.js";

const TS = "2026-05-16 12:00:00";

const INCOME_FIELDS = [
  ["revenue", "revenue"],
  ["grossProfit", "gross_profit"],
  ["operatingIncome", "operating_income"],
  ["netIncome", "net_income"],
  ["eps", "eps"],
] as const;

describe("FMP statement projection", () => {
  it("maps the common spine + named numeric fields", () => {
    const rows = projectStatement(
      "AAPL",
      [
        {
          date: "2026-03-31",
          period: "Q1",
          reportedCurrency: "USD",
          revenue: 90_000_000_000,
          grossProfit: 40_000_000_000,
          operatingIncome: 25_000_000_000,
          netIncome: 22_000_000_000,
          eps: 1.42,
        },
      ],
      INCOME_FIELDS,
      TS,
    );
    expect(rows).toEqual([
      {
        ticker: "AAPL",
        fiscal_period_end: "2026-03-31",
        period: "Q1",
        reported_currency: "USD",
        last_updated_at: TS,
        revenue: 90_000_000_000,
        gross_profit: 40_000_000_000,
        operating_income: 25_000_000_000,
        net_income: 22_000_000_000,
        eps: 1.42,
      },
    ]);
  });

  it("emits one row per source object", () => {
    const rows = projectStatement(
      "AAPL",
      [
        { date: "2026-03-31", period: "Q1", revenue: 90 },
        { date: "2025-12-31", period: "Q4", revenue: 120 },
        { date: "2025-09-30", period: "Q3", revenue: 85 },
      ],
      INCOME_FIELDS,
      TS,
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.fiscal_period_end)).toEqual([
      "2026-03-31",
      "2025-12-31",
      "2025-09-30",
    ]);
  });

  it("normalises missing numeric fields to null", () => {
    const rows = projectStatement(
      "AAPL",
      [{ date: "2026-03-31", period: "Q1", revenue: 90 }],
      INCOME_FIELDS,
      TS,
    );
    expect(rows[0]?.revenue).toBe(90);
    expect(rows[0]?.gross_profit).toBeNull();
    expect(rows[0]?.operating_income).toBeNull();
    expect(rows[0]?.net_income).toBeNull();
  });

  it("returns empty array when source is empty", () => {
    expect(projectStatement("AAPL", [], INCOME_FIELDS, TS)).toEqual([]);
  });

  it("handles null reportedCurrency + period gracefully", () => {
    const rows = projectStatement(
      "AAPL",
      [{ date: "2026-03-31", reportedCurrency: null, period: null, revenue: 1 }],
      INCOME_FIELDS,
      TS,
    );
    expect(rows[0]?.reported_currency).toBeNull();
    expect(rows[0]?.period).toBeNull();
  });
});
