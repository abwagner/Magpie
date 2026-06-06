// ── Downloads Service Types ───────────────────────────────────────
// Common shape emitted by every source aggregator and consumed by the
// DownloadHistoryPanel. A "run" is a single ingest pass — for sources
// with a structured log (e.g. chains nightly) we parse real start/end
// markers; for sources that only have parquet sidecars or mtimes we
// synthesize one run per ingest day.

export type RunStatus = "ok" | "stopped-credit-cap" | "error" | "incomplete" | "synthesized";

export interface CreditBudget {
  used: number;
  remaining: number;
  cap: number;
}

export interface RunErrorRef {
  http_status: number;
  endpoint: string;
  ts: string | null;
}

export interface DownloadRun {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  status: RunStatus;
  request_count: number | null;
  rows_written: number | null;
  files_written: number | null;
  credits: CreditBudget | null;
  error_count: number;
  notes: string[];
}

export interface RunActivityEntry {
  symbol: string;
  date_range: [string, string] | null;
  contracts: number | null;
  credits_used: number | null;
  files_touched: number;
  errors: RunErrorRef[];
}

export interface RunActivityResponse {
  run: DownloadRun;
  activity: RunActivityEntry[];
}

export interface RunsResponse {
  generated_at: string;
  runs: DownloadRun[];
  sources: string[];
}

export interface SourceAggregator {
  source: string;
  list(): Promise<DownloadRun[]>;
  detail?(runId: string): Promise<RunActivityEntry[] | null>;
}
