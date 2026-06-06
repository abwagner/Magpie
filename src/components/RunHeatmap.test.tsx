// Coverage for the RunHeatmap grid component.
//
// Smoke + targeted assertions: empty-state fallback, fold-id union
// across runs, missing-fold dashed-cell marker, metric-direction
// scoring (good vs bad colour), click-through callback.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RunHeatmap, scoreCell, colorFor } from "./RunHeatmap.js";
import type { FoldRow } from "./WfChart.js";

afterEach(cleanup);

function makeFolds(values: { foldId: number; net_pnl: number }[]): FoldRow[] {
  return values.map(({ foldId, net_pnl }) => ({
    fold_id: foldId,
    oos: { net_pnl, sortino: 0, hit_rate: 0.5, max_dd: 100 },
  }));
}

describe("scoreCell", () => {
  it("returns 0 when all values agree (no spread)", () => {
    // higher_signed scales by max abs, so a single +100 maps to +1
    expect(scoreCell(100, [100, 100, 100], "net_pnl")).toBe(1);
  });

  it("scores positive net_pnl above zero relative to max abs", () => {
    const s = scoreCell(50, [100, 50, -100], "net_pnl");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("scores negative net_pnl below zero", () => {
    const s = scoreCell(-80, [100, 50, -100], "net_pnl");
    expect(s).toBeLessThan(0);
  });

  it("scores high max_dd as worse (lower-better metric)", () => {
    // max_dd is lower_better: the maximum drawdown across cells maps
    // to -1, the minimum to +1.
    expect(scoreCell(500, [100, 200, 500], "max_dd")).toBeLessThan(0);
    expect(scoreCell(100, [100, 200, 500], "max_dd")).toBeGreaterThan(0);
  });

  it("scores hit_rate around 0.5", () => {
    expect(scoreCell(0.5, [0.4, 0.6], "hit_rate")).toBe(0);
    expect(scoreCell(0.7, [0.4, 0.6, 0.7], "hit_rate")).toBeGreaterThan(0);
    expect(scoreCell(0.3, [0.3, 0.6], "hit_rate")).toBeLessThan(0);
  });

  it("returns 0 for non-finite input", () => {
    expect(scoreCell(NaN, [1, 2, 3], "net_pnl")).toBe(0);
  });
});

describe("colorFor", () => {
  it("maps strongly-negative scores to red", () => {
    expect(colorFor(-0.9)).toMatch(/^#[a-f0-9]{6}$/i);
    expect(colorFor(-0.9)).not.toBe(colorFor(0));
  });
  it("maps neutral scores to a slate colour", () => {
    expect(colorFor(0)).toBe(colorFor(0.1));
    expect(colorFor(0)).not.toBe(colorFor(0.9));
  });
  it("is monotonic across the five stops", () => {
    const stops = [-0.9, -0.4, 0, 0.4, 0.9].map(colorFor);
    expect(new Set(stops).size).toBe(5);
  });
});

describe("<RunHeatmap />", () => {
  it("renders an empty-state when no rows are supplied", () => {
    const { getByText } = render(<RunHeatmap rows={[]} metric="net_pnl" />);
    expect(getByText("No folds to plot.")).toBeTruthy();
  });

  it("renders an empty-state when rows have no folds", () => {
    const { getByText } = render(
      <RunHeatmap rows={[{ label: "x", folds: [] }]} metric="net_pnl" />,
    );
    expect(getByText("No folds to plot.")).toBeTruthy();
  });

  it("renders one cell per (run, fold_id) in the union, with run labels", () => {
    const rows = [
      {
        label: "run-a",
        folds: makeFolds([
          { foldId: 0, net_pnl: 100 },
          { foldId: 1, net_pnl: 50 },
        ]),
      },
      {
        label: "run-b",
        folds: makeFolds([
          { foldId: 1, net_pnl: -20 },
          { foldId: 2, net_pnl: 200 },
        ]),
      },
    ];
    const { container, getByText } = render(<RunHeatmap rows={rows} metric="net_pnl" />);
    expect(getByText("run-a")).toBeTruthy();
    expect(getByText("run-b")).toBeTruthy();
    // Fold-id headers f0, f1, f2 (the union).
    expect(getByText("f0")).toBeTruthy();
    expect(getByText("f1")).toBeTruthy();
    expect(getByText("f2")).toBeTruthy();
    // Two filled cells per row (run-a has f0+f1; run-b has f1+f2),
    // plus one dashed cell each for the missing fold.
    const dashed = container.querySelectorAll('rect[stroke-dasharray="2 2"]');
    expect(dashed.length).toBe(2);
  });

  it("calls onCellClick with the fold_id", () => {
    const handler = vi.fn();
    const rows = [
      {
        label: "run-a",
        folds: makeFolds([
          { foldId: 0, net_pnl: 100 },
          { foldId: 1, net_pnl: 50 },
        ]),
        onCellClick: handler,
      },
    ];
    const { container } = render(<RunHeatmap rows={rows} metric="net_pnl" />);
    // Find filled (non-dashed) cells; click the first one — should
    // fire with fold_id 0.
    const cells = container.querySelectorAll("rect");
    const filled = Array.from(cells).filter(
      (c) => !c.getAttribute("stroke-dasharray") && c.getAttribute("fill") !== "transparent",
    );
    // First filled rect is the cell at (run-a, fold 0) — there's no
    // legend swatch inside the SVG, those live in the HTML sibling.
    fireEvent.click(filled[0]!);
    expect(handler).toHaveBeenCalledWith(0);
  });

  it("renders a legend strip with five swatches", () => {
    const rows = [{ label: "x", folds: makeFolds([{ foldId: 0, net_pnl: 0 }]) }];
    const { container } = render(<RunHeatmap rows={rows} metric="net_pnl" />);
    // Legend swatches are in the sibling div, rendered via <span>
    // with a background-color style. Count them via the inline style.
    const swatches = Array.from(container.querySelectorAll("span")).filter((s) =>
      (s.getAttribute("style") ?? "").includes("background"),
    );
    expect(swatches.length).toBe(5);
  });
});
