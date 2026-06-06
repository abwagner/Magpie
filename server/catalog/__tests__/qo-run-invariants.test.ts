// ── qo-run invariants unit tests ──────────────────────────────────
// One happy-path fixture + one targeted sad-path per invariant code.
// The CLI driver gets its own smoke test in scripts/__tests__/ if/when
// it ever grows complex enough to warrant it; today it's a thin shell
// over validateWfoFile + formatViolation.

import { describe, expect, it } from "vitest";
import { validateWfoFile, formatViolation, type Violation } from "../qo-run-invariants.js";

// ── Fixture builders ───────────────────────────────────────────────

function makeOos(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    n_trades: 30,
    net_pnl: 1234.5,
    sortino: 0.4,
    hit_rate: 0.6,
    max_dd: 200.0,
    ...overrides,
  };
}

function makeFold(
  foldId: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    best_at_trial: 42,
    oos: makeOos(),
    ...overrides,
  };
}

function makeFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    strategy: "cl_scalp",
    lineage_id: "deadbeef-...",
    folds: [makeFold(0)],
    ...overrides,
  };
}

function codes(vs: Violation[]): string[] {
  return vs.map((v) => v.code);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("validateWfoFile — happy path", () => {
  it("returns no violations for a well-formed single-fold file", () => {
    const result = validateWfoFile(makeFile());
    expect(result).toEqual([]);
  });

  it("returns no violations for a multi-fold rolling-forward file", () => {
    const result = validateWfoFile(
      makeFile({
        folds: [
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
          makeFold(2, {
            is_start: "2026-03-15",
            is_end: "2026-04-14",
            oos_start: "2026-04-14",
            oos_end: "2026-04-21",
          }),
        ],
      }),
    );
    expect(result).toEqual([]);
  });

  it("tolerates omitted lineage_id (pre-B2 files)", () => {
    const file = makeFile();
    delete file.lineage_id;
    expect(validateWfoFile(file)).toEqual([]);
  });

  it("tolerates omitted schema_version (defaults to 1)", () => {
    const file = makeFile();
    delete file.schema_version;
    expect(validateWfoFile(file)).toEqual([]);
  });
});

describe("validateWfoFile — structure violations", () => {
  it("flags non-object top-level JSON", () => {
    expect(codes(validateWfoFile([]))).toContain("qo.structure.not-object");
    expect(codes(validateWfoFile("oops"))).toContain("qo.structure.not-object");
    expect(codes(validateWfoFile(null))).toContain("qo.structure.not-object");
  });

  it("flags missing strategy", () => {
    expect(codes(validateWfoFile(makeFile({ strategy: "" })))).toContain(
      "qo.structure.missing-strategy",
    );
    const file = makeFile();
    delete file.strategy;
    expect(codes(validateWfoFile(file))).toContain("qo.structure.missing-strategy");
  });

  it("flags non-integer schema_version", () => {
    expect(codes(validateWfoFile(makeFile({ schema_version: "1" })))).toContain(
      "qo.structure.bad-schema-version",
    );
  });

  it("flags schema_version newer than supported", () => {
    expect(codes(validateWfoFile(makeFile({ schema_version: 2 })))).toContain(
      "qo.structure.future-schema-version",
    );
  });

  it("flags missing folds array", () => {
    const file = makeFile();
    delete file.folds;
    expect(codes(validateWfoFile(file))).toContain("qo.structure.missing-folds");
  });

  it("flags empty folds array", () => {
    expect(codes(validateWfoFile(makeFile({ folds: [] })))).toContain("qo.structure.empty-folds");
  });
});

describe("validateWfoFile — fold-level violations", () => {
  it("flags missing required fold fields", () => {
    const fold = makeFold(0);
    delete fold.is_start;
    delete fold.is_metric;
    const vs = validateWfoFile(makeFile({ folds: [fold] }));
    const missing = vs.find((v) => v.code === "qo.fold.missing-fields");
    expect(missing?.detail).toContain("is_start");
    expect(missing?.detail).toContain("is_metric");
  });

  it("flags missing required OOS fields", () => {
    const oos = makeOos();
    delete oos.sortino;
    delete oos.max_dd;
    const vs = validateWfoFile(makeFile({ folds: [makeFold(0, { oos })] }));
    const missing = vs.find((v) => v.code === "qo.oos.missing-fields");
    expect(missing?.detail).toContain("sortino");
    expect(missing?.detail).toContain("max_dd");
  });

  it("flags duplicate fold_ids", () => {
    const vs = validateWfoFile(makeFile({ folds: [makeFold(0), makeFold(0)] }));
    expect(codes(vs)).toContain("qo.fold.duplicate-id");
  });

  it("flags inverted IS window", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { is_start: "2026-03-31", is_end: "2026-03-01" })] }),
    );
    expect(codes(vs)).toContain("qo.window.is-inverted");
  });

  it("flags inverted OOS window", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { oos_start: "2026-04-07", oos_end: "2026-03-31" })] }),
    );
    expect(codes(vs)).toContain("qo.window.oos-inverted");
  });

  it("flags IS/OOS leakage", () => {
    const vs = validateWfoFile(
      makeFile({
        folds: [
          makeFold(0, {
            is_start: "2026-03-01",
            is_end: "2026-04-15",
            oos_start: "2026-03-31",
            oos_end: "2026-04-07",
          }),
        ],
      }),
    );
    expect(codes(vs)).toContain("qo.window.is-oos-leak");
  });

  it("flags walk-forward regression (fold ordering moves backward)", () => {
    const vs = validateWfoFile(
      makeFile({
        folds: [
          makeFold(0, {
            is_start: "2026-04-01",
            is_end: "2026-04-30",
            oos_start: "2026-04-30",
            oos_end: "2026-05-07",
          }),
          makeFold(1, {
            is_start: "2026-03-01",
            is_end: "2026-03-31",
            oos_start: "2026-03-31",
            oos_end: "2026-04-07",
          }),
        ],
      }),
    );
    expect(codes(vs)).toContain("qo.walk-forward.regression");
  });
});

