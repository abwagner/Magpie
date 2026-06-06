// ── qo-runs collector unit tests ──────────────────────────────────
// Covers: empty dir, malformed JSON skip, well-formed JSON, missing
// optional fields (lineage_id, schema_version), recursive walk into
// <strategy>/<run-id>/ subdirs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQoRunsCollector } from "../collectors/qo-runs.js";
import type { IndexRelationLookup } from "../indexRelation.js";

const stubIndexRelation: IndexRelationLookup = {
  classify: () => "unrelated",
};

function writeWfoResults(dir: string, filename: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(body, null, 2));
}

function makeFold(foldId: number, overrides: Record<string, unknown> = {}) {
  return {
    fold_id: foldId,
    is_start: "2026-03-01",
    is_end: "2026-03-31",
    oos_start: "2026-03-31",
    oos_end: "2026-04-07",
    is_metric: 0.5,
    best_params: { stop_loss_dollars: 1500 },
    sampler: "TPESampler",
    n_trials_completed: 100,
    n_trials_target: 100,
    oos: {
      n_trades: 30,
      net_pnl: 1234.5,
      sortino: 0.4,
      hit_rate: 0.6,
      max_dd: 200.0,
    },
    ...overrides,
  };
}

describe("qo-runs collector", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qo-runs-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns [] when results dir does not exist", async () => {
    const collector = createQoRunsCollector({
      resultsDir: join(root, "nonexistent"),
      indexRelation: stubIndexRelation,
    });
    expect(await collector.describe()).toEqual([]);
  });

  it("returns [] when results dir is empty", async () => {
    mkdirSync(join(root, "qo"));
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    expect(await collector.describe()).toEqual([]);
  });

  it("emits one descriptor per wfo_results JSON in a recursive walk", async () => {
    writeWfoResults(
      join(root, "qo", "cl_scalp", "2026-05-13_run-a"),
      "wfo_results_cl_scalp_2026-03-01_2026-04-28.json",
      {
        schema_version: 1,
        strategy: "cl_scalp",
        lineage_id: "11111111-1111-1111-1111-111111111111",
        folds: [
          makeFold(0),
          makeFold(1, { is_end: "2026-04-07", oos_start: "2026-04-07", oos_end: "2026-04-14" }),
        ],
      },
    );
    writeWfoResults(
      join(root, "qo", "cl_scalp_options", "2026-05-13_run-b"),
      "wfo_results_cl_scalp_options_2026-04-01_2026-04-11.json",
      {
        schema_version: 1,
        strategy: "cl_scalp_options",
        lineage_id: "22222222-2222-2222-2222-222222222222",
        folds: [makeFold(0)],
      },
    );

    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    const out = await collector.describe();
    expect(out).toHaveLength(2);
    const byStrategy = Object.fromEntries(out.map((d) => [d.type_specific.strategy, d]));
    expect(byStrategy.cl_scalp).toBeDefined();
    expect(byStrategy.cl_scalp_options).toBeDefined();
    expect(byStrategy.cl_scalp.kind).toBe("qo-run");
    expect(byStrategy.cl_scalp.type_specific.n_folds).toBe(2);
    expect(byStrategy.cl_scalp.type_specific.lineage_id).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(byStrategy.cl_scalp.type_specific.schema_version).toBe(1);
    expect(byStrategy.cl_scalp_options.type_specific.n_folds).toBe(1);
  });

  it("computes is_window + oos_window across folds", async () => {
    writeWfoResults(
      join(root, "qo", "cl_scalp"),
      "wfo_results_cl_scalp_2026-03-01_2026-04-28.json",
      {
        schema_version: 1,
        strategy: "cl_scalp",
        folds: [
          makeFold(2, {
            is_start: "2026-03-15",
            is_end: "2026-04-14",
            oos_start: "2026-04-14",
            oos_end: "2026-04-21",
          }),
          makeFold(0, {
            is_start: "2026-03-01",
            is_end: "2026-03-31",
            oos_start: "2026-03-31",
            oos_end: "2026-04-07",
          }),
          makeFold(1, {
            is_start: "2026-03-08",
            is_end: "2026-04-07",
            oos_start: "2026-04-07",
            oos_end: "2026-04-14",
          }),
        ],
      },
    );
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    const [d] = await collector.describe();
    expect(d!.type_specific.is_window).toEqual(["2026-03-01", "2026-04-14"]);
    expect(d!.type_specific.oos_window).toEqual(["2026-03-31", "2026-04-21"]);
    expect(d!.date_min).toBe("2026-03-01");
    expect(d!.date_max).toBe("2026-04-21");
  });

  it("computes best_oos_metric as max net_pnl across folds", async () => {
    writeWfoResults(
      join(root, "qo", "cl_scalp"),
      "wfo_results_cl_scalp_2026-03-01_2026-04-28.json",
      {
        schema_version: 1,
        strategy: "cl_scalp",
        folds: [
          makeFold(0, {
            oos: { n_trades: 1, net_pnl: 100, sortino: 0.1, hit_rate: 0.5, max_dd: 50 },
          }),
          makeFold(1, {
            oos: { n_trades: 2, net_pnl: 500, sortino: 0.2, hit_rate: 0.5, max_dd: 50 },
          }),
          makeFold(2, {
            oos: { n_trades: 3, net_pnl: 300, sortino: 0.3, hit_rate: 0.5, max_dd: 50 },
          }),
        ],
      },
    );
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    const [d] = await collector.describe();
    expect(d!.type_specific.best_oos_metric).toBe(500);
  });

  it("tolerates missing lineage_id and schema_version (pre-B2 files)", async () => {
    writeWfoResults(
      join(root, "qo", "cl_scalp"),
      "wfo_results_cl_scalp_2026-03-01_2026-04-28.json",
      {
        strategy: "cl_scalp",
        folds: [makeFold(0)],
      },
    );
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    const [d] = await collector.describe();
    expect(d!.type_specific.lineage_id).toBeNull();
    expect(d!.type_specific.schema_version).toBeNull();
  });

  it("skips files with malformed JSON without throwing", async () => {
    mkdirSync(join(root, "qo", "cl_scalp"), { recursive: true });
    writeFileSync(join(root, "qo", "cl_scalp", "wfo_results_cl_scalp_bad.json"), "{not valid json");
    // And one good file alongside.
    writeWfoResults(join(root, "qo", "cl_scalp"), "wfo_results_cl_scalp_good.json", {
      schema_version: 1,
      strategy: "cl_scalp",
      folds: [makeFold(0)],
    });
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    const out = await collector.describe();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toContain("good");
  });

  it("skips files with empty folds array", async () => {
    writeWfoResults(join(root, "qo", "cl_scalp"), "wfo_results_cl_scalp_empty.json", {
      schema_version: 1,
      strategy: "cl_scalp",
      folds: [],
    });
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    expect(await collector.describe()).toEqual([]);
  });

  it("ignores non-matching filenames in the same directory", async () => {
    mkdirSync(join(root, "qo", "cl_scalp"), { recursive: true });
    writeFileSync(join(root, "qo", "cl_scalp", "summary.json"), JSON.stringify({}));
    writeFileSync(join(root, "qo", "cl_scalp", "notes.md"), "# notes");
    writeWfoResults(join(root, "qo", "cl_scalp"), "wfo_results_cl_scalp_match.json", {
      schema_version: 1,
      strategy: "cl_scalp",
      folds: [makeFold(0)],
    });
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    const out = await collector.describe();
    expect(out).toHaveLength(1);
  });

  it("descriptor id is derived from filename (resolvable via /api/qo-run/:id)", async () => {
    writeWfoResults(
      join(root, "qo", "cl_scalp"),
      "wfo_results_cl_scalp_2026-03-01_2026-04-28.json",
      {
        schema_version: 1,
        strategy: "cl_scalp",
        folds: [makeFold(0)],
      },
    );
    const collector = createQoRunsCollector({
      resultsDir: join(root, "qo"),
      indexRelation: stubIndexRelation,
    });
    const [d] = await collector.describe();
    expect(d!.id).toBe("qo-run:wfo_results_cl_scalp_2026-03-01_2026-04-28");
  });
});
