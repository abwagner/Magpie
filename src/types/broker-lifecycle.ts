// ── Broker Lifecycle Events ────────────────────────────────────────
// Option lifecycle events pushed by NT broker bridges (assignment,
// exercise, expiry). Consumed by the audit observer to mutate positions.
// Defined in: docs/tdd/portfolio-risk-engine.md §11.3

export interface BrokerLifecycleEvent {
  broker: "schwab" | "ibkr";
  event: "option_assigned" | "option_exercised" | "option_expired";
  position_symbol: string; // OPT:SPY:2026-05-16:C:500
  // Settlement details:
  underlying_symbol: string; // SPY
  side: "buy" | "sell"; // direction of the resulting underlying position
  quantity: number; // contracts × multiplier (typically × 100)
  settlement_price: number; // strike for assignment; market for cash-settled
  settlement_type: "physical" | "cash";
  asof: string; // broker's reported event time (ISO-8601)
  // Cross-references:
  broker_position_id: string | null;
}