describe("validateWfoFile — trial bookkeeping violations", () => {
  it("flags best_at_trial out of range", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { n_trials_completed: 50, best_at_trial: 60 })] }),
    );
    expect(codes(vs)).toContain("qo.trials.best-at-trial-out-of-range");
  });

  it("flags best_at_trial = n_trials_completed (off-by-one)", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { n_trials_completed: 50, best_at_trial: 50 })] }),
    );
    expect(codes(vs)).toContain("qo.trials.best-at-trial-out-of-range");
  });

  it("tolerates null best_at_trial", () => {
    const vs = validateWfoFile(makeFile({ folds: [makeFold(0, { best_at_trial: null })] }));
    expect(codes(vs)).toEqual([]);
  });

  it("flags n_trials_completed > n_trials_target", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { n_trials_completed: 101, n_trials_target: 100 })] }),
    );
    expect(codes(vs)).toContain("qo.trials.over-budget");
  });
});

describe("validateWfoFile — OOS sanity violations", () => {
  it("flags negative n_trades", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { oos: makeOos({ n_trades: -1 }) })] }),
    );
    expect(codes(vs)).toContain("qo.oos.negative-trades");
  });

  it("flags hit_rate > 1", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { oos: makeOos({ hit_rate: 1.5 }) })] }),
    );
    expect(codes(vs)).toContain("qo.oos.hit-rate-out-of-range");
  });

  it("flags hit_rate < 0", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { oos: makeOos({ hit_rate: -0.1 }) })] }),
    );
    expect(codes(vs)).toContain("qo.oos.hit-rate-out-of-range");
  });

  it("flags negative max_dd", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { oos: makeOos({ max_dd: -50 }) })] }),
    );
    expect(codes(vs)).toContain("qo.oos.negative-max-dd");
  });

  it("tolerates n_trades = 0 (degenerate fold but valid)", () => {
    const vs = validateWfoFile(
      makeFile({ folds: [makeFold(0, { oos: makeOos({ n_trades: 0 }) })] }),
    );
    expect(codes(vs)).toEqual([]);
  });
});

describe("formatViolation", () => {
  it("renders file · scope · code · detail", () => {
    expect(
      formatViolation("data/results/qo/cl_scalp/run.json", {
        code: "qo.window.is-inverted",
        scope: 3,
        detail: "is_start (2026-03-31) > is_end (2026-03-01)",
      }),
    ).toBe(
      "data/results/qo/cl_scalp/run.json · 3 · qo.window.is-inverted · is_start (2026-03-31) > is_end (2026-03-01)",
    );
  });

  it("renders 'top' scope literally", () => {
    expect(
      formatViolation("a.json", { code: "qo.structure.empty-folds", scope: "top", detail: "" }),
    ).toMatch(/^a\.json · top · qo\.structure\.empty-folds · $/);
  });
});
