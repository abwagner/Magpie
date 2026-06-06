import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSidecars, synthesizeRuns, activityFromSidecars } from "../../parsers/sidecar.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidecar-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeMeta(name: string, body: object): void {
  writeFileSync(join(dir, name), JSON.stringify(body));
}

describe("sidecar aggregator", () => {
  it("collects sidecars and skips non-meta files", () => {
    writeMeta("VXX.parquet.meta.json", {
      fetched_at: "2026-04-15T12:55:44Z",
      data_as_of: "2026-04-14",
      rows_returned: 4,
      http_status: 200,
    });
    writeMeta("UVXY.parquet.meta.json", {
      fetched_at: "2026-04-15T12:55:50Z",
      data_as_of: "2026-04-14",
      rows_returned: 4,
      http_status: 200,
    });
    writeFileSync(join(dir, "VXX.parquet"), "binary");

    const out = collectSidecars(dir);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.symbol).sort()).toEqual(["UVXY", "VXX"]);
  });

  it("groups sidecars by ingest day into one synthetic run each", () => {
    writeMeta("VXX.parquet.meta.json", {
      fetched_at: "2026-04-15T12:55:44Z",
      data_as_of: "2026-04-14",
      rows_returned: 4,
      http_status: 200,
    });
    writeMeta("UVXY.parquet.meta.json", {
      fetched_at: "2026-04-15T12:56:50Z",
      data_as_of: "2026-04-14",
      rows_returned: 4,
      http_status: 200,
    });
    writeMeta("SPY.parquet.meta.json", {
      fetched_at: "2026-04-16T13:00:00Z",
      data_as_of: "2026-04-15",
      rows_returned: 50,
      http_status: 200,
    });

    const sidecars = collectSidecars(dir);
    const runs = synthesizeRuns(sidecars, {
      source: "marketdata.app:etf",
      idPrefix: "etf",
    });
    expect(runs).toHaveLength(2);
    // Newest first
    expect(runs[0]!.id).toBe("etf:2026-04-16");
    expect(runs[1]!.id).toBe("etf:2026-04-15");
    expect(runs[1]!.files_written).toBe(2);
    expect(runs[1]!.rows_written).toBe(8);
    expect(runs[1]!.status).toBe("synthesized");
    expect(runs[1]!.duration_seconds).toBe(66);
  });

  it("flags status:error and notes count when any sidecar reports non-2xx", () => {
    writeMeta("BAD.parquet.meta.json", {
      fetched_at: "2026-04-15T12:55:44Z",
      data_as_of: "2026-04-14",
      rows_returned: 0,
      http_status: 500,
    });
    const sidecars = collectSidecars(dir);
    const runs = synthesizeRuns(sidecars, { source: "x", idPrefix: "x" });
    expect(runs[0]!.status).toBe("error");
    expect(runs[0]!.error_count).toBe(1);
    expect(runs[0]!.notes[0]).toMatch(/non-2xx/);
  });

  it("activityFromSidecars rolls up per-symbol files and date range", () => {
    writeMeta("SPY-2026-03.parquet.meta.json", {
      fetched_at: "2026-04-15T12:55:44Z",
      data_as_of: "2026-03-31",
      rows_returned: 30,
      http_status: 200,
    });
    writeMeta("SPY-2026-04.parquet.meta.json", {
      fetched_at: "2026-04-15T12:55:50Z",
      data_as_of: "2026-04-15",
      rows_returned: 50,
      http_status: 200,
    });
    const sidecars = collectSidecars(dir);
    const activity = activityFromSidecars(sidecars);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.symbol).toBe("SPY");
    expect(activity[0]!.files_touched).toBe(2);
    expect(activity[0]!.contracts).toBe(80);
    expect(activity[0]!.date_range).toEqual(["2026-03-31", "2026-04-15"]);
  });
});
