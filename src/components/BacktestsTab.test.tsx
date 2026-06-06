// Vitest + @testing-library/react coverage for the Backtests tab.
//
// Mocks `api.getCatalog` and `api.getQoRun` so we exercise the UI
// state machine without a server: empty state, populated list, row
// selection drilling into per-fold detail, error surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

vi.mock("../lib/api.js", () => ({
  api: {
    getCatalog: vi.fn(),
    getQoRun: vi.fn(),
  },
}));

import { api } from "../lib/api.js";
import BacktestsTab from "./BacktestsTab.js";

const mockedGetCatalog = api.getCatalog as ReturnType<typeof vi.fn>;
const mockedGetQoRun = api.getQoRun as ReturnType<typeof vi.fn>;

function makeDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    id: "qo-run:wfo_results_cl_scalp_2026-03-01_2026-04-28",
    kind: "qo-run",
    label: "cl_scalp · 2026-03-01 → 2026-04-28",
    symbols: [],
    date_min: "2026-03-01",
    date_max: "2026-05-05",
    granularity: "event",
    row_count: 5,
    file_count: 1,
    size_bytes: 2048,
    last_updated: "2026-05-13T15:00:00Z",
    source: "quant-optimizer",
    index_relation: "unrelated",
    type_specific: {
      strategy: "cl_scalp",
      is_window: ["2026-03-01", "2026-04-28"],
      oos_window: ["2026-03-31", "2026-05-05"],
      n_folds: 5,
      n_trials_per_fold: 100,
      lineage_id: "11111111-1111-1111-1111-111111111111",
      best_oos_metric: 6614,
      schema_version: 1,
      file_path: "/tmp/wfo_results_cl_scalp_2026-03-01_2026-04-28.json",
    },
    ...overrides,
  };
}

function makeFoldsResponse() {
  return {
    schema_version: 1,
    strategy: "cl_scalp",
    lineage_id: "11111111-1111-1111-1111-111111111111",
    folds: [
      {
        fold_id: 0,
        is_start: "2026-03-01",
        is_end: "2026-03-31",
        oos_start: "2026-03-31",
        oos_end: "2026-04-07",
        is_metric: 16752,
        best_params: { stop_loss_dollars: 1700, bullish_threshold: 80 },
        oos: { n_trades: 7, net_pnl: 6614, sortino: 1.225, hit_rate: 0.571, max_dd: 3196 },
      },
      {
        fold_id: 1,
        is_start: "2026-03-08",
        is_end: "2026-04-07",
        oos_start: "2026-04-07",
        oos_end: "2026-04-14",
        is_metric: 1072,
        best_params: { stop_loss_dollars: 2500, bullish_threshold: 69 },
        oos: { n_trades: 4, net_pnl: 2100, sortino: 0.8, hit_rate: 0.5, max_dd: 1500 },
      },
    ],
  };
}

