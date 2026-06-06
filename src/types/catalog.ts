// ── Catalog Types ─────────────────────────────────────────────────
// Shared types for the catalog API surface. Consumed by both the
// server handlers and the GUI layer.

// ── Source Freshness ──────────────────────────────────────────────

export type FreshnessStatus = "fresh" | "stale" | "missing";

/** Per-source freshness row returned by GET /api/catalog/freshness. */
export interface SourceFreshness {
  /** Source slug: "fred", "eia", "cftc", "fmp", "databento", etc. */
  source: string;
  /** ISO timestamp of the most recent completed ingest, or null if none. */
  last_success_at: string | null;
  /** Newest data row's date (YYYY-MM-DD) from the most recent completed
   *  ingest, or null if none. */
  data_through: string | null;
  /** Expected cadence hours from config/data-plane.json ingestion map.
   *  Null for sources in the SQL result but absent from config. */
  expected_cadence_hours: number | null;
  /** Hours since last_success_at; null if no successful ingest. */
  age_hours: number | null;
  /** fresh — age_hours <= expected_cadence_hours
   *  stale — expected_cadence_hours < age_hours <= 2× expected_cadence_hours
   *  missing — no completed ingest OR age_hours > 2× expected_cadence_hours */
  status: FreshnessStatus;
}

/** Response envelope for GET /api/catalog/freshness. */
export interface FreshnessResponse {
  sources: SourceFreshness[];
}
