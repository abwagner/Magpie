// ── Exit-rule display helpers (QF-322) ─────────────────────────────
// Shared formatting for the exit-rule GUI surfaces: the per-strategy
// panel in StrategiesScreen and the in-flight closing banner in Shell.
// Pure functions only — keeps the rendering components testable and the
// rule vocabulary in one place.

import type { ExitRuleHeadroom } from "../types/strategy.js";

export type ExitRuleName = ExitRuleHeadroom["rule"];

// Operator-facing label for each rule. The wire uses snake_case ids;
// the GUI shows these.
const RULE_LABELS: Record<ExitRuleName, string> = {
  stop_loss: "Stop loss",
  target: "Target",
  max_hold: "Max hold",
  max_drawdown: "Max drawdown",
};

export function exitRuleLabel(rule: ExitRuleName): string {
  return RULE_LABELS[rule];
}

// True for rules whose threshold/actual are fractions of notional and so
// render as percentages; max_hold is a duration in seconds instead.
function isPctRule(rule: ExitRuleName): boolean {
  return rule !== "max_hold";
}

// Format a rule's threshold/actual for the panel, e.g. "-3.2% / -5.0%"
// for stop_loss or "4h 12m / 6h 0m" for max_hold. Returns the actual
// first (current value) then the threshold (the limit).
export function formatExitRuleValues(ev: ExitRuleHeadroom): string {
  if (isPctRule(ev.rule)) {
    return `${formatPct(ev.actual)} / ${formatPct(ev.threshold)}`;
  }
  return `${formatDuration(ev.actual)} / ${formatDuration(ev.threshold)}`;
}

// Headroom phrase for the panel: "1.8% headroom" when armed, "tripped"
// when the rule has fired (headroom ≤ 0).
export function formatHeadroom(ev: ExitRuleHeadroom): string {
  if (ev.headroom_pct <= 0) return "tripped";
  return `${formatPct(ev.headroom_pct)} headroom`;
}

// A rule is "tripped" once headroom is at or below zero (mirrors the
// monitor's ExitRuleEvaluation.tripped semantics).
export function isTripped(ev: ExitRuleHeadroom): boolean {
  return ev.headroom_pct <= 0;
}

function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
