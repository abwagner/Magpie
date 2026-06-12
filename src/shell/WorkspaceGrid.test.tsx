import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { WorkspaceGrid } from "./WorkspaceGrid.js";
import { StateContext, type StateContextValue } from "../state/StateProvider.js";
import type { WorkspaceDef } from "../workspaces/types.js";
import type { WorkspaceLayoutsConfig } from "../types/ws.js";
import type { ReactNode } from "react";
import * as api from "../lib/api.js";

let setLayoutSpy: ReturnType<typeof vi.spyOn>;

function withState(node: ReactNode, layouts: StateContextValue["state"] = null) {
  return (
    <StateContext.Provider
      value={{
        state: layouts,
        connected: true,
        reconnecting: false,
        outstandingQuoteAlerts: new Map(),
        exitRuleTrips: [],
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

// A 2×2 grid so a single render exposes both a row handle and a col
// handle — needed to exercise cross-axis resize/persist coherence.
const GRID_2x2: WorkspaceDef = {
  id: "operate",
  label: "Operate",
  template: {
    rows: "200px 200px",
    cols: "300px 300px",
    areas: '"a b" "c d"',
    cells: [
      { panel: "recon", area: "a" },
      { panel: "fills", area: "b" },
      { panel: "active-orders", area: "c" },
      { panel: "recon", area: "d" },
    ],
  },
};

// Build a SystemState carrying a workspace_layouts snapshot. Only the
// fields WorkspaceGrid reads matter; the rest of SystemState is unused
// here so a narrow cast keeps the fixture small.
function stateWithLayouts(layouts: WorkspaceLayoutsConfig): StateContextValue["state"] {
  return { workspace_layouts: layouts } as StateContextValue["state"];
}

// jsdom does not implement pointer capture or resolve grid tracks to
// px. Polyfill capture as a no-op and resolve every track to a fixed
// px size (px tokens kept verbatim, fr/other → 400px) so measureTracks
// gets the px values it expects.
function installDomStubs() {
  const proto = HTMLElement.prototype as unknown as {
    setPointerCapture: (id: number) => void;
    releasePointerCapture: (id: number) => void;
    hasPointerCapture: (id: number) => boolean;
  };
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.hasPointerCapture = () => true;

  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    const style = (el as HTMLElement).style;
    const toPx = (v: string) =>
      v
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => (/^\d+(?:\.\d+)?px$/.test(t) ? t : "400px"))
        .join(" ");
    return {
      gridTemplateRows: toPx(style.gridTemplateRows),
      gridTemplateColumns: toPx(style.gridTemplateColumns),
    } as CSSStyleDeclaration;
  });
}

describe("WorkspaceGrid", () => {
  beforeEach(() => {
    setLayoutSpy = vi.spyOn(api, "setWorkspaceLayout").mockResolvedValue({
      version: 1,
      layouts: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Count grid children that are panel slots (not resize handles).
  function panelSlots(canvas: HTMLElement | null): number {
    if (!canvas) return 0;
    return Array.from(canvas.children).filter((c) => !c.classList.contains("ws-resize")).length;
  }

  it("renders one panel slot per cell", () => {
    const { container, rerender } = render(withState(<WorkspaceGrid workspace={ONE_CELL} />));
    const canvas = container.querySelector(".ws-canvas") as HTMLElement | null;
    expect(canvas).not.toBeNull();
    expect(canvas?.style.gridTemplateAreas).toContain("recon");
    expect(panelSlots(canvas)).toBe(1);

    rerender(withState(<WorkspaceGrid workspace={TWO_CELLS} />));
    const next = container.querySelector(".ws-canvas") as HTMLElement | null;
    expect(panelSlots(next)).toBe(2);
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

  it("renders one resize handle per internal grid boundary", () => {
    // TWO_CELLS is 1 row × 2 cols → 0 row handles + 1 col handle.
    const { container } = render(withState(<WorkspaceGrid workspace={TWO_CELLS} />));
    expect(container.querySelectorAll(".ws-resize-col").length).toBe(1);
    expect(container.querySelectorAll(".ws-resize-row").length).toBe(0);
  });

  it("renders no handles for a single-track workspace", () => {
    const { container } = render(withState(<WorkspaceGrid workspace={ONE_CELL} />));
    expect(container.querySelectorAll(".ws-resize").length).toBe(0);
  });

  // ── Drag lifecycle ──────────────────────────────────────────────
  describe("resize handle drag lifecycle", () => {
    function drag(handle: Element, axis: "x" | "y", from: number, to: number) {
      const coord = (v: number) => (axis === "x" ? { clientX: v } : { clientY: v });
      fireEvent.pointerDown(handle, { pointerId: 1, ...coord(from) });
      fireEvent.pointerMove(handle, { pointerId: 1, ...coord(to) });
      fireEvent.pointerUp(handle, { pointerId: 1, ...coord(to) });
    }

    it("calls onResize during move (no persist) and persists once on pointer up", () => {
      installDomStubs();
      const { container } = render(withState(<WorkspaceGrid workspace={TWO_CELLS} />));
      const handle = container.querySelector(".ws-resize-col");
      expect(handle).not.toBeNull();
      const canvas = container.querySelector(".ws-canvas") as HTMLElement;

      fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(handle!, { pointerId: 1, clientX: 140 });
      // Mid-drag: the live track string updated but nothing persisted.
      expect(canvas.style.gridTemplateColumns).not.toBe("1fr 1fr");
      expect(setLayoutSpy).not.toHaveBeenCalled();

      fireEvent.pointerUp(handle!, { pointerId: 1, clientX: 140 });
      // Commit fires exactly one persist with the final tracks.
      expect(setLayoutSpy).toHaveBeenCalledTimes(1);
    });

    it("ignores stray move/up events without an active pointer capture", () => {
      installDomStubs();
      // Force hasPointerCapture to report no capture so the guards bail.
      (HTMLElement.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
        () => false;
      const { container } = render(withState(<WorkspaceGrid workspace={TWO_CELLS} />));
      const handle = container.querySelector(".ws-resize-col")!;

      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 140 });
      expect(setLayoutSpy).not.toHaveBeenCalled();
    });

    it("persists row and col resizes independently across axes", () => {
      installDomStubs();
      const { container } = render(withState(<WorkspaceGrid workspace={GRID_2x2} />));
      const rowHandle = container.querySelector(".ws-resize-row")!;
      const colHandle = container.querySelector(".ws-resize-col")!;

      // Drag the row boundary first: cols must stay at their base value.
      drag(rowHandle, "y", 100, 140);
      expect(setLayoutSpy).toHaveBeenCalledTimes(1);
      const firstCall = setLayoutSpy.mock.calls[0]!;
      expect(firstCall[1].cols).toBe("300px 300px");
      const rowsAfterRowDrag = firstCall[1].rows;
      expect(rowsAfterRowDrag).not.toBe("200px 200px");

      // Drag the col boundary next: rows must retain the just-applied
      // value (the col commit must not clobber the row state).
      drag(colHandle, "x", 100, 140);
      expect(setLayoutSpy).toHaveBeenCalledTimes(2);
      const secondCall = setLayoutSpy.mock.calls[1]!;
      expect(secondCall[1].rows).toBe(rowsAfterRowDrag);
      expect(secondCall[1].cols).not.toBe("300px 300px");
    });
  });

  // ── Legacy localStorage → server migration ──────────────────────
  describe("legacy layout migration", () => {
    const LEGACY_KEY = "qf-layout";
    afterEach(() => localStorage.clear());

    it("migrates a legacy layout to the server once the snapshot is in", () => {
      localStorage.setItem(
        LEGACY_KEY,
        JSON.stringify({ investigate: { rows: "1fr", cols: "1fr 1fr" } }),
      );
      // serverSynced (state != null) with no override → migration fires.
      render(
        withState(
          <WorkspaceGrid workspace={TWO_CELLS} />,
          stateWithLayouts({ version: 1, layouts: {} }),
        ),
      );
      expect(setLayoutSpy).toHaveBeenCalledWith("investigate", expect.anything());
    });

    it("does not migrate before the snapshot has arrived", () => {
      localStorage.setItem(
        LEGACY_KEY,
        JSON.stringify({ investigate: { rows: "1fr", cols: "1fr 1fr" } }),
      );
      render(withState(<WorkspaceGrid workspace={TWO_CELLS} />, null));
      expect(setLayoutSpy).not.toHaveBeenCalled();
    });

    it("does not migrate when the server already holds an override", () => {
      localStorage.setItem(
        LEGACY_KEY,
        JSON.stringify({ investigate: { rows: "1fr", cols: "1fr 1fr" } }),
      );
      render(
        withState(
          <WorkspaceGrid workspace={TWO_CELLS} />,
          stateWithLayouts({
            version: 1,
            layouts: { investigate: { rows: "1fr", cols: "1fr 1fr" } },
          }),
        ),
      );
      expect(setLayoutSpy).not.toHaveBeenCalled();
    });

    it("clears the legacy entry and does not re-migrate on re-render even if persist rejected", async () => {
      setLayoutSpy.mockRejectedValue(new Error("server down"));
      localStorage.setItem(
        LEGACY_KEY,
        JSON.stringify({ investigate: { rows: "1fr", cols: "1fr 1fr" } }),
      );
      const snapshot = stateWithLayouts({ version: 1, layouts: {} });
      const { rerender } = render(withState(<WorkspaceGrid workspace={TWO_CELLS} />, snapshot));
      expect(setLayoutSpy).toHaveBeenCalledTimes(1);
      // Idempotent cleanup: the legacy entry is gone even though persist
      // rejected, so a remount cannot clobber newer server state.
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();

      // Re-render with the same workspace + snapshot: the guard ref must
      // keep the effect from firing a second migration.
      rerender(withState(<WorkspaceGrid workspace={TWO_CELLS} />, snapshot));
      expect(setLayoutSpy).toHaveBeenCalledTimes(1);
    });
  });
});
