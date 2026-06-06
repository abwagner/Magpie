// Static panel registry. Phase 1 wires the Operate panels; the
// other workspaces ship their panels in Phases 2–4. Unimplemented
// panel ids render a placeholder noting which phase delivers them.

import type { ComponentType } from "react";
import { RiskHeadroomPanel } from "./RiskHeadroomPanel.js";
import { PositionsPanel } from "./PositionsPanel.js";
import { ApprovalsPanel } from "./ApprovalsPanel.js";
import { PnlMicrochartPanel } from "./PnlMicrochartPanel.js";
import { ReconPanel } from "./ReconPanel.js";
import { ComingSoonPanel } from "./ComingSoonPanel.js";
import { InspectorPanel } from "./InspectorPanel.js";
import { RecentFillsPanel } from "./RecentFillsPanel.js";
import { ActiveOrdersPanel } from "./ActiveOrdersPanel.js";
import { ChainPanel } from "./ChainPanel.js";
import { PayoffPanel } from "./PayoffPanel.js";
import { BrokerPositionsPanel } from "./BrokerPositionsPanel.js";
import { JobQueuePanel } from "./JobQueuePanel.js";
import { GridHeatmapPanel } from "./GridHeatmapPanel.js";
import { WalkForwardPanel } from "./WalkForwardPanel.js";
import { ComparisonPanel } from "./ComparisonPanel.js";

export type PanelId =
  | "risk"
  | "positions"
  | "broker-positions"
  | "approvals"
  | "pnl"
  | "recon"
  | "inspector"
  | "fills"
  | "active-orders"
  | "chain"
  | "payoff"
  | "pos-context"
  | "job-queue"
  | "grid-heatmap"
  | "walk-forward"
  | "comparison";

export const PANEL_REGISTRY: Record<PanelId, ComponentType> = {
  // Operate (Phase 1)
  risk: RiskHeadroomPanel,
  positions: PositionsPanel,
  "broker-positions": BrokerPositionsPanel,
  approvals: ApprovalsPanel,
  pnl: PnlMicrochartPanel,
  recon: ReconPanel,

  // Investigate (Phase 2a)
  inspector: InspectorPanel,
  fills: RecentFillsPanel,
  "active-orders": ActiveOrdersPanel,

  // Build (Phase 2b) — Greek Builder UI lives inside ChainPicker (in ChainPanel).
  chain: ChainPanel,
  payoff: PayoffPanel,
  "pos-context": PositionsPanel,

  // Research (Phase 2 — QF-112). Scaffolds wired to the orchestrator
  // HTTP + WS surface; Phase 3 fills them with real visualizations.
  "job-queue": JobQueuePanel,
  "grid-heatmap": GridHeatmapPanel,
  "walk-forward": WalkForwardPanel,
  comparison: ComparisonPanel,
};

function ComingSoon(label: string, phase: number): ComponentType {
  const Comp = () => <ComingSoonPanel label={label} phase={phase} />;
  Comp.displayName = `ComingSoon(${label})`;
  return Comp;
}
