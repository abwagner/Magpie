// ── Catalog integration smoke test ───────────────────────────────
// Runs the aggregator against the real repo's data/ directory and
// asserts the response contains a descriptor for every expected
// dataset kind, with plausible fields. Intended as a belt-and-
// suspenders check when curl/http access is not available in the
// local harness.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import duckdb from "duckdb";
import { createCatalogService } from "../../index.js";
import { initDatabase } from "../../../db/init.js";
import { createStorage } from "../../../storage.js";
import { createLogger } from "../../../logger.js";

const ROOT_DIR = resolve(__dirname, "..", "..", "..", "..");

describe("catalogService.build", () => {
  let db: duckdb.Database;
  let service: ReturnType<typeof createCatalogService>;
  let warm: Awaited<ReturnType<ReturnType<typeof createCatalogService>["build"]>>;

  // One cold-cache build for all tests — chains collector scans 500
  // parquets via a serial queue, which can easily take > 30s.
  beforeAll(async () => {
    db = new duckdb.Database(resolve(ROOT_DIR, "data", "portfolio.duckdb"));
    await initDatabase(db);
    // createStorage() resolves chains via DATA_URI/DATA_DIR; point both at
    // the data root so chains live at <root>/data/chains/*.parquet.
    process.env.DATA_DIR = resolve(ROOT_DIR, "data");
    const storage = createStorage();
    const logger = createLogger("catalog-test", "warn");
    service = createCatalogService({ db, storage, rootDir: ROOT_DIR, logger });
    warm = await service.build(true);
  }, 600_000);

  afterAll(() => {
    db.close();
  });

  it("produces a well-formed response", () => {
    const response = warm;
    expect(response.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(response.descriptors)).toBe(true);
    expect(response.descriptors.length).toBeGreaterThan(0);

    for (const d of response.descriptors) {
      expect(typeof d.id).toBe("string");
      expect(d.id.length).toBeGreaterThan(0);
      expect(typeof d.kind).toBe("string");
      expect(Array.isArray(d.symbols)).toBe(true);
      expect(typeof d.row_count).toBe("number");
      expect(typeof d.file_count).toBe("number");
      expect(typeof d.size_bytes).toBe("number");
    }
  });

  it("covers every expected dataset kind that has data on disk", async () => {
    const response = warm;
    const kinds = new Set(response.descriptors.map((d) => d.kind));
    // These five kinds are known to have data in the repo. fills is
    // commonly empty; backtest has one sample file. Both are optional.
    expect(kinds.has("chains")).toBe(true);
    expect(kinds.has("signals")).toBe(true);
    expect(kinds.has("etf")).toBe(true);
    expect(kinds.has("futures")).toBe(true);
    expect(kinds.has("macro")).toBe(true);
  });

  it("emits correct index_relation for canonical symbols", async () => {
    const response = warm;
    const spy = response.descriptors.find((d) => d.id === "chains:SPY");
    expect(spy?.index_relation).toBe("spx-index");

    const vxx = response.descriptors.find((d) => d.id === "etf:VXX");
    expect(vxx?.index_relation).toBe("vix-derived");

    const cl = response.descriptors.find(
      (d) => d.kind === "futures" && (d.symbols[0] ?? "").includes("CL"),
    );
    expect(cl?.index_relation).toBe("commodity");
  });

  it("chains descriptors carry strike/dte stats", async () => {
    const response = warm;
    const spy = response.descriptors.find((d) => d.id === "chains:SPY");
    expect(spy).toBeDefined();
    if (spy) {
      const ts = spy.type_specific as Record<string, number>;
      expect(ts.strike_count).toBeGreaterThan(0);
      expect(ts.expiration_count).toBeGreaterThan(0);
    }
  });

  it("futures descriptors infer granularity from filename", async () => {
    const response = warm;
    const daily = response.descriptors.find((d) => d.id === "futures:cl:ohlcv_1d");
    const mbp = response.descriptors.find((d) => d.id === "futures:cl:mbp_1");
    expect(daily?.granularity).toBe("daily");
    expect(mbp?.granularity).toBe("event");
  });

  it("second call within TTL returns cached response (same generated_at)", async () => {
    const second = await service.build();
    expect(second.generated_at).toBe(warm.generated_at);
  });

  // ── QF-174 / schema v1.1 ──────────────────────────────────────────

  it("response declares schema_version: '1.1'", () => {
    expect(warm.schema_version).toBe("1.1");
  });

  it("parquet-backed descriptors expose a non-empty parquet_uri", () => {
    const parquetKinds = new Set(["chains", "etf", "futures", "macro", "signals"]);
    const parquetBacked = warm.descriptors.filter((d) => parquetKinds.has(d.kind));
    expect(parquetBacked.length).toBeGreaterThan(0);
    for (const d of parquetBacked) {
      expect(d.parquet_uri).not.toBeNull();
      expect(typeof d.parquet_uri).toBe("string");
      expect(d.parquet_uri!.endsWith(".parquet")).toBe(true);
    }
  });

  it("non-parquet descriptors (fills, backtest, qo-run) carry parquet_uri: null", () => {
    const nonParquetKinds = new Set(["fills", "backtest", "qo-run"]);
    const nonParquet = warm.descriptors.filter((d) => nonParquetKinds.has(d.kind));
    // These kinds are commonly empty in the test env, so accept zero matches.
    for (const d of nonParquet) {
      expect(d.parquet_uri).toBeNull();
      expect(d.column_schema).toEqual([]);
    }
  });

  it("parquet-backed descriptors materialize a non-empty column_schema", () => {
    // Pick one descriptor from each parquet-backed kind that has data; the
    // schema introspection should return at least one column.
    const spy = warm.descriptors.find((d) => d.id === "chains:SPY");
    expect(spy?.column_schema.length).toBeGreaterThan(0);
    // chains parquets must contain a `date` column (used by every consumer).
    expect(spy?.column_schema.some((c) => c.name === "date")).toBe(true);

    const daily = warm.descriptors.find((d) => d.id === "futures:cl:ohlcv_1d");
    expect(daily?.column_schema.length).toBeGreaterThan(0);
    // OHLCV parquets always have a `datetime` column.
    expect(daily?.column_schema.some((c) => c.name === "datetime")).toBe(true);
  });

  it("futures OHLCV descriptors carry bar_interval + tz in type_specific (OQ8)", () => {
    const daily = warm.descriptors.find((d) => d.id === "futures:cl:ohlcv_1d");
    expect(daily?.type_specific.bar_interval).toBe("1d");
    expect(daily?.type_specific.tz).toBe("UTC");

    // mbp_1 isn't OHLCV — bar_interval shouldn't be set.
    const mbp = warm.descriptors.find((d) => d.id === "futures:cl:mbp_1");
    expect(mbp?.type_specific.bar_interval).toBeUndefined();
    expect(mbp?.type_specific.tz).toBe("UTC");
  });

  it("column_schema entries have the expected shape", () => {
    const spy = warm.descriptors.find((d) => d.id === "chains:SPY");
    expect(spy).toBeDefined();
    for (const c of spy!.column_schema) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.dtype).toBe("string");
      expect(typeof c.nullable).toBe("boolean");
    }
  });
});
