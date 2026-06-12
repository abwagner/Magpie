// ── Handler: audit-retention (QF-311) ──────────────────────────────
//
// Manages per-table retention policies: archives audit tables to Parquet
// in MinIO, then deletes archived rows. Applies rolling-window deletes
// for non-archived tables. Partitions by date in the MinIO prefix.

import type { Database } from "duckdb";
import type { HandlerResult, JobHandler } from "../types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AuditRetentionParams {
  /** DuckDB file path (passed via handler context/DI). Normally not in params. */
  duckdb_path?: string;
  /** S3 bucket for archive (defaults to config/retention.json). */
  archive_bucket?: string;
  /** S3 endpoint URL (null for AWS, set for MinIO). */
  endpoint_url?: string;
  /** S3 region. */
  region?: string;
  /** Days before cutoff for archival (defaults per config). */
  archive_window_days?: number;
  /** Days before cutoff for drift_alerts deletion. */
  drift_window_days?: number;
  /** Days before cutoff for portfolio_snapshots deletion. */
  snapshot_window_days?: number;
  /** Dry run: log what would be done, don't execute DELETEs. */
  dry_run?: boolean;
}

export interface RetentionPolicyConfig {
  mode: "archive" | "rolling";
  window_days: number;
  archive_bucket?: string;
  archive_prefix?: string;
  endpoint_url?: string;
  region?: string;
}

export interface RetentionTablePolicy {
  table: string;
  mode: "archive" | "rolling";
  window_days: number;
  archiveBucket?: string;
  archivePrefix?: string;
}

export interface ArchiveResult {
  table: string;
  rows_archived: number;
  rows_deleted: number;
  archive_path: string;
  error?: string;
}

// ── Pure Functions (testable) ──────────────────────────────────────

export function buildS3CopyQuery(
  table: string,
  archivePrefix: string,
  bucket: string,
  cutoffDate: string,
  endpoint?: string,
): string {
  const datePartition = cutoffDate.replace(/-/g, "/"); // 2026-05-01 → 2026/05/01
  const s3Path = endpoint
    ? `s3://${bucket}/${archivePrefix}/${table}/${datePartition}/${table}_${cutoffDate}.parquet`
    : `s3://${bucket}/${archivePrefix}/${table}/${datePartition}/${table}_${cutoffDate}.parquet`;

  // Export rows with created_at < cutoff as Parquet, partitioned by date
  return `
    COPY (
      SELECT * FROM ${table}
      WHERE created_at < '${cutoffDate} 00:00:00 UTC'
      ORDER BY created_at
    )
    TO '${s3Path}' (FORMAT parquet);
  `.trim();
}

export function buildDeleteQuery(table: string, cutoffDate: string): string {
  return `DELETE FROM ${table} WHERE created_at < '${cutoffDate} 00:00:00 UTC'`;
}

export function getCutoffDate(windowDays: number): string {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().split("T")[0]!; // YYYY-MM-DD
}

