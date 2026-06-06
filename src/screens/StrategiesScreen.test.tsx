// Focused tests for the LineageBadge subcomponent (QF-179).
// The wider StrategiesScreen pulls in WebSocket state, so we test
// the new piece in isolation via its named export.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LineageBadge } from "./StrategiesScreen.js";
import type { ParamsProvenance } from "../types/strategy.js";

afterEach(cleanup);

const VALID_PROV: ParamsProvenance = {
  lineage_id: "11111111-2222-3333-4444-555555555555",
  selected_params: { stop_loss_dollars: 1700, bullish_threshold: 80 },
  selector_rule: "last_fold",
  selected_at: "2026-05-13T16:00:00Z",
};

describe("LineageBadge", () => {
  it("renders nothing when provenance is undefined", () => {
    const { container } = render(<LineageBadge provenance={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the short lineage_id when provenance is present", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    // First 8 chars of the UUID.
    expect(screen.getByText("11111111")).toBeDefined();
  });

  it("surfaces the full lineage_id + selector_rule + selected_at via tooltip", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    const chip = screen.getByLabelText(/Params provenance lineage/i);
    const tooltip = chip.getAttribute("title") ?? "";
    expect(tooltip).toContain(VALID_PROV.lineage_id);
    expect(tooltip).toContain("last_fold");
    expect(tooltip).toContain("2026-05-13T16:00:00Z");
  });

  it("renders selector_rule + selected_at inline alongside the chip", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    expect(screen.getByText("last_fold")).toBeDefined();
    expect(screen.getByText(/2026-05-13T16:00:00Z/)).toBeDefined();
  });

  it("toggles the params JSON expander on button click", () => {
    render(<LineageBadge provenance={VALID_PROV} />);
    const toggle = screen.getByRole("button", { name: /Show params/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Pre-click: JSON expander absent.
    expect(screen.queryByText(/stop_loss_dollars/)).toBeNull();

    fireEvent.click(toggle);

    // Post-click: aria-expanded flips + JSON content visible.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/stop_loss_dollars/)).toBeDefined();
    expect(screen.getByText(/1700/)).toBeDefined();
    expect(screen.getByText(/Hide params/i)).toBeDefined();
  });

  it("renders an empty selected_params expander without throwing", () => {
    const empty: ParamsProvenance = { ...VALID_PROV, selected_params: {} };
    render(<LineageBadge provenance={empty} />);
    fireEvent.click(screen.getByRole("button", { name: /Show params/i }));
    // Pre / textContent should be "{}", trimmed.
    const pre = document.getElementById("lineage-params-json");
    expect(pre).not.toBeNull();
    expect(pre!.textContent?.trim()).toBe("{}");
  });
});
