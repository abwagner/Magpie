// ── Strategy lifecycle (frontend mirror) ──────────────────────────
// Mirrors server/strategy/lifecycle.ts. Snapshot returns the full
// list; `strategy_update` WS messages carry one Strategy at a time.

// ── StrategyAction (canonical, used by runner + compat layer) ─────

export interface StrategyAction {
  action: "open" | "close";
  symbol?: string;
  strike?: number;
  type?: string;
  direction?: string;
  qty?: number;
  expiration?: string;
  position_id?: string;
  reason?: string;
}

export type LifecycleState = "registered" | "enabled" | "running" | "paused" | "halted" | "retired";

export type LifecycleAction =
  | "enable"
  | "disable"
  | "start"
  | "pause"
  | "resume"
  | "halt"
  | "reenable"
  | "retire"
  | "reregister";

export interface TransitionEvent {
  from: LifecycleState;
  to: LifecycleState;
  action: LifecycleAction;
  ts: string;
  actor: string;
  reason?: string;
}

// ParamsProvenance records which quant-optimizer run validated the
// parameters this strategy is deployed with. Mirrors the server-side
// shape in server/strategy/lifecycle.ts.
export interface ParamsProvenance {
  lineage_id: string; // UUID from wfo_results JSON; resolves to a qo-run descriptor in /api/catalog
  selected_params: Record<string, unknown>;
  selector_rule: string; // "last_fold" | "median_oos" | "manual" | etc.
  selected_at: string; // ISO 8601
}

// ── QF-351 — exit-rule headroom, streamed on strategy_update ─────────
// Per-armed-rule evaluation snapshot derived from the exit-rule monitor
// (QF-321). Streamed via strategy_update.data.exit_rules[]. A value of
// headroom_pct ≤ 0 means the rule is tripped (or at threshold).
export interface ExitRuleHeadroom {
  rule: "stop_loss" | "target" | "max_hold" | "max_drawdown";
  threshold: number;
  actual: number;
  // (threshold - actual) / |threshold|, mirrors ExitRuleEvaluation.
  headroom_pct: number;
}

export interface Strategy {
  id: string;
  label: string;
  state: LifecycleState;
  manifest_revision?: string | null;
  operator_notes?: string;
  registered_at: string;
  updated_at: string;
  history: TransitionEvent[];
  params_provenance?: ParamsProvenance;
  // QF-351 — per-armed-rule headroom, pushed after each eval pass.
  // Absent until the first eval completes; undefined = no policy or no
  // eval yet (GUI should render as "–" rather than "0").
  exit_rules?: ExitRuleHeadroom[];
}