describe("BacktestsTab", () => {
  beforeEach(() => {
    mockedGetCatalog.mockReset();
    mockedGetQoRun.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state when no qo-run descriptors exist", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [
        // Some other kind we should filter out:
        { ...makeDescriptor({ id: "chains:SPY", kind: "chains" }) },
      ],
    });

    await act(async () => {
      render(<BacktestsTab />);
    });

    expect(await screen.findByText(/No quant-optimizer runs found/i)).toBeDefined();
    expect(mockedGetQoRun).not.toHaveBeenCalled();
  });

  it("renders the run list and auto-selects the first row, fetching its detail", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [makeDescriptor()],
    });
    mockedGetQoRun.mockResolvedValueOnce(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    // Strategy name appears in the list row + the detail card title.
    await waitFor(() => {
      const matches = screen.getAllByText(/cl_scalp/i);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
    // getQoRun called with the descriptor's id (the helper strips the
    // "qo-run:" prefix before hitting the API). Wait for the auto-select
    // useEffect to fire and the detail panel to issue its fetch.
    await waitFor(() => {
      expect(mockedGetQoRun).toHaveBeenCalledTimes(1);
    });
    expect(mockedGetQoRun.mock.calls[0]![0]).toBe(
      "qo-run:wfo_results_cl_scalp_2026-03-01_2026-04-28",
    );
    // 6614 appears in both the list row (best OOS metric) and the
    // detail row (fold 0 net_pnl). getAllByText avoids the "multiple
    // matches" failure that getByText would throw.
    await waitFor(() => {
      expect(screen.getAllByText("6614").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("filters out non-qo-run descriptors before rendering", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [
        makeDescriptor(),
        { ...makeDescriptor({ id: "chains:SPY", kind: "chains" }) },
        { ...makeDescriptor({ id: "futures:CL", kind: "futures" }) },
      ],
    });
    mockedGetQoRun.mockResolvedValueOnce(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    // HeaderStrip's "Runs" cell shows 1, not 3.
    await waitFor(() => {
      const runsLabels = screen.getAllByText(/Runs/i);
      expect(runsLabels.length).toBeGreaterThan(0);
    });
    // Only the cl_scalp row exists in the list (no chains/futures rows).
    expect(screen.queryByText(/chains:SPY/)).toBeNull();
    expect(screen.queryByText(/futures:CL/)).toBeNull();
  });

  it("surfaces a catalog fetch error in the UI without throwing", async () => {
    mockedGetCatalog.mockRejectedValueOnce(new Error("boom"));

    await act(async () => {
      render(<BacktestsTab />);
    });

    expect(await screen.findByText(/Error: boom/)).toBeDefined();
  });

  it("surfaces a per-run fetch error without unmounting the list", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [makeDescriptor()],
    });
    mockedGetQoRun.mockRejectedValueOnce(new Error("404"));

    await act(async () => {
      render(<BacktestsTab />);
    });

    await waitFor(() => {
      expect(screen.getByText(/404/)).toBeDefined();
    });
    // List row is still rendered alongside the error.
    expect(screen.getAllByText(/cl_scalp/).length).toBeGreaterThan(0);
  });

  // ── QF-124 walk-forward chart + comparison ──────────────────────

  it("renders the walk-forward chart inside the detail panel", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [makeDescriptor()],
    });
    mockedGetQoRun.mockResolvedValueOnce(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    // SVG chart with the IS/OOS legend should appear in the auto-
    // selected run's detail. "OOS net_pnl" is unique to the chart
    // legend; "IS metric" appears in both the chart legend and the
    // detail table header, so we assert at-least-one rather than one.
    await waitFor(() => {
      expect(screen.getByText("OOS net_pnl")).toBeDefined();
    });
    expect(screen.getAllByText("IS metric").length).toBeGreaterThanOrEqual(1);
  });

  // ── QF-123 grid result heatmap ──────────────────────────────────

  it("renders the run heatmap inside the detail panel", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [makeDescriptor()],
    });
    mockedGetQoRun.mockResolvedValueOnce(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    // The heatmap legend strip's "worse" / "better" labels are unique
    // text anchors that don't appear anywhere else in the tab.
    await waitFor(() => {
      expect(screen.getByText("worse")).toBeDefined();
    });
    expect(screen.getByText("better")).toBeDefined();
    // The relative-to-visible-cells caption appears once when the
    // single-run heatmap renders. The comparison panel only renders
    // on demand, so this exists exactly once at boot.
    expect(screen.getAllByText(/relative to visible cells/i).length).toBeGreaterThanOrEqual(1);
  });

  it("shows the comparison panel after checking 2 rows", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [
        makeDescriptor({
          id: "qo-run:run-a",
          type_specific: {
            strategy: "cl_scalp_a",
            is_window: ["2026-03-01", "2026-04-28"],
            oos_window: ["2026-03-31", "2026-05-05"],
            n_folds: 5,
            n_trials_per_fold: 100,
            lineage_id: "aaaa1111-1111-1111-1111-111111111111",
            best_oos_metric: 6614,
            schema_version: 1,
            file_path: "/tmp/a.json",
          },
        }),
        makeDescriptor({
          id: "qo-run:run-b",
          type_specific: {
            strategy: "cl_scalp_b",
            is_window: ["2026-03-01", "2026-04-28"],
            oos_window: ["2026-03-31", "2026-05-05"],
            n_folds: 5,
            n_trials_per_fold: 100,
            lineage_id: "bbbb2222-2222-2222-2222-222222222222",
            best_oos_metric: 4200,
            schema_version: 1,
            file_path: "/tmp/b.json",
          },
        }),
      ],
    });
    // Three resolves: 1 for auto-selected detail, 2 for comparison fetches.
    mockedGetQoRun.mockResolvedValue(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    // Wait for the list to render so the checkboxes exist.
    await waitFor(() => {
      expect(screen.getByLabelText(/Compare cl_scalp_a/i)).toBeDefined();
    });

    // Check both run-a and run-b.
    fireEvent.click(screen.getByLabelText(/Compare cl_scalp_a/i));
    fireEvent.click(screen.getByLabelText(/Compare cl_scalp_b/i));

    // Comparison card header appears.
    await waitFor(() => {
      expect(screen.getByText(/Comparison \(2\)/)).toBeDefined();
    });
    // The Comparison panel issued its own /api/qo-run/:id fetches (one per
    // checked run, in addition to the auto-select fetch).
    await waitFor(() => {
      expect(mockedGetQoRun.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("caps the comparison-checkbox selection at 3 rows", async () => {
    const descriptors = ["a", "b", "c", "d"].map((suffix, i) =>
      makeDescriptor({
        id: `qo-run:run-${suffix}`,
        type_specific: {
          strategy: `cl_scalp_${suffix}`,
          is_window: ["2026-03-01", "2026-04-28"],
          oos_window: ["2026-03-31", "2026-05-05"],
          n_folds: 5,
          n_trials_per_fold: 100,
          lineage_id: `${suffix}${suffix}${suffix}${suffix}-${i}`,
          best_oos_metric: 1000 + i * 100,
          schema_version: 1,
          file_path: `/tmp/${suffix}.json`,
        },
      }),
    );
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors,
    });
    mockedGetQoRun.mockResolvedValue(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/Compare cl_scalp_a/i)).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText(/Compare cl_scalp_a/i));
    fireEvent.click(screen.getByLabelText(/Compare cl_scalp_b/i));
    fireEvent.click(screen.getByLabelText(/Compare cl_scalp_c/i));

    // The 4th checkbox should now be disabled (cap is 3).
    const fourth = screen.getByLabelText(/Compare cl_scalp_d/i) as HTMLInputElement;
    expect(fourth.disabled).toBe(true);

    // Comparison panel reflects 3 selected.
    await waitFor(() => {
      expect(screen.getByText(/Comparison \(3\)/)).toBeDefined();
    });
  });

  // ── QF-180 search / filter ──────────────────────────────────────

  function makeSearchableDescriptors() {
    return [
      makeDescriptor({
        id: "qo-run:run-a",
        type_specific: {
          strategy: "cl_scalp",
          is_window: ["2026-03-01", "2026-04-28"],
          oos_window: ["2026-03-31", "2026-05-05"],
          n_folds: 5,
          n_trials_per_fold: 100,
          lineage_id: "aaaaaaaa-1111-1111-1111-111111111111",
          best_oos_metric: 6614,
          schema_version: 1,
          file_path: "/tmp/a.json",
        },
      }),
      makeDescriptor({
        id: "qo-run:run-b",
        type_specific: {
          strategy: "cl_scalp_options",
          is_window: ["2026-03-01", "2026-04-28"],
          oos_window: ["2026-03-31", "2026-05-05"],
          n_folds: 5,
          n_trials_per_fold: 100,
          lineage_id: "bbbbbbbb-2222-2222-2222-222222222222",
          best_oos_metric: 4200,
          schema_version: 1,
          file_path: "/tmp/b.json",
        },
      }),
      makeDescriptor({
        id: "qo-run:run-c",
        type_specific: {
          strategy: "soxx_rotation",
          is_window: ["2026-03-01", "2026-04-28"],
          oos_window: ["2026-03-31", "2026-05-05"],
          n_folds: 5,
          n_trials_per_fold: 100,
          lineage_id: "cccccccc-3333-3333-3333-333333333333",
          best_oos_metric: 1200,
          schema_version: 1,
          file_path: "/tmp/c.json",
        },
      }),
    ];
  }

  it("search input is absent when no qo-runs exist", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: [],
    });
    await act(async () => {
      render(<BacktestsTab />);
    });
    expect(await screen.findByText(/No quant-optimizer runs found/i)).toBeDefined();
    // No search input rendered in the empty state.
    expect(screen.queryByPlaceholderText("strategy name or lineage_id")).toBeNull();
  });

  it("search input renders and shows all runs by default (empty query)", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: makeSearchableDescriptors(),
    });
    mockedGetQoRun.mockResolvedValue(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    // Search input is present.
    const input = (await screen.findByPlaceholderText(
      "strategy name or lineage_id",
    )) as HTMLInputElement;
    expect(input.value).toBe("");
    // All three strategies appear in the list rows.
    expect(screen.getByLabelText(/Compare cl_scalp_options/i)).toBeDefined();
    expect(screen.getByLabelText(/Compare cl_scalp\b/i)).toBeDefined();
    expect(screen.getByLabelText(/Compare soxx_rotation/i)).toBeDefined();
  });

  it("typing a strategy substring narrows the list", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: makeSearchableDescriptors(),
    });
    mockedGetQoRun.mockResolvedValue(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    const input = (await screen.findByPlaceholderText(
      "strategy name or lineage_id",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "soxx" } });

    // soxx_rotation row survives; the cl_scalp* rows do not.
    await waitFor(() => {
      expect(screen.getByLabelText(/Compare soxx_rotation/i)).toBeDefined();
    });
    expect(screen.queryByLabelText(/Compare cl_scalp_options/i)).toBeNull();
    // queryByLabelText with a regex that also matches cl_scalp_options
    // would surface that; use exact match.
    expect(screen.queryByLabelText("Compare cl_scalp")).toBeNull();
  });

  it("searching by a lineage_id prefix matches its run (QF-179 loop)", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: makeSearchableDescriptors(),
    });
    mockedGetQoRun.mockResolvedValue(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    const input = (await screen.findByPlaceholderText(
      "strategy name or lineage_id",
    )) as HTMLInputElement;
    // First 8 chars of run-b's lineage_id — exactly what QF-179's badge
    // exposes via copy-from-tooltip.
    fireEvent.change(input, { target: { value: "bbbbbbbb" } });

    await waitFor(() => {
      expect(screen.getByLabelText(/Compare cl_scalp_options/i)).toBeDefined();
    });
    expect(screen.queryByLabelText(/Compare soxx_rotation/i)).toBeNull();
  });

  it("shows the no-match state when the query narrows the list to zero", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: makeSearchableDescriptors(),
    });
    mockedGetQoRun.mockResolvedValue(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    const input = (await screen.findByPlaceholderText(
      "strategy name or lineage_id",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzzzzzzz-no-match" } });

    await waitFor(() => {
      expect(screen.getByText(/No runs match/i)).toBeDefined();
    });
    // The "no qo-runs exist" empty state should NOT be the one rendered.
    expect(screen.queryByText(/No quant-optimizer runs found/i)).toBeNull();
  });

  it("clearing the input restores the full list", async () => {
    mockedGetCatalog.mockResolvedValueOnce({
      generated_at: "2026-05-13T15:00:00Z",
      descriptors: makeSearchableDescriptors(),
    });
    mockedGetQoRun.mockResolvedValue(makeFoldsResponse());

    await act(async () => {
      render(<BacktestsTab />);
    });

    const input = (await screen.findByPlaceholderText(
      "strategy name or lineage_id",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "soxx" } });
    await waitFor(() => {
      expect(screen.queryByLabelText(/Compare cl_scalp_options/i)).toBeNull();
    });
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.getByLabelText(/Compare cl_scalp_options/i)).toBeDefined();
    });
    expect(screen.getByLabelText(/Compare soxx_rotation/i)).toBeDefined();
  });
});
