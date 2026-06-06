import { describe, it, expect } from "vitest";
import { createParquetSource } from "../../parquet-source.js";

describe("parquet-source", () => {
  describe("local mode", () => {
    it("generates correct glob pattern for a symbol", () => {
      const source = createParquetSource({
        mode: "local",
        localDir: "/data/chains",
      });
      expect(source.globPattern("SPY")).toBe("/data/chains/SPY-*.parquet");
    });

    it("resolves relative localDir to absolute path", () => {
      const source = createParquetSource({
        mode: "local",
        localDir: "data/chains",
      });
      const pattern = source.globPattern("AAPL");
      expect(pattern).toMatch(/^\/.*data\/chains\/AAPL-\*\.parquet$/);
    });
  });

  describe("s3 mode", () => {
    it("generates correct S3 glob pattern", () => {
      const source = createParquetSource({
        mode: "s3",
        localDir: "data/chains",
        s3Bucket: "my-bucket",
        s3Prefix: "chains/",
        s3Region: "us-east-1",
      });
      expect(source.globPattern("SPY")).toBe("s3://my-bucket/chains/SPY-*.parquet");
    });

    it("normalizes prefix without trailing slash", () => {
      const source = createParquetSource({
        mode: "s3",
        localDir: "data/chains",
        s3Bucket: "my-bucket",
        s3Prefix: "data/chains",
        s3Region: "us-west-2",
      });
      expect(source.globPattern("QQQ")).toBe("s3://my-bucket/data/chains/QQQ-*.parquet");
    });

    it("uses default prefix and region", () => {
      const source = createParquetSource({
        mode: "s3",
        localDir: "data/chains",
        s3Bucket: "my-bucket",
      });
      expect(source.globPattern("IWM")).toBe("s3://my-bucket/chains/IWM-*.parquet");
    });

    it("throws when s3Bucket is missing", () => {
      expect(() =>
        createParquetSource({
          mode: "s3",
          localDir: "data/chains",
        }),
      ).toThrow("s3Bucket is required");
    });

    it("accepts programmatic endpoint/credential overrides (MinIO)", () => {
      // Synchronous part of the contract: the new override fields shouldn't
      // break construction. The actual SET-statement plumbing is covered by
      // server/orchestrator/__tests__/unit/storage.test.ts ("initS3 overrides
      // win over env vars").
      const source = createParquetSource({
        mode: "s3",
        localDir: "data/chains",
        s3Bucket: "quantfoundry-data",
        s3Endpoint: "https://s3.example.com",
        s3AccessKey: "ak",
        s3SecretKey: "sk",
      });
      expect(source.globPattern("SPY")).toBe("s3://quantfoundry-data/chains/SPY-*.parquet");
    });
  });
});
