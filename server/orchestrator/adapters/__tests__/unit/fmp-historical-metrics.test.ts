// Pure parse tests for the FMP historical key metrics + ratings
// kinds (QF-190). HTTP + parquet I/O exercised by the QF-191 backfill
// and the live cron; here we just verify the response → parquet-row
// projections.

import { describe, it, expect } from "vitest";
import { parseHistoricalRatingRows, projectStatement } from "../../fmp.js";

const TS = "2026-05-16 12:00:00";

const KEY_METRICS_FIELDS = [
  ["peRatio", "pe"],
  ["pegRatio", "peg"],
  ["roe", "roe"],
] as const;

describe("FMP historical key metrics (via projectStatement)", () => {
  it("projects quarterly metrics keyed on fiscal_period_end + period", () => {
    const rows = projectStatement(
      "AAPL",
      [
        {
          date: "2026-03-31",
          period: "Q1",
          reportedCurrency: "USD",
          peRatio: 28.5,
          pegRatio: 2.1,
          roe: 1.42,
        },
        { date: "2025-12-31", period: "Q4", peRatio: 30.1, pegRatio: 2.3, roe: 1.5 },
      ],
      KEY_METRICS_FIELDS,
      TS,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      ticker: "AAPL",
      fiscal_period_end: "2026-03-31",
      period: "Q1",
      reported_currency: "USD",
      pe: 28.5,
      peg: 2.1,
      roe: 1.42,
      last_updated_at: TS,
    });
    expect(rows[1]?.reported_currency).toBeNull();
  });
});

describe("FMP historical rating parse", () => {
  it("maps the rating + per-subscore fields", () => {
    const resp = [
      {
        symbol: "AAPL",
        date: "2026-05-15",
        rating: "S",
        ratingScore: 5,
        ratingRecommendation: "Strong Buy",
        ratingDetailsDCFScore: 5,
        ratingDetailsROEScore: 5,
        ratingDetailsROAScore: 4,
        ratingDetailsDEScore: 3,
        ratingDetailsPEScore: 2,
        ratingDetailsPBScore: 4,
      },
    ];
    const rows = parseHistoricalRatingRows("AAPL", resp, TS);
    expect(rows).toEqual([
      {
        ticker: "AAPL",
        date: "2026-05-15",
        rating: "S",
        rating_score: 5,
        rating_recommendation: "Strong Buy",
        dcf_score: 5,
        roe_score: 5,
        roa_score: 4,
        de_score: 3,
        pe_score: 2,
        pb_score: 4,
        last_updated_at: TS,
      },
    ]);
  });

  it("normalises missing scores to null", () => {
    const rows = parseHistoricalRatingRows("AAPL", [{ date: "2026-05-15", rating: "B" }], TS);
    expect(rows[0]?.rating_score).toBeNull();
    expect(rows[0]?.dcf_score).toBeNull();
    expect(rows[0]?.roe_score).toBeNull();
  });

  it("returns empty array for empty response", () => {
    expect(parseHistoricalRatingRows("AAPL", [], TS)).toEqual([]);
  });
});
