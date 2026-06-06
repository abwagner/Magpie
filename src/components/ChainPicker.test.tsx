// Tests for MarginDiscrepancyPanel — the §3.5.2 two-pass reconciliation
// surface in the Greek Builder UI.
//
// ChainPicker itself requires heavy API + Worker mocking; this file
// exercises only the exported MarginDiscrepancyPanel sub-component,
// which is a pure presentational function of its `totals` prop.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarginDiscrepancyPanel } from "./ChainPicker.js";
import type { MarginDiscrepancyPanelProps } from "./ChainPicker.js";

afterEach(cleanup);

function makeTotals(margin: number, perLegMargin?: number): MarginDiscrepancyPanelProps["totals"] {
  return {
    contracts: 2,
    margin,
    perLegMargin,
  };
}

describe("MarginDiscrepancyPanel", () => {
  it("shows per-leg and portfolio margin values", () => {
    render(<MarginDiscrepancyPanel totals={makeTotals(1000, 8200)} />);
    expect(screen.getByText(/Per-leg/i)).toBeTruthy();
    expect(screen.getByText(/Portfolio/i)).toBeTruthy();
    expect(screen.getByText(/\$8,200/)).toBeTruthy();
    expect(screen.getByText(/\$1,000/)).toBeTruthy();
  });

  it("shows freed capital when spread netting helped", () => {
    render(<MarginDiscrepancyPanel totals={makeTotals(1000, 8200)} />);
    // freed = 8200 - 1000 = 7200, well above the $100 threshold
    expect(screen.getByText(/freed/i)).toBeTruthy();
    expect(screen.getByText(/\$7,200/)).toBeTruthy();
    expect(screen.getByText(/spread netting/i)).toBeTruthy();
  });

  it("shows no-benefit message when discrepancy is below threshold", () => {
    // freed = 1050 - 1000 = 50, below $100 threshold
    render(<MarginDiscrepancyPanel totals={makeTotals(1000, 1050)} />);
    expect(screen.getByText(/no spread netting benefit/i)).toBeTruthy();
  });

  it("shows no-benefit message when per-leg margin equals portfolio margin", () => {
    render(<MarginDiscrepancyPanel totals={makeTotals(5000, 5000)} />);
    expect(screen.getByText(/no spread netting benefit/i)).toBeTruthy();
  });

  it("falls back gracefully when perLegMargin is absent (uses portfolio margin)", () => {
    // When perLegMargin is undefined, freed = portfolioMargin - portfolioMargin = 0
    render(<MarginDiscrepancyPanel totals={makeTotals(3000)} />);
    expect(screen.getByText(/no spread netting benefit/i)).toBeTruthy();
    // Both per-leg and portfolio should display the same value
    const matches = screen.getAllByText(/\$3,000/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("correctly computes freed capital for iron-condor-like scenario", () => {
    // 4-leg iron condor: per-leg naked margins ~$8,200; portfolio spread margin ~$1,000
    render(<MarginDiscrepancyPanel totals={makeTotals(1000, 8200)} />);
    expect(screen.getByText(/\$7,200/)).toBeTruthy();
  });

  it("formats large freed capital with thousands separators", () => {
    render(<MarginDiscrepancyPanel totals={makeTotals(500, 15000)} />);
    expect(screen.getByText(/\$14,500/)).toBeTruthy();
  });
});