export function archiveTable(
  db: Database,
  table: string,
  windowDays: number,
  archiveBucket: string,
  archivePrefix: string,
  endpointUrl: string | undefined,
  dryRun: boolean,
): Promise<ArchiveResult> {
  return new Promise((resolve) => {
    const cutoffDate = getCutoffDate(windowDays);
    const copyQuery = buildS3CopyQuery(table, archivePrefix, archiveBucket, cutoffDate, endpointUrl);
    const deleteQuery = buildDeleteQuery(table, cutoffDate);
    const archivePath = `s3://${archiveBucket}/${archivePrefix}/${table}/${cutoffDate.replace(/-/g, "/")}/${table}_${cutoffDate}.parquet`;

    try {
      // 1. Export to S3 via DuckDB's COPY ... TO 's3://...'
      if (!dryRun) {
        // Before running the COPY, verify httpfs is loaded
        db.run("INSTALL httpfs");
        db.run("LOAD httpfs");

        // Set S3 config
        if (endpointUrl) {
          db.run(`SET s3_endpoint = '${endpointUrl}'`);
        }

        // Run the COPY
        db.run(copyQuery);
      }

      // 2. Count rows before delete
      const countSql = `SELECT COUNT(*) as cnt FROM ${table} WHERE created_at < '${cutoffDate} 00:00:00 UTC'`;
      db.all(countSql, (err: Error | null, rows: unknown) => {
        if (err) {
          resolve({
            table,
            rows_archived: 0,
            rows_deleted: 0,
            archive_path: archivePath,
            error: err.message,
          });
          return;
        }

        const rowsArchived = ((rows as Array<Record<string, unknown>>)?.[0]?.cnt as number) ?? 0;

        // 3. Delete archived rows
        if (!dryRun) {
          db.run(deleteQuery, (delErr: Error | null) => {
            if (delErr) {
              resolve({
                table,
                rows_archived: rowsArchived,
                rows_deleted: 0,
                archive_path: archivePath,
                error: delErr.message,
              });
            } else {
              resolve({
                table,
                rows_archived: rowsArchived,
                rows_deleted: rowsArchived,
                archive_path: archivePath,
              });
            }
          });
        } else {
          resolve({
            table,
            rows_archived: rowsArchived,
            rows_deleted: rowsArchived,
            archive_path: archivePath,
          });
        }
      });
    } catch (err) {
      resolve({
        table,
        rows_archived: 0,
        rows_deleted: 0,
        archive_path: archivePath,
        error: `${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

export function deleteOldRows(
  db: Database,
  table: string,
  windowDays: number,
  dryRun: boolean,
): Promise<ArchiveResult> {
  return new Promise((resolve) => {
    const cutoffDate = getCutoffDate(windowDays);
    const deleteQuery = buildDeleteQuery(table, cutoffDate);

    try {
      // Count rows before delete
      const countSql = `SELECT COUNT(*) as cnt FROM ${table} WHERE created_at < '${cutoffDate} 00:00:00 UTC'`;
      db.all(countSql, (err: Error | null, rows: unknown) => {
        if (err) {
          resolve({
            table,
            rows_archived: 0,
            rows_deleted: 0,
            archive_path: "",
            error: err.message,
          });
          return;
        }

        const rowsBefore = ((rows as Array<Record<string, unknown>>)?.[0]?.cnt as number) ?? 0;

        // Delete old rows
        if (!dryRun) {
          db.run(deleteQuery, (delErr: Error | null) => {
            if (delErr) {
              resolve({
                table,
                rows_archived: 0,
                rows_deleted: 0,
                archive_path: "",
                error: delErr.message,
              });
            } else {
              resolve({
                table,
                rows_archived: 0,
                rows_deleted: rowsBefore,
                archive_path: "",
              });
            }
          });
        } else {
          resolve({
            table,
            rows_archived: 0,
            rows_deleted: rowsBefore,
            archive_path: "",
          });
        }
      });
    } catch (err) {
      resolve({
        table,
        rows_archived: 0,
        rows_deleted: 0,
        archive_path: "",
        error: `${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

// ── Handler Implementation ─────────────────────────────────────────

export function createAuditRetentionHandler(db: Database): JobHandler<AuditRetentionParams> {
  return {
    kind: "audit-retention",

    validate(params): string[] {
      if (params === null || typeof params !== "object") return ["params must be an object"];
      const p = params as Record<string, unknown>;
      const errors: string[] = [];

      if (p.archive_bucket !== undefined && typeof p.archive_bucket !== "string") {
        errors.push("archive_bucket must be a string");
      }
      if (p.endpoint_url !== undefined && typeof p.endpoint_url !== "string") {
        errors.push("endpoint_url must be a string");
      }
      if (p.region !== undefined && typeof p.region !== "string") {
        errors.push("region must be a string");
      }
      if (p.archive_window_days !== undefined) {
        const v = p.archive_window_days;
        if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
          errors.push("archive_window_days must be a positive integer");
        }
      }
      if (p.drift_window_days !== undefined) {
        const v = p.drift_window_days;
        if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
          errors.push("drift_window_days must be a positive integer");
        }
      }
      if (p.snapshot_window_days !== undefined) {
        const v = p.snapshot_window_days;
        if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
          errors.push("snapshot_window_days must be a positive integer");
        }
      }
      if (p.dry_run !== undefined && typeof p.dry_run !== "boolean") {
        errors.push("dry_run must be a boolean");
      }

      return errors;
    },

    async run(params, progress, ctx): Promise<HandlerResult> {
      const {
        archive_bucket = "magpie-data",
        endpoint_url,
        archive_window_days = 90,
        drift_window_days = 30,
        snapshot_window_days = 90,
        dry_run = false,
      } = params;

      ctx.logger.info("audit-retention starting", {
        archive_bucket,
        archive_window_days,
        drift_window_days,
        snapshot_window_days,
        dry_run,
      });

      if (dry_run) {
        ctx.logger.info("audit-retention running in DRY-RUN mode");
      }

      progress(0, 5, "initializing");

      const results: ArchiveResult[] = [];
      const archivePrefix = "audit/archive";

      // Archive tables: audit_intents, audit_orders, audit_fills
      const archiveTables = ["audit_intents", "audit_orders", "audit_fills"];
      for (let i = 0; i < archiveTables.length; i++) {
        const table = archiveTables[i]!;
        ctx.logger.info(`archiving ${table}`, { window_days: archive_window_days });
        try {
          const result = await archiveTable(
            db,
            table,
            archive_window_days,
            archive_bucket,
            archivePrefix,
            endpoint_url,
            dry_run,
          );
          results.push(result);
          ctx.logger.info(`${table} archived`, {
            rows_archived: result.rows_archived,
            rows_deleted: result.rows_deleted,
          });
          progress(i + 1, 5, `${table} done`);
        } catch (err) {
          const msg = `${err instanceof Error ? err.message : String(err)}`;
          ctx.logger.error(`${table} archive failed`, { error: msg });
          results.push({
            table,
            rows_archived: 0,
            rows_deleted: 0,
            archive_path: "",
            error: msg,
          });
          progress(i + 1, 5, `${table} failed`);
        }
      }

      // Rolling-window delete for drift_alerts
      ctx.logger.info("deleting old drift_alerts", { window_days: drift_window_days });
      try {
        const driftResult = await deleteOldRows(db, "drift_alerts", drift_window_days, dry_run);
        results.push(driftResult);
        ctx.logger.info("drift_alerts deleted", { rows_deleted: driftResult.rows_deleted });
        progress(4, 5, "drift_alerts done");
      } catch (err) {
        const msg = `${err instanceof Error ? err.message : String(err)}`;
        ctx.logger.error("drift_alerts delete failed", { error: msg });
        results.push({
          table: "drift_alerts",
          rows_archived: 0,
          rows_deleted: 0,
          archive_path: "",
          error: msg,
        });
        progress(4, 5, "drift_alerts failed");
      }

      // Rolling-window delete for portfolio_snapshots
      ctx.logger.info("deleting old portfolio_snapshots", { window_days: snapshot_window_days });
      try {
        const snapshotResult = await deleteOldRows(db, "portfolio_snapshots", snapshot_window_days, dry_run);
        results.push(snapshotResult);
        ctx.logger.info("portfolio_snapshots deleted", { rows_deleted: snapshotResult.rows_deleted });
        progress(5, 5, "portfolio_snapshots done");
      } catch (err) {
        const msg = `${err instanceof Error ? err.message : String(err)}`;
        ctx.logger.error("portfolio_snapshots delete failed", { error: msg });
        results.push({
          table: "portfolio_snapshots",
          rows_archived: 0,
          rows_deleted: 0,
          archive_path: "",
          error: msg,
        });
        progress(5, 5, "portfolio_snapshots failed");
      }

      // Log summary
      const totalArchived = results.reduce((sum, r) => sum + r.rows_archived, 0);
      const totalDeleted = results.reduce((sum, r) => sum + r.rows_deleted, 0);
      const errors = results.filter((r) => r.error);

      ctx.logger.info("audit-retention completed", {
        total_archived: totalArchived,
        total_deleted: totalDeleted,
        error_count: errors.length,
        results: results.map((r) => ({
          table: r.table,
          archived: r.rows_archived,
          deleted: r.rows_deleted,
          error: r.error,
        })),
      });

      if (errors.length > 0) {
        throw new Error(
          `audit-retention completed with ${errors.length} table error(s): ${errors
            .map((e) => `${e.table}: ${e.error}`)
            .join("; ")}`,
        );
      }

      return {
        output_paths: results.filter((r) => r.archive_path).map((r) => r.archive_path),
      };
    },
  };
}
