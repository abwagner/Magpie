import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { WorkspaceGrid } from "./WorkspaceGrid.js";
import { StateContext } from "../state/StateProvider.js";
import type { WorkspaceDef } from "../workspaces/types.js";
import type { ReactNode } from "react";

function withState(node: ReactNode) {
  return (
    <StateContext.Provider
      value={{
        state: null,
        connected: true,
        reconnecting: false,
        outstandingQuoteAlerts: new Map(),
      }}
    >
      {node}
    </StateContext.Provider>
  );
}

// Minimal smoke: renders cells from the workspace data, swaps body
// when the workspace prop changes. The actual panel components run
// inside the registry; we only assert the grid plumbing here.

const ONE_CELL: WorkspaceDef = {
  id: "operate",
  label: "Operate",
  template: {
    rows: "1fr",
    cols: "1fr",
    areas: '"recon"',
    cells: [{ panel: "recon", area: "recon" }],
  },
};

const TWO_CELLS: WorkspaceDef = {
  id: "investigate",
  label: "Investigate",
  template: {
    rows: "1fr",
    cols: "1fr 1fr",
    areas: '"fills orders"',
    cells: [
      { panel: "fills", area: "fills" },
      { panel: "active-orders", area: "orders" },
    ],
  },
};

describe("WorkspaceGrid", () => {
  it("renders one panel slot per cell", () => {
    const { container, rerender } = render(withState(<WorkspaceGrid workspace={ONE_CELL} />));
    const canvas = container.querySelector(".ws-canvas") as HTMLElement | null;
    expect(canvas).not.toBeNull();
    expect(canvas?.style.gridTemplateAreas).toContain("recon");
    expect(canvas?.children.length).toBe(1);

    rerender(withState(<WorkspaceGrid workspace={TWO_CELLS} />));
    const next = container.querySelector(".ws-canvas") as HTMLElement | null;
    expect(next?.children.length).toBe(2);
    expect(next?.style.gridTemplateAreas).toContain("fills");
  });

  it("falls back to a notice when the workspace has no template", () => {
    const empty: WorkspaceDef = {
      id: "strategies",
      label: "Strategies",
    };
    const { container } = render(withState(<WorkspaceGrid workspace={empty} />));
    expect(container.textContent).toContain("No template defined");
  });
});
