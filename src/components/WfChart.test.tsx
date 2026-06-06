// Smoke + render coverage for the inline SVG chart.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { formatMetric, WfChart, type FoldRow } from "./WfChart.js";

afterEach(cleanup);

function makeFolds(): FoldRow[] {
  return [
    {
      fold_id: 0,
      is_metric: 16752,
      oos: { net_pnl: 6614, sortino: 1.225, hit_rate: 0.571, max_dd: 3196 },
    },
    {
      fold_id: 1,
      is_metric: 1072,
      oos: { net_pnl: 2100, sortino: 0.8, hit_rate: 0.5, max_dd: 1500 },
    },
    {
      fold_id: 2,
      is_metric: 9000,
      oos: { net_pnl: -300, sortino: -0.4, hit_rate: 0.4, max_dd: 800 },
    },
  ];
}

describe("formatMetric", () => {
  it("formats hit_rate as a percentage", () => {
    expect(formatMetric(0.571, "hit_rate")).toBe("57%");
  });
  it("formats sortino to 2 decimals", () => {
    expect(formatMetric(1.234, "sortino")).toBe("1.23");
  });
  it("formats net_pnl as integer", () => {
    expect(formatMetric(6614.78, "net_pnl")).toBe("6615");
  });
  it("formats max_dd as integer", () => {
    expect(formatMetric(1500.4, "max_dd")).toBe("1500");
  });
});

describe("WfChart", () => {
  it("renders an SVG with the configured width/height", () => {
    const { container } = render(<WfChart folds={makeFolds()} metric="net_pnl" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("width")).toBe("480");
    expect(svg!.getAttribute("height")).toBe("200");
  });

  it("draws both IS and OOS paths when both have data", () => {
    const { container } = render(<WfChart folds={makeFolds()} metric="net_pnl" />);
    const paths = container.querySelectorAll("path");
    // Two stroked paths (one per series), no fills.
    expect(paths.length).toBe(2);
    for (const p of paths) {
      expect(p.getAttribute("fill")).toBe("none");
      expect(p.getAttribute("d")).toMatch(/^M\d/);
    }
  });

  it("draws a point per fold per series (6 dots for 3 folds × 2 series)", () => {
    const { container } = render(<WfChart folds={makeFolds()} metric="net_pnl" />);
    const dots = container.querySelectorAll("circle[r='2.5']");
    expect(dots.length).toBe(6);
  });

  it("renders fold-id labels on the x-axis", () => {
    const { container } = render(<WfChart folds={makeFolds()} metric="net_pnl" />);
    const labels = Array.from(container.querySelectorAll("text"))
      .map((t) => t.textContent)
      .filter((s) => s != null && /^f\d+$/.test(s));
    expect(labels).toEqual(["f0", "f1", "f2"]);
  });

  it("shows OOS legend text matching the selected metric", () => {
    const { container } = render(<WfChart folds={makeFolds()} metric="sortino" />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("OOS sortino");
  });

  it("renders 'No data' for empty folds", () => {
    const { getByText } = render(<WfChart folds={[]} metric="net_pnl" />);
    expect(getByText("No data")).toBeDefined();
  });

  it("breaks the path at null OOS values (no fake interpolation)", () => {
    const folds: FoldRow[] = [
      { fold_id: 0, is_metric: 100, oos: { net_pnl: 200 } },
      { fold_id: 1, is_metric: 110, oos: undefined }, // missing OOS panel
      { fold_id: 2, is_metric: 105, oos: { net_pnl: 250 } },
    ];
    const { container } = render(<WfChart folds={folds} metric="net_pnl" />);
    const paths = container.querySelectorAll("path");
    // OOS path is the second one (after the IS path, in render order).
    const oosD = paths[1]!.getAttribute("d") ?? "";
    // Two move commands → one continuous-then-broken-then-resumed segment.
    expect((oosD.match(/M/g) ?? []).length).toBe(2);
  });

  it("renders the optional title above the chart", () => {
    const { getByText } = render(<WfChart folds={makeFolds()} metric="net_pnl" title="cl_scalp" />);
    expect(getByText("cl_scalp")).toBeDefined();
  });
});
