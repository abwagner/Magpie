// ── Test fixtures (non-signal) ─────────────────────────────────────
// Signal fixtures were retired with the Arch-A signal subsystem (QF-261).
// Only portfolio + timing helpers survive.

export function testPortfolioConfig() {
  return {
    mode: "paper_local" as const,
    broker: "paper",
    initial_cash: 100_000,
    limits: {
      max_net_delta: 50,
      max_net_vega: 100,
      max_daily_loss: 5000,
      max_symbol_concentration: 20,
      max_drawdown: 10_000,
      max_order_size: 10,
      max_open_orders: 20,
    },
    strategies: {},
    reconciliation: { interval_seconds: 60, halt_on_drift: true },
    approval_timeout_seconds: 300,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
