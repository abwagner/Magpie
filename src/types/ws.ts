// ── State WebSocket types ─────────────────────────────────────────
// Frontend mirror of the server-side messages emitted by
// server/ws-state.ts and the snapshot the upgrade handler sends in
// server/index.js (the `snapshot` is composed inline at upgrade
// time, not by ws-state.ts itself).
//
// Snapshot portfolios carry the full PortfolioState (with positions);
// portfolio_update events deliver scalar overlays — typed as a
// Partial<PortfolioState> so any of those fields can be patched
// without changing the positions array.

import type { PortfolioState, RiskLimits } from "./portfolio.js";
import type { Order, Fill } from "./order.js";
import type { Strategy } from "./strategy.js";

export interface RiskLimitsConfig {
  version: 1;
  portfolios: Record<string, RiskLimits>;
}

// QF-346 — server-persisted drag-resized panel track sizes per
// workspace. Only the CSS-grid track strings are stored; the template
// areas + panel mapping stay in src/workspaces/index.ts.
export interface WorkspaceLayoutOverride {
  rows: string;
  cols: string;
}

export interface WorkspaceLayoutsConfig {
  version: 1;
  layouts: Record<string, WorkspaceLayoutOverride>;
}

// ── System state ──────────────────────────────────────────────────

export interface SchwabTokenStatus {
  available: boolean;
  refresh_token_expires_in_s?: number | null;
}

export type AppEnvValue = "dev" | "staging" | "prod";
export type TradingModeValue = "paper" | "live";
// QF-263 — narrowed to the two surviving Order Plane modes (operator
// manual entry + the paper_local fill simulator). Mirrors ExecutionMode
// in src/types/order.ts.
export type ExecutionModeValue = "paper_local" | "manual";

export interface SystemBlock {
  app_env?: AppEnvValue;
  trading_mode?: TradingModeValue;
  execution_mode?: ExecutionModeValue;
  halted: boolean;
  halt_reason?: string | null;
  nats_connected?: boolean;
  sources_available?: string[];
  schwab_token?: SchwabTokenStatus;
}

export interface OrdersBlock {
  pending?: Order[];
  recent?: Order[];
}

export interface FillsBlock {
  recent?: Fill[];
}

export interface SystemState {
  type: "snapshot";
  system: SystemBlock;
  portfolios?: Record<string, PortfolioState>;
  orders?: OrdersBlock;
  fills?: FillsBlock;
  models?: unknown[];
  strategies?: Strategy[];
  risk_limits?: RiskLimitsConfig;
  workspace_layouts?: WorkspaceLayoutsConfig;
}

// ── Server → client messages ──────────────────────────────────────

export interface SnapshotMsg extends SystemState {
  type: "snapshot";
}

export interface PortfolioUpdateMsg {
  type: "portfolio_update";
  portfolio: string;
  data: Partial<PortfolioState>;
}

export interface OrderUpdateMsg {
  type: "order_update";
  data: Order;
}

export interface FillMsg {
  type: "fill";
  data: Fill;
}

export interface SystemHaltMsg {
  type: "system_halt";
  halted?: boolean;
  reason?: string;
}

// QF-228 — widened to carry the full AlertEvent payload so the GUI
// can render quote-unavailable banners (symbol, reason, detail) without
// inventing data. ts + level + payload are optional so existing callers
// emitting only {type, message} stay valid; new callers (alertRouter's
// internal sink) supply the full shape.
export interface AlertMsg {
  type: "alert";
  data: {
    type: string;
    message: string;
    level?: "info" | "warning" | "critical";
    ts?: string;
    payload?: Record<string, unknown>;
  };
}

export interface StrategyUpdateMsg {
  type: "strategy_update";
  data: Strategy;
}

export interface RiskLimitsMsg {
  type: "risk_limits";
  data: RiskLimitsConfig;
}

// QF-346 — pushed after any device writes a drag-resized layout so the
// other connected devices re-flow their grid live (multi-device sync).
export interface WorkspaceLayoutMsg {
  type: "workspace_layout";
  data: WorkspaceLayoutsConfig;
}

// QF-351 — emitted when an exit-rule trips on a position; drives the
// in-flight closing banner so the operator can distinguish a rule-driven
// close from a manual one. closing_intent_id is the OPL intent the
// monitor submitted.
export interface PositionExitRuleMsg {
  type: "position_exit_rule";
  data: {
    position_id: string;
    rule: "stop_loss" | "target" | "max_hold" | "max_drawdown";
    closing_intent_id: string;
    strategy_id: string;
  };
}

export type WsMessage =
  | SnapshotMsg
  | PortfolioUpdateMsg
  | OrderUpdateMsg
  | FillMsg
  | SystemHaltMsg
  | AlertMsg
  | StrategyUpdateMsg
  | RiskLimitsMsg
  | WorkspaceLayoutMsg
  | PositionExitRuleMsg;
