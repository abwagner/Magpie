import type { CSSProperties } from "react";
import { PANEL_REGISTRY } from "../panels/registry.js";
import type { WorkspaceDef } from "../workspaces/types.js";

export interface WorkspaceGridProps {
  workspace: WorkspaceDef;
}

export function WorkspaceGrid({ workspace }: WorkspaceGridProps) {
  const t = workspace.template;
  if (!t) {
    return (
      <div style={{ padding: 24, color: "var(--text-3)", fontSize: 12 }}>
        No template defined for workspace <code>{workspace.id}</code> — this workspace renders a
        full screen (lands in a later phase).
      </div>
    );
  }

  const style: CSSProperties = {
    gridTemplateRows: t.rows,
    gridTemplateColumns: t.cols,
    gridTemplateAreas: t.areas,
  };

  return (
    <section className="ws-canvas" style={style} aria-label={`workspace ${workspace.label}`}>
      {t.cells.map((cell, i) => {
        const Comp = PANEL_REGISTRY[cell.panel];
        return (
          <div key={`${cell.area}-${i}`} style={{ gridArea: cell.area, minWidth: 0, minHeight: 0 }}>
            <Comp />
          </div>
        );
      })}
    </section>
  );
}
