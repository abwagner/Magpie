// ── Ingest Orchestrator Test ──────────────────────────────────────
// Verifies collectSourceBatches dedups by output URI and skips deps
// without a `source:` field (live deps go through the market-data API,
// not the batch ingest path).

import { describe, it, expect } from "vitest";
import type { SignalManifest } from "../../signal-manifest.js";

// Set DATA_URI before importing modules that reach storage.dataUri().
process.env.DATA_URI = process.env.DATA_URI ?? "file:///tmp/test-orch-ingest";

const { collectSourceBatches } = await import("../../ingest.js");

function makeManifest(name: string, deps: SignalManifest["data"]): SignalManifest {
  return {
    model_id: name,
    model_version: "1.0.0",
    schedule: { mode: "interval", interval_seconds: 60, timezone: "America/New_York" },
    emit: { symbol: `EQ:${name}`, kinds: ["point"] },
    entrypoint: "cli.py signal",
    venv: ".venv/bin/python",
    data: deps,
    _dir: `/data-signals/signals/${name}`,
  };
}

describe("orchestrator/ingest", () => {
  it("collects batched requests for one source", () => {
    const manifest = makeManifest("sig-a", [
      {
        source: "fmp",
        name: "universe",
        args: { kind: "universe", indices: ["sp500"] },
        output: "fundamentals/fmp/universe.parquet",
        refresh: { mode: "scheduled", cron: "0 18 * * 0" },
        freshness: { max_age_hours: 240, required: true },
      },
      {
        source: "fmp",
        name: "fundamentals_snapshot",
        args: { kind: "fundamentals", universe_parquet: "fundamentals/fmp/universe.parquet" },
        output: "fundamentals/fmp/fundamentals_snapshot.parquet",
        refresh: { mode: "scheduled", cron: "30 18 * * 0" },
        freshness: { max_age_hours: 192, required: true },
      },
    ]);

    const requests = collectSourceBatches([manifest], "fmp");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.args.kind).toBe("universe");
    expect(requests[1]?.args.kind).toBe("fundamentals");
    // Outputs are pre-resolved to absolute URIs
    for (const r of requests) {
      expect(r.output).toMatch(/^(file:|s3:)/);
    }
  });

  it("dedups across manifests by output URI (first wins)", () => {
    const m1 = makeManifest("sig-a", [
      {
        source: "fred",
        name: "vix",
        args: { series: "VIXCLS" },
        output: "fred/vix.parquet",
        refresh: { mode: "scheduled", cron: "0 19 * * 1-5" },
        freshness: { max_age_hours: 80, required: true },
      },
    ]);
    const m2 = makeManifest("sig-b", [
      {
        source: "fred",
        name: "vix",
        args: { series: "VIXCLS_DUPLICATE_INTENT" },
        output: "fred/vix.parquet",
        refresh: { mode: "scheduled", cron: "0 19 * * 1-5" },
        freshness: { max_age_hours: 80, required: true },
      },
    ]);

    const requests = collectSourceBatches([m1, m2], "fred");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args.series).toBe("VIXCLS"); // first-wins
  });

  it("skips deps without a source field (live deps)", () => {
    const manifest = makeManifest("sig-a", [
      {
        source: "fred",
        name: "vix",
        args: { series: "VIXCLS" },
        output: "fred/vix.parquet",
        refresh: { mode: "scheduled" },
        freshness: { max_age_hours: 80, required: true },
      },
      {
        // no source — live dep through Magpie market-data
        name: "spy_quote",
        args: { symbol: "SPY", type: "quote" },
        refresh: { mode: "before_tick" },
        freshness: { max_age_seconds: 60, required: true },
      },
    ]);

    const fred = collectSourceBatches([manifest], "fred");
    expect(fred).toHaveLength(1);
  });

  it("skips deps without an output (in-memory live deps)", () => {
    const manifest = makeManifest("sig-a", [
      {
        source: "fred",
        name: "live-only",
        args: { series: "X" },
        // no output
        refresh: { mode: "before_tick" },
        freshness: { max_age_seconds: 60, required: true },
      },
    ]);
    expect(collectSourceBatches([manifest], "fred")).toHaveLength(0);
  });
});
