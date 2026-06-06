// ── Data Catalog Types ────────────────────────────────────────────
// Common descriptor emitted by every collector, consumed by the
// frontend DataCatalogTab. Adding a new dataset kind means writing
// one Collector and registering it in ./index.ts.

export type Granularity =
  | "daily"
  | "intraday-1s"
  | "intraday-1m"
  | "intraday-5m"
  | "intraday-1h"
  | "weekly"
  | "monthly"
  | "snapshot"
  | "event";

export type IndexRelation =
  | "spx-index"
  | "spx-component"
  | "ndx-extra"
  | "sector-etf"
  | "vix-derived"
  | "commodity"
  | "rates"
  | "credit"
  | "fx"
  | "unrelated";

export type DatasetKind =
  | "chains"
  | "signals"
  | "etf"
  | "futures"
  | "macro"
  | "fills"
  | "backtest"
  | "qo-run";

/**
 * One column's metadata, materialized from the parquet file's schema.
 * `dtype` is the DuckDB type name (VARCHAR, DOUBLE, DATE, TIMESTAMP, etc.).
 * `nullable` is best-effort; collectors that can't cheaply determine it
 * default to true (parquet allows nulls by default).
 */
export interface ColumnSchemaEntry {
  name: string;
  dtype: string;
  nullable: boolean;
}

export interface DatasetDescriptor {
  id: string;
  kind: DatasetKind;
  label: string;
  symbols: string[];
  date_min: string | null;
  date_max: string | null;
  granularity: Granularity;
  row_count: number;
  file_count: number;
  size_bytes: number;
  last_updated: string | null;
  source: string;
  index_relation: IndexRelation;
  type_specific: Record<string, unknown>;
  /**
   * Fully-qualified path to the underlying parquet (or glob, for descriptors
   * that span multiple files). Absolute filesystem path for `file://` mode,
   * `s3://bucket/...` URI for MinIO-backed datasets. Resolves what `qf://`
   * URIs in strategy adapters dereference to.
   *
   * `null` for collectors whose data isn't parquet (fills are JSONL,
   * backtest results are JSON). Consumers wanting to read parquet data
   * via qf:// should skip descriptors with null parquet_uri.
   *
   * Added in catalog schema v1.1.
   */
  parquet_uri: string | null;
  /**
   * Materialized column schema from the underlying parquet. Empty array if
   * the file couldn't be introspected, or if the descriptor isn't parquet-
   * backed at all (collectors set [] alongside parquet_uri: null).
   * Added in catalog schema v1.1.
   */
  column_schema: ColumnSchemaEntry[];
}

export interface Collector {
  kind: DatasetKind;
  describe(): Promise<DatasetDescriptor[]>;
}

/**
 * Catalog API response shape.
 *
 * `schema_version` semver-ish, additive. Consumers reading older versions
 * keep working because new fields are added, never removed or repurposed.
 *
 * - 1.0 — initial shape (no schema_version field on disk; absent ≡ 1.0)
 * - 1.1 — adds `parquet_uri` + `column_schema` to every descriptor
 */
export interface CatalogResponse {
  schema_version: string;
  generated_at: string;
  descriptors: DatasetDescriptor[];
}
