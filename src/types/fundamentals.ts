// Settings · Data · Fundamentals — frontend mirror of
// server/fundamentals/status.ts. Server is authoritative.

export type FundamentalsSource = "yfinance" | "fmp";

export type FundamentalsFreshnessStatus = "fresh" | "stale" | "missing";

export interface FundamentalsParquetStatus {
  source: FundamentalsSource;
  name: string;
  file: string;
  exists: boolean;
  row_count: number | null;
  data_through: string | null;
  freshness_age_hours: number | null;
  freshness_status: FundamentalsFreshnessStatus;
  expected_max_age_hours: number;
}

export interface FundamentalsStatusResponse {
  generated_at: string;
  parquets: FundamentalsParquetStatus[];
}
