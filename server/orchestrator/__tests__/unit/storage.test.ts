// ── Storage Smoke Test ────────────────────────────────────────────
// Round-trip a small parquet via file:// to validate write → read,
// merge-on-dedup, and the orderBy contract used by every adapter.
//
// DATA_URI is set once before importing the module under test (the env
// is read at import time). Each test uses its own subdirectory.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "orch-storage-"));
const originalDataUri = process.env.DATA_URI;
process.env.DATA_URI = `file://${dataDir}`;

// Import after env mutation so resolveDataUri picks up our temp dir.
const { joinUri, exists, writeParquet, readParquet, mergeAndWriteParquet, maxValue, initS3 } =
  await import("../../storage.js");

// duckdb is a CJS module; default-import the namespace for `new duckdb.Database(...)`.
const duckdb = (await import("duckdb")).default;

beforeAll(() => {
  // Already prepared at module top.
});

afterAll(() => {
  if (originalDataUri === undefined) delete process.env.DATA_URI;
  else process.env.DATA_URI = originalDataUri;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("orchestrator/storage", () => {
  it("joinUri composes parts onto DATA_URI without trailing slashes", () => {
    expect(joinUri("fred", "vix.parquet")).toBe(`file://${dataDir}/fred/vix.parquet`);
    expect(joinUri()).toBe(`file://${dataDir}`);
  });

  it("dataUri reflects current env (lazy resolution)", async () => {
    const { dataUri } = await import("../../storage.js");
    expect(dataUri()).toBe(`file://${dataDir}`);
  });

  it("writeParquet creates a file readable by readParquet", async () => {
    const uri = joinUri("smoke", "vix.parquet");

    const rows = [
      { date: "2026-04-25", value: 17.2 },
      { date: "2026-04-26", value: 18.0 },
      { date: "2026-04-27", value: 17.8 },
    ];
    const { rowCount } = await writeParquet({
      uri,
      schema: "(date DATE, value DOUBLE)",
      rows,
      orderBy: "date",
    });
    expect(rowCount).toBe(3);
    expect(await exists(uri)).toBe(true);

    const back = await readParquet<{ date: unknown; value: number }>(uri, { orderBy: "date" });
    expect(back).toHaveLength(3);
    expect(back[0]?.value).toBeCloseTo(17.2);
    expect(back[2]?.value).toBeCloseTo(17.8);
  });

  it("mergeAndWriteParquet upserts on the dedup key — new rows win", async () => {
    const uri = joinUri("merge", "series.parquet");
    const schema = "(date DATE, value DOUBLE)";

    await mergeAndWriteParquet({
      uri,
      schema,
      dedupKey: "date",
      rows: [
        { date: "2026-04-25", value: 1.0 },
        { date: "2026-04-26", value: 2.0 },
        { date: "2026-04-27", value: 3.0 },
      ],
      orderBy: "date",
    });

    const result = await mergeAndWriteParquet({
      uri,
      schema,
      dedupKey: "date",
      rows: [
        { date: "2026-04-27", value: 3.5 },
        { date: "2026-04-28", value: 4.0 },
      ],
      orderBy: "date",
    });
    expect(result.rowCount).toBe(4);

    const final = await readParquet<{ date: unknown; value: number }>(uri, { orderBy: "date" });
    const byDate: Record<string, number> = {};
    for (const r of final) {
      const d =
        r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
      byDate[d] = r.value;
    }
    expect(byDate["2026-04-25"]).toBeCloseTo(1.0);
    expect(byDate["2026-04-27"]).toBeCloseTo(3.5);
    expect(byDate["2026-04-28"]).toBeCloseTo(4.0);
  });

  it("maxValue returns the maximum of a column, or null when missing", async () => {
    const uri = joinUri("agg", "series.parquet");
    expect(await maxValue<string>(uri, "date")).toBeNull();

    await writeParquet({
      uri,
      schema: "(date DATE, value DOUBLE)",
      rows: [
        { date: "2026-04-25", value: 1.0 },
        { date: "2026-04-27", value: 3.0 },
        { date: "2026-04-26", value: 2.0 },
      ],
    });

    const max = await maxValue<unknown>(uri, "date");
    const asString =
      max instanceof Date ? max.toISOString().slice(0, 10) : String(max).slice(0, 10);
    expect(asString).toBe("2026-04-27");
  });

  it("exists returns false for a non-existent URI", async () => {
    expect(await exists(joinUri("never", "written.parquet"))).toBe(false);
  });

  it("writeParquet creates parent directories as needed", async () => {
    const uri = joinUri("nested", "deep", "path", "x.parquet");
    await writeParquet({
      uri,
      schema: "(k INTEGER)",
      rows: [{ k: 1 }],
    });
    const localPath = uri.replace("file://", "");
    expect(existsSync(localPath)).toBe(true);
  });
});

describe("initS3", () => {
  const S3_ENV = ["S3_REGION", "S3_ENDPOINT_URL", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;
  const saved: Partial<Record<(typeof S3_ENV)[number], string | undefined>> = {};

  beforeAll(() => {
    for (const k of S3_ENV) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of S3_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function readSettings(db: InstanceType<typeof duckdb.Database>): Promise<Record<string, string>> {
    return new Promise((resolveQuery, reject) => {
      db.all("SELECT name, value FROM duckdb_settings() WHERE name LIKE 's3_%'", (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        const out: Record<string, string> = {};
        for (const row of rows as Array<{ name: string; value: string }>) {
          out[row.name] = row.value;
        }
        resolveQuery(out);
      });
    });
  }

  async function withTmpDb<T>(
    fn: (db: InstanceType<typeof duckdb.Database>) => Promise<T>,
  ): Promise<T> {
    const db = new duckdb.Database(":memory:");
    try {
      return await fn(db);
    } finally {
      await new Promise<void>((resolveClose) => db.close(() => resolveClose()));
    }
  }

  it("applies env vars (https endpoint → use_ssl + path style + scheme stripped)", async () => {
    process.env.S3_REGION = "eu-west-2";
    process.env.S3_ENDPOINT_URL = "https://s3.example.com";
    process.env.S3_ACCESS_KEY = "env-ak";
    process.env.S3_SECRET_KEY = "env-sk";

    await withTmpDb(async (db) => {
      await initS3(db);
      const s = await readSettings(db);
      expect(s.s3_region).toBe("eu-west-2");
      expect(s.s3_endpoint).toBe("s3.example.com");
      expect(s.s3_use_ssl).toBe("true");
      expect(s.s3_url_style).toBe("path");
      expect(s.s3_access_key_id).toBe("env-ak");
      expect(s.s3_secret_access_key).toBe("env-sk");
    });
  });

  it("overrides win over env vars (http endpoint → use_ssl=false)", async () => {
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ENDPOINT_URL = "https://env-endpoint.example.com";
    process.env.S3_ACCESS_KEY = "env-ak";
    process.env.S3_SECRET_KEY = "env-sk";

    await withTmpDb(async (db) => {
      await initS3(db, {
        endpoint: "http://localhost:9000",
        accessKey: "override-ak",
        secretKey: "override-sk",
      });
      const s = await readSettings(db);
      expect(s.s3_endpoint).toBe("localhost:9000");
      expect(s.s3_use_ssl).toBe("false");
      expect(s.s3_access_key_id).toBe("override-ak");
      expect(s.s3_secret_access_key).toBe("override-sk");
    });
  });

  it("omits endpoint settings entirely when neither env nor override provides one", async () => {
    delete process.env.S3_ENDPOINT_URL;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
    process.env.S3_REGION = "us-east-1";

    await withTmpDb(async (db) => {
      await initS3(db);
      const s = await readSettings(db);
      expect(s.s3_region).toBe("us-east-1");
      // s3_endpoint defaults to s3.amazonaws.com when unset; we just don't SET it
      expect(s.s3_endpoint).not.toBe("localhost:9000");
    });
  });
});
