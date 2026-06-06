// A workspace is pure data: a CSS-grid template + an array of cells
// pointing at panel ids. Panel ids are looked up in PANEL_REGISTRY,
// so workspaces can swap panels by changing this data alone.
//
// `subtitle` is shown under the tab label in the optional toolbar
// row; today the shell does not render it, but the field is kept on
// the type for Phase 1 spec parity with the design.

import type { PanelId } from "../panels/registry.js";
import type { WorkspaceId } from "../state/ui-store.js";

export interface WorkspaceCell {
  panel: PanelId;
  area: string;
}

export interface WorkspaceTemplate {
  rows: string;
  cols: string;
  areas: string;
  cells: WorkspaceCell[];
}

export interface WorkspaceDef {
  id: WorkspaceId;
  label: string;
  subtitle?: string;
  template?: WorkspaceTemplate;
}
