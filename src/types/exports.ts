// Settings · Activity · Exports — frontend mirror of
// server/exports/api.ts. Server is authoritative.

export type ExportFormat = "csv" | "json";

export interface ExportKindMeta {
  kind: string;
  label: string;
  date_column: string;
  columns: string[];
  default_filename: string;
}

export interface ExportsListResponse {
  exports: ExportKindMeta[];
}
