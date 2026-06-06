// ── Parquet Source ────────────────────────────────────────────────
// Abstraction over Parquet data location (local filesystem or S3).
// Drop-in replacement for the parquetGlob() helper in data-store.js.

import { resolve } from "node:path";
import type { Database } from "duckdb";
import { initS3, type S3Config } from "../../../server/orchestrator/storage.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ParquetSourceConfig {
  mode: "local" | "s3";
  localDir: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region?: string;
  // Programmatic overrides for the S3 init. Env vars (S3_ENDPOINT_URL,
  // S3_ACCESS_KEY, S3_SECRET_KEY) remain the canonical source; these are
  // for callers that need to point at a specific endpoint without
  // round-tripping through process.env.
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

export interface ParquetSource {
  globPattern(symbol: string): string;
  init(db: Database): Promise<void>;
}

// ── Implementation ─────────────────────────────────────────────────

function createLocalSource(localDir: string): ParquetSource {
  const absDir = resolve(localDir);
  return {
    globPattern(symbol: string): string {
      return resolve(absDir, `${symbol}-*.parquet`);
    },
    async init(): Promise<void> {
      // No-op for local mode — DuckDB reads local files natively
    },
  };
}

function createS3Source(
  bucket: string,
  prefix: string,
  region: string,
  overrides: Partial<Pick<S3Config, "endpoint" | "accessKey" | "secretKey">>,
): ParquetSource {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return {
    globPattern(symbol: string): string {
      return `s3://${bucket}/${normalizedPrefix}${symbol}-*.parquet`;
    },
    async init(db: Database): Promise<void> {
      await initS3(db, { region, ...overrides });
    },
  };
}

export function createParquetSource(config: ParquetSourceConfig): ParquetSource {
  if (config.mode === "s3") {
    if (!config.s3Bucket) throw new Error("s3Bucket is required for s3 mode");
    return createS3Source(
      config.s3Bucket,
      config.s3Prefix ?? "chains/",
      config.s3Region ?? "us-east-1",
      {
        endpoint: config.s3Endpoint,
        accessKey: config.s3AccessKey,
        secretKey: config.s3SecretKey,
      },
    );
  }
  return createLocalSource(config.localDir);
}
