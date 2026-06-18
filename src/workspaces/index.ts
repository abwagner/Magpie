// Workspace definitions — ports docs/design_handoff_magpie/workspaces.jsx
// to typed data. Phase 1 wires Operate; the other workspaces hold
// their panel ids and grid templates so the grid renders the same
// shapes with ComingSoon panels as fillers.
//
// Strategies + Settings have full screens (not panel grids), so
// their template is `undefined` and the shell renders the screen
// component directly.

import type { WorkspaceDef } from "./types.js";

export const WORKSPACES: WorkspaceDef[] = [
  {
    id: "operate",
    label: "Operate",
    subtitle: "Daily-driver. Risk · Positions · Approvals · P&L",
    template: {
      rows: "210px 1fr 200px",
      cols: "320px 1fr 1fr 360px",
      areas: `
        "risk    pos    pos    approvals"
        "risk    pos    pos    approvals"
        "pnl     recon  recon  approvals"
      `,
      cells: [
        { panel: "risk", area: "risk" },
        { panel: "broker-positions", area: "pos" },
        { panel: "approvals", area: "approvals" },
        { panel: "pnl", area: "pnl" },
        { panel: "recon", area: "recon" },
      ],
    },
  },
  {
    id: "investigate",
    label: "Investigate",
    subtitle: "Post-hoc analysis. Trade Inspector · Recent fills · Active orders",
    template: {
      rows: "1fr 220px",
      cols: "1fr 1fr",
      areas: `
        "inspector inspector"
        "fills     orders"
      `,
      cells: [
        { panel: "inspector", area: "inspector" },
        { panel: "fills", area: "fills" },
        { panel: "active-orders", area: "orders" },
      ],
    },
  },
  {
    id: "build",
    label: "Build",
    subtitle: "Manual staging. Chain (Greek Builder) · Strategy Builder · Payoff · Positions",
    template: {
      rows: "1fr 1fr 200px",
      cols: "1.4fr 1fr",
      areas: `
        "chain    strategy"
        "chain    payoff"
        "pos2     pos2"
      `,
      cells: [
        { panel: "chain", area: "chain" },
        { panel: "strategy-builder", area: "strategy" },
        { panel: "payoff", area: "payoff" },
        { panel: "pos-context", area: "pos2" },
      ],
    },
  },
  {
    id: "strategies",
    label: "Strategies",
    subtitle: "Registry · lifecycle · per-strategy P&L · manifest",
    // No template — Strategies is a full screen (Phase 3).
  },
  {
    id: "research",
    label: "Research",
    subtitle: "Backtest jobs · grids · walk-forward · comparison (QF-112)",
    template: {
      rows: "1fr 1fr",
      cols: "1.2fr 1fr",
      areas: `
        "queue   heatmap"
        "wf      compare"
      `,
      cells: [
        { panel: "job-queue", area: "queue" },
        { panel: "grid-heatmap", area: "heatmap" },
        { panel: "walk-forward", area: "wf" },
        { panel: "comparison", area: "compare" },
      ],
    },
  },
  {
    id: "settings",
    label: "Settings",
    subtitle: "Risk · Data · Models · System · Activity",
    // No template — Settings is a full screen (Phase 4).
  },
];

export function getWorkspace(id: string): WorkspaceDef | undefined {
  return WORKSPACES.find((w) => w.id === id);
}
