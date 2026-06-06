// ── Catalog Freshness ─────────────────────────────────────────────
// Derives per-source data freshness from write_jobs + the ingestion
// cadence map in config/data-plane.json.
//
// Endpoint: GET /api/catalog/freshness
// Contract: docs/data/data-plane.md §6.3

import type { Database } from "duckdb";
import type { SourceFreshness, FreshnessStatus } from "../../src/types/catalog.js";

// ── Config shape ──────────────────────────────────────────────────

interface IngestionEntry {
  enabled: boolean;
  expected_cadence_hours: number;
}

export interface DataPlaneConfig {
  ingestion: Record<string, IngestionEntry>;
}

// ── SQL result row ────────────────────────────────────────────────

interface FreshnessRow {
  source: string;
  last_success_at: Date | string | null;
  data_through: Date | string | null;
}

// ── Helpers ───────────────────────────────────────────────────────

function runQuery<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toDateStr(v: Date | string | null): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // May arrive as full ISO or YYYY-MM-DD from DuckDB DATE column.
  return String(v).slice(0, 10);
}

function computeAgeHours(lastSuccessAt: string | null, nowMs: number): number | null {
  if (lastSuccessAt === null) return null;
  const then = new Date(lastSuccessAt).getTime();
  if (Number.isNaN(then)) return null;
  return (nowMs - then) / (1000 * 60 * 60);
}

function computeStatus(
  ageHours: number | null,
  expectedCadenceHours: number | null,
): FreshnessStatus {
  if (ageHours === null || expectedCadenceHours === null) return "missing";
  if (ageHours <= expectedCadenceHours) return "fresh";
  if (ageHours <= 2 * expectedCadenceHours) return "stale";
  return "missing";
}

// ── Core pure function ────────────────────────────────────────────

/**
 * Query write_jobs for the most recent completed ingest per source,
 * then merge against the config ingestion map.
 *
 * Sources in config but absent from the DB get last_success_at: null,
 * status: "missing".
 * Sources in the DB but absent from config get expected_cadence_hours:
 * null, status: "missing".
 */
export async function computeFreshness(
  db: Database,
  config: DataPlaneConfig,
  nowMs: number = Date.now(),
): Promise<SourceFreshness[]> {
  const SQL = `
    SELECT
      source,
      MAX(completed_at) AS last_success_at,
      MAX(data_through) AS data_through
    FROM write_jobs
    WHERE status = 'completed'
      AND source IS NOT NULL
    GROUP BY source
  `;

  const rows = await runQuery<FreshnessRow>(db, SQL);

  // Index DB results by source.
  const dbBySource = new Map<string, FreshnessRow>();
  for (const row of rows) {
    dbBySource.set(row.source, row);
  }

  const results: SourceFreshness[] = [];

  // ── Sources declared in config ─────────────────────────────────
  for (const [source, entry] of Object.entries(config.ingestion)) {
    const row = dbBySource.get(source);
    const lastSuccessAt = row ? toIso(row.last_success_at) : null;
    const dataThrough = row ? toDateStr(row.data_through) : null;
    const ageHours = computeAgeHours(lastSuccessAt, nowMs);
    const expectedCadenceHours = entry.expected_cadence_hours;

    results.push({
      source,
      last_success_at: lastSuccessAt,
      data_through: dataThrough,
      expected_cadence_hours: expectedCadenceHours,
      age_hours: ageHours,
      status: computeStatus(ageHours, expectedCadenceHours),
    });

    // Mark as visited so we don't double-emit below.
    dbBySource.delete(source);
  }

  // ── Sources in DB but not in config (retired sources) ─────────
  for (const [source, row] of dbBySource) {
    const lastSuccessAt = toIso(row.last_success_at);
    const dataThrough = toDateStr(row.data_through);
    const ageHours = computeAgeHours(lastSuccessAt, nowMs);

    results.push({
      source,
      last_success_at: lastSuccessAt,
      data_through: dataThrough,
      expected_cadence_hours: null,
      age_hours: ageHours,
      status: "missing",
    });
  }

  return results;
}
