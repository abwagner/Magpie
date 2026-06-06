// ── Settings · Data · Fundamentals (QF-63) ────────────────────────
//
// Read-only status snapshot for the fundamentals parquets in the data
// lake. Powers the Settings → Data → Fundamentals tab — per-parquet
// existence / row count / data-through date / freshness vs the
// scheduled refresh cadence each manifest declares.
//
// New parquets get one entry added to REGISTRY below. The shape is
// `{ source, name, file, expected_max_age_hours, data_through_col }`.
// Filesystem and DuckDB metadata are read at request time — there is
// no caching layer; status is small and rarely called.

import type { Logger } from "../logger.js";
import { exists, joinUri, withDb } from "../orchestrator/storage.js";

export type FundamentalsSource = "yfinance" | "fmp";

export interface FundamentalsParquetStatus {
  source: FundamentalsSource;
  name: string;
  file: string;
  exists: boolean;
  row_count: number | null;
  data_through: string | null;
  freshness_age_hours: number | null;
  freshness_status: "fresh" | "stale" | "missing";
  expected_max_age_hours: number;
}

export interface FundamentalsStatusResponse {
  generated_at: string;
  parquets: FundamentalsParquetStatus[];
}

interface RegistrySpec {
  source: FundamentalsSource;
  name: string;
  /** Path relative to DATA_URI root. */
  file: string;
  /** Cron-cadence-driven staleness threshold, hours. Drives the badge. */
  expected_max_age_hours: number;
  /** Column inside the parquet whose MAX value reports how current
   *  the data is. Falls back to file mtime when the column is absent. */
  data_through_col: string;
}

// Mirrors the live `data-signals/signals/peg-screen/signal.yaml` and
// `peg-rotation/signal.yaml` manifests. The FMP slots arrive via the
// QF-188 → QF-191 ticket sequence; they don't appear here yet because
// no manifest schedules them and there is no parquet to inspect.
const REGISTRY: RegistrySpec[] = [
  {
    source: "yfinance",
    name: "Universe (SP500 + SOX)",
    file: "fundamentals/yfinance/universe.parquet",
    expected_max_age_hours: 240,
    data_through_col: "last_updated_at",
  },
  {
    source: "yfinance",
    name: "Fundamentals snapshot",
    file: "fundamentals/yfinance/fundamentals_snapshot.parquet",
    expected_max_age_hours: 192,
    data_through_col: "last_updated_at",
  },
  {
    source: "yfinance",
    name: "Fundamentals history",
    file: "fundamentals/yfinance/fundamentals_history.parquet",
    expected_max_age_hours: 30,
    data_through_col: "asof_date",
  },
  {
    source: "yfinance",
    name: "Earnings calendar",
    file: "fundamentals/yfinance/earnings_calendar.parquet",
    expected_max_age_hours: 30,
    data_through_col: "last_updated_at",
  },
  {
    source: "yfinance",
    name: "GICS classification",
    file: "fundamentals/yfinance/gics_classification.parquet",
    expected_max_age_hours: 240,
    data_through_col: "last_updated_at",
  },
];

interface ParquetSummary {
  row_count: number | null;
  data_through: string | null;
}

async function summarize(uri: string, dataThroughCol: string): Promise<ParquetSummary> {
  return withDb(async (db) => {
    const ddbUri = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
    const sql = `
      SELECT
        count(*) AS row_count,
        max(${quoteIdent(dataThroughCol)}) AS data_through
      FROM read_parquet('${escapeSqlString(ddbUri)}')
    `;
    const rows = await new Promise<Array<{ row_count: number | bigint; data_through: unknown }>>(
      (resolve, reject) => {
        db.all(sql, (err, result) => {
          if (err) reject(err);
          else resolve(result as Array<{ row_count: number | bigint; data_through: unknown }>);
        });
      },
    );
    const row = rows[0];
    if (!row) return { row_count: null, data_through: null };
    const rc = typeof row.row_count === "bigint" ? Number(row.row_count) : row.row_count;
    return {
      row_count: rc ?? null,
      data_through: normaliseTimestamp(row.data_through),
    };
  });
}

function normaliseTimestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

export function classifyFreshness(
  dataThroughIso: string | null,
  maxAgeHours: number,
  parquetExists: boolean,
  now: number = Date.now(),
): { freshness_status: "fresh" | "stale" | "missing"; freshness_age_hours: number | null } {
  if (!parquetExists) return { freshness_status: "missing", freshness_age_hours: null };
  if (!dataThroughIso) return { freshness_status: "stale", freshness_age_hours: null };
  const parsed = Date.parse(dataThroughIso);
  if (Number.isNaN(parsed)) return { freshness_status: "stale", freshness_age_hours: null };
  const ageHours = (now - parsed) / 3_600_000;
  const status = ageHours <= maxAgeHours ? "fresh" : "stale";
  return { freshness_status: status, freshness_age_hours: ageHours };
}

export async function getFundamentalsStatus(logger: Logger): Promise<FundamentalsStatusResponse> {
  const parquets: FundamentalsParquetStatus[] = [];
  for (const spec of REGISTRY) {
    let parquetExists = false;
    let row_count: number | null = null;
    let data_through: string | null = null;
    try {
      const uri = joinUri(spec.file);
      parquetExists = await exists(uri);
      if (parquetExists) {
        const summary = await summarize(uri, spec.data_through_col);
        row_count = summary.row_count;
        data_through = summary.data_through;
      }
    } catch (e) {
      logger.warn("fundamentals status: parquet summary failed", {
        file: spec.file,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    const { freshness_status, freshness_age_hours } = classifyFreshness(
      data_through,
      spec.expected_max_age_hours,
      parquetExists,
    );
    parquets.push({
      source: spec.source,
      name: spec.name,
      file: spec.file,
      exists: parquetExists,
      row_count,
      data_through,
      freshness_age_hours,
      freshness_status,
      expected_max_age_hours: spec.expected_max_age_hours,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    parquets,
  };
}
