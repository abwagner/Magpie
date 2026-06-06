// ── Portfolio & Risk Types ──────────────────────────────────────────
// Defined in: docs/tdd/portfolio-risk-engine.md

export interface Position {
  position_id: string;
  symbol: string;
  underlying: string;
  direction: "Long" | "Short";
  quantity: number;
  entry_price: number;
  entry_date: string;
  expiration?: string;
  current_price: number;
  unrealized_pnl: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv?: number;
  // ── QF-321 — exit-rule monitor enrichment ─────────────────────────
  // Nullable: populated by the canonical projector's strategy-
  // attribution path. Positions without a strategy_id have no
  // framework-enforced exits (only operator manual liquidation closes
  // them). composite_id groups multi-leg structures (null = atomic).
  strategy_id?: string;
  composite_id?: string | null;
  // Set by the exit-rule monitor when a closing intent is in-flight so
  // the next eval pass doesn't double-emit (idempotency guard, per
  // docs/tdd/exit-rule-monitor.md §6). Stays unset if OPL rejects the
  // close, so a later tick re-emits.
  closing_intent_id?: string | null;
}

// ── QF-321 — position-update event ──────────────────────────────────
// Emitted by the portfolio engine after every recompute (per-fill +
// per-quote-tick). The exit-rule monitor subscribes and evaluates
// active rules against `positions` (live projector refs — the monitor
// sets closing_intent_id on a row in place).
export interface PositionUpdate {
  portfolio: string;
  positions: Position[];
  asof: string;
}

export interface PortfolioState {
  portfolio_id: string;
  cash: number;
  positions: Position[];
  net_delta: number;
  net_vega: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  daily_realized_pnl: number;
  equity: number;
  peak_equity: number;
  drawdown: number;
  halted: boolean;
  halt_reason?: string;
  data_stale: boolean;
}

export interface RiskLimits {
  max_net_delta: number | null;
  max_net_vega: number | null;
  max_daily_loss: number | null;
  max_symbol_concentration: number | null;
  max_drawdown: number | null;
  max_order_size: number | null;
  max_open_orders: number | null;
}

export interface PortfolioConfig {
  mode: string;
  broker: string;
  initial_cash: number;
  limits: RiskLimits;
  strategies: Record<string, StrategyConfig>;
  semi_auto_whitelist?: SemiAutoWhitelist;
  reconciliation: ReconciliationConfig;
  approval_timeout_seconds: number;
}

export interface StrategyConfig {
  module: string;
  config: Record<string, unknown>;
  signal_interests: string[];
  signal_staleness_seconds: number;
}

export interface SemiAutoWhitelist {
  symbols: string[];
  max_qty: number;
  strategy_ids: string[];
}

export interface ReconciliationConfig {
  interval_seconds: number;
  halt_on_drift: boolean;
}

export interface PortfolioSnapshot {
  portfolio: string;
  snapshot_ts: string;
  trigger: string;
  cash: number;
  equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  daily_realized: number;
  net_delta: number;
  net_vega: number;
  drawdown: number;
  peak_equity: number;
  positions_count: number;
  halted: boolean;
  data_stale: boolean;
}

export interface ReconciliationResult {
  match: boolean;
  drifts: DriftRecord[];
}

export interface DriftRecord {
  type: "quantity_mismatch" | "missing_internally" | "missing_at_broker";
  symbol: string;
  internal_qty: number;
  broker_qty: number;
}
