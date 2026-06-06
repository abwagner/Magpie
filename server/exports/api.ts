// ── Settings · Activity · Exports (QF-58) ─────────────────────────
//
// HTTP handler for `GET /api/exports/:kind?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json`.
// Streams the requested slice of an audit / journal table out as a
// download. Each export kind explicitly enumerates the columns it
// exposes — no SELECT * — to avoid leaking schema details that
// aren't part of the operator-visible contract.
//
// New exports get one entry added to `EXPORTS` below. The shape is
// `{ table, dateColumn, columns, defaultFilename }`. Validation on
// kind / format / from / to runs at the handler boundary; the SQL is
// parameterised against the date inputs to keep the query trivially
// safe.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "duckdb";
import type { Logger } from "../logger.js";

export type ExportFormat = "csv" | "json";

interface ExportSpec {
  /** SQL identifier of the table the rows come from. */
  table: string;
  /** Column used for `from` / `to` filtering (DATE or TIMESTAMP). */
  dateColumn: string;
  /** Explicit allow-list of columns to surface. Order is preserved
   *  in the streamed output. */
  columns: string[];
  /** Default filename stem for the download (without extension). */
  defaultFilename: string;
}

// Single source of truth for what's exportable. Adding a kind here +
// the EXPORTS_LIST entry below is the whole "expose a new export"
// workflow.
export const EXPORTS: Record<string, ExportSpec> = {
  "model-quality": {
    table: "model_quality",
    dateColumn: "eval_date",
    columns: [
      "model_id",
      "model_version",
      "kind",
      "symbol",
      "eval_date",
      "horizon_label",
      "metric",
      "value",
      "sample_count",
      "eval_window_start",
      "eval_window_end",
    ],
    defaultFilename: "model_quality",
  },
  "audit-orders": {
    table: "audit_orders",
    dateColumn: "created_at",
    columns: [
      "order_id",
      "intent_id",
      "broker",
      "execution_mode",
      "status",
      "created_at",
      "risk_checked_at",
      "approved_at",
      "submitted_at",
      "completed_at",
      "broker_order_id",
    ],
    defaultFilename: "audit_orders",
  },
  "trade-journal": {
    table: "trade_journal",
    dateColumn: "entry_date",
    columns: [
      "trade_id",
      "portfolio",
      "strategy_id",
      "symbol",
      "direction",
      "quantity",
      "contract_multiplier",
      "entry_price",
      "entry_date",
      "entry_fees",
    ],
    defaultFilename: "trade_journal",
  },
  "portfolio-snapshots": {
    table: "portfolio_snapshots",
    dateColumn: "snapshot_ts",
    columns: [
      "portfolio",
      "snapshot_ts",
      "trigger",
      "cash",
      "equity",
      "realized_pnl",
      "unrealized_pnl",
      "daily_realized",
      "net_delta",
      "net_vega",
      "drawdown",
      "peak_equity",
    ],
    defaultFilename: "portfolio_snapshots",
  },
};

// Surfaced via `GET /api/exports` so the screen can render a dropdown
// without hard-coding the list client-side.
export interface ExportKindMeta {
  kind: string;
  label: string;
  date_column: string;
  columns: string[];
  default_filename: string;
}

const KIND_LABELS: Record<string, string> = {
  "model-quality": "Model quality (per-metric)",
  "audit-orders": "Audit · Orders",
  "trade-journal": "Trade journal",
  "portfolio-snapshots": "Portfolio snapshots (daily P&L)",
};

export function listExports(): ExportKindMeta[] {
  return Object.entries(EXPORTS).map(([kind, spec]) => ({
    kind,
    label: KIND_LABELS[kind] ?? kind,
    date_column: spec.dateColumn,
    columns: spec.columns,
    default_filename: spec.defaultFilename,
  }));
}

// ── Validation ─────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ISO_DATE.test(value)) {
    throw new ValidationError(`${label}: must be YYYY-MM-DD`);
  }
  return value;
}

class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ExportValidationError";
  }
}

// ── DuckDB helper ──────────────────────────────────────────────────

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

// ── CSV writer ─────────────────────────────────────────────────────
// Hand-rolled rather than a dep — exports are tabular, no nested
// values, and we want to control the date-coercion explicitly.

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Date / Timestamp values come back from duckdb as native Date
  // objects. ISO-string normalises across CSV viewers.
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

// ── Handler ────────────────────────────────────────────────────────

export interface ExportApiDeps {
  db: Database;
  logger: Logger;
}

export function createExportsApi(deps: ExportApiDeps) {
  return {
    /** GET /api/exports — list available kinds + their column schemas. */
    handleList(_req: IncomingMessage, res: ServerResponse): void {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ exports: listExports() }));
    },

    /** GET /api/exports/:kind?from=&to=&format=csv|json */
    async handleExport(req: IncomingMessage, res: ServerResponse, kind: string): Promise<void> {
      const spec = EXPORTS[kind];
      if (!spec) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unknown export kind: ${kind}` }));
        return;
      }
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const from = parseDate("from", url.searchParams.get("from") ?? undefined);
        const to = parseDate("to", url.searchParams.get("to") ?? undefined);
        const formatParam = (url.searchParams.get("format") ?? "csv").toLowerCase();
        if (formatParam !== "csv" && formatParam !== "json") {
          throw new ValidationError(`format must be 'csv' or 'json', got '${formatParam}'`);
        }
        const format = formatParam as ExportFormat;

        // Build the parameterised query. Date filters use simple
        // inequality predicates so the export works against DATE and
        // TIMESTAMP columns alike.
        const wheres: string[] = [];
        const params: unknown[] = [];
        if (from) {
          wheres.push(`${spec.dateColumn} >= ?`);
          params.push(from);
        }
        if (to) {
          // Exclusive `< to + 1 day` would be cleaner for TIMESTAMP
          // columns, but `<= to` matches operator intent for both
          // DATE and TIMESTAMP and keeps the query parameterised
          // (DuckDB casts the string).
          wheres.push(`${spec.dateColumn} <= ?`);
          params.push(to);
        }
        const whereClause = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
        const sql = `SELECT ${spec.columns.join(", ")} FROM ${spec.table} ${whereClause} ORDER BY ${spec.dateColumn}`;

        deps.logger.info("export requested", {
          kind,
          format,
          from: from ?? null,
          to: to ?? null,
        });

        const rows = await runQuery(deps.db, sql, params);
        const filename = buildFilename(spec.defaultFilename, from, to, format);

        if (format === "csv") {
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Access-Control-Allow-Origin": "*",
          });
          res.end(rowsToCsv(spec.columns, rows));
        } else {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Access-Control-Allow-Origin": "*",
          });
          // Date instances stringify via toJSON => ISO string, which
          // matches the CSV path's date format.
          res.end(JSON.stringify({ kind, from, to, columns: spec.columns, rows }));
        }
      } catch (e) {
        const status = e instanceof ValidationError ? e.status : 500;
        const message = e instanceof Error ? e.message : String(e);
        deps.logger.warn("export failed", { kind, error: message });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    },
  };
}

function buildFilename(stem: string, from?: string, to?: string, format: ExportFormat = "csv") {
  const parts = [stem];
  if (from || to) parts.push(`${from ?? "begin"}_to_${to ?? "now"}`);
  return `${parts.join("_")}.${format}`;
}
