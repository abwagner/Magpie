import { describe, expect, it } from "vitest";
import type { Database } from "duckdb";
import {
  buildS3CopyQuery,
  buildDeleteQuery,
  getCutoffDate,
  createAuditRetentionHandler,
} from "../../handlers/audit-retention.js";

describe("audit-retention handler", () => {
  describe("getCutoffDate", () => {
    it("returns a date N days in the past", () => {
      const cutoff = getCutoffDate(90);
      const parts = cutoff.split("-");
      expect(parts.length).toBe(3);
      expect(parts[0]!.length).toBe(4); // YYYY
      expect(parts[1]!.length).toBe(2); // MM
      expect(parts[2]!.length).toBe(2); // DD
    });

    it("handles 0-day window (today)", () => {
      const cutoff = getCutoffDate(0);
      const today = new Date().toISOString().split("T")[0];
      expect(cutoff).toBe(today);
    });

    it("handles 1-day window (yesterday)", () => {
      const cutoff = getCutoffDate(1);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      expect(cutoff).toBe(yesterday);
    });
  });

  describe("buildS3CopyQuery", () => {
    it("builds a COPY query for a table without endpoint", () => {
      const query = buildS3CopyQuery(
        "audit_intents",
        "audit/archive",
        "my-bucket",
        "2026-05-01",
      );
      expect(query).toContain("COPY");
      expect(query).toContain("FROM audit_intents");
      expect(query).toContain("s3://my-bucket/audit/archive/audit_intents/2026/05/01/");
      expect(query).toContain("FORMAT parquet");
      expect(query).toContain("WHERE created_at < '2026-05-01");
    });

    it("builds a COPY query with endpoint URL", () => {
      const query = buildS3CopyQuery(
        "audit_orders",
        "archive",
        "backup-bucket",
        "2026-04-15",
        "https://minio.example.com",
      );
      expect(query).toContain("s3://backup-bucket/archive/audit_orders/2026/04/15/");
    });

    it("partitions the date correctly (YYYY/MM/DD)", () => {
      const query = buildS3CopyQuery("audit_fills", "arch", "b", "2026-12-31");
      expect(query).toContain("2026/12/31");
    });
  });

  describe("buildDeleteQuery", () => {
    it("builds a DELETE query for old rows", () => {
      const query = buildDeleteQuery("drift_alerts", "2026-05-01");
      expect(query).toBe("DELETE FROM drift_alerts WHERE created_at < '2026-05-01 00:00:00 UTC'");
    });

    it("handles different table names", () => {
      const query = buildDeleteQuery("portfolio_snapshots", "2025-12-15");
      expect(query).toContain("portfolio_snapshots");
      expect(query).toContain("2025-12-15");
    });
  });

  describe("handler.validate()", () => {
    const handler = createAuditRetentionHandler({} as Database);
    const validate = handler.validate!;

    it("accepts empty params", () => {
      expect(validate({})).toEqual([]);
    });

    it("rejects non-object params", () => {
      expect(validate(null).length).toBeGreaterThan(0);
      expect(validate("invalid").length).toBeGreaterThan(0);
    });

    it("accepts valid archive_bucket (string)", () => {
      expect(validate({ archive_bucket: "my-bucket" })).toEqual([]);
    });

    it("rejects non-string archive_bucket", () => {
      const errs = validate({ archive_bucket: 42 });
      expect(errs.some((e) => e.includes("archive_bucket"))).toBe(true);
    });

    it("accepts valid endpoint_url", () => {
      expect(validate({ endpoint_url: "https://minio.example.com" })).toEqual([]);
    });

    it("rejects non-string endpoint_url", () => {
      const errs = validate({ endpoint_url: 123 });
      expect(errs.some((e) => e.includes("endpoint_url"))).toBe(true);
    });

    it("accepts positive integer window days", () => {
      expect(
        validate({
          archive_window_days: 90,
          drift_window_days: 30,
          snapshot_window_days: 60,
        }),
      ).toEqual([]);
    });

    it("rejects non-positive archive_window_days", () => {
      const errs = validate({ archive_window_days: 0 });
      expect(errs.some((e) => e.includes("archive_window_days"))).toBe(true);

      const errs2 = validate({ archive_window_days: -10 });
      expect(errs2.some((e) => e.includes("archive_window_days"))).toBe(true);
    });

    it("rejects fractional window_days", () => {
      const errs = validate({ archive_window_days: 90.5 });
      expect(errs.some((e) => e.includes("archive_window_days"))).toBe(true);
    });

    it("accepts boolean dry_run", () => {
      expect(validate({ dry_run: true })).toEqual([]);
      expect(validate({ dry_run: false })).toEqual([]);
    });

    it("rejects non-boolean dry_run", () => {
      const errs = validate({ dry_run: "yes" });
      expect(errs.some((e) => e.includes("dry_run"))).toBe(true);
    });
  });

  describe("handler.kind", () => {
    const handler = createAuditRetentionHandler({} as Database);

    it("declares the correct kind name", () => {
      expect(handler.kind).toBe("audit-retention");
    });
  });

  describe("archiveTable (pure query building)", () => {
    it("builds correct S3 path for archive", () => {
      const query = buildS3CopyQuery(
        "audit_intents",
        "audit/archive",
        "magpie-data",
        "2026-05-10",
      );
      expect(query).toContain("audit_intents");
      expect(query).toContain("2026/05/10");
    });
  });

  describe("deleteOldRows (pure query building)", () => {
    it("builds correct DELETE query", () => {
      const query = buildDeleteQuery("drift_alerts", "2026-05-10");
      expect(query).toContain("DELETE FROM drift_alerts");
      expect(query).toContain("2026-05-10");
      expect(query).toContain("UTC");
    });
  });
});
