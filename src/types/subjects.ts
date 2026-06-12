// ── NATS Subject Builders ──────────────────────────────────────────
// Single source of truth for every NATS subject string the TS side
// constructs. Mirrors research/magpie-subjects (Python). The
// canonical registry — owners, payloads, grammar — lives in
// docs/tdd/nats-subjects.md; this module is its executable form.
//
// Pure refactor (QF-335): no new subjects are introduced here. Every
// builder reproduces a literal that previously lived inline at a
// bridge/handler callsite. Parity with the Python mirror is enforced by
// docs/tdd/nats-subjects.fixtures.json (see __tests__/subjects.test.ts).

// `<broker>` is the bundle suffix bound to config/brokers.json. Kept as
// a plain string (not a `"schwab" | "ibkr"` union) so callers that read
// the broker from config don't need a cast — the value space is
// documented in docs/tdd/nats-subjects.md §1.
export type Broker = string;

// Streaming market-data families. The first token after `marketdata.`
// for per-symbol pub/sub streams.
export type MdStream = "quotes" | "trades" | "book";

// ── Orders (OPL ↔ broker bridge) — docs/tdd/nats-subjects.md §2.1 ──

interface GateSubject {
  (broker: Broker): string;
  // Inverse direction (QF claws back an approved envelope) — §2.2.
  revoke: (broker: Broker) => string;
}

const gate = ((broker: Broker) => `orders.gate.${broker}`) as GateSubject;
gate.revoke = (broker: Broker) => `orders.gate.revoke.${broker}`;

export const orders = {
  submit: (broker: Broker) => `orders.submit.${broker}`,
  cancel: (broker: Broker) => `orders.cancel.${broker}`,
  status: (broker: Broker) => `orders.status.${broker}`,
  positions: (broker: Broker) => `orders.positions.${broker}`,
  accounts: (broker: Broker) => `orders.accounts.${broker}`,
  execReports: (broker: Broker) => `orders.exec_reports.${broker}`,
  // Risk gate (NT plugin ↔ QF gate evaluator) — §2.2. `orders.gate(b)`
  // is callable; `orders.gate.revoke(b)` is the revocation subject.
  gate,
} as const;

// ── Market data (MD bridge ↔ TS MD service) — §2.3 ──

export const marketdata = {
  rpc: {
    quote: (broker: Broker) => `marketdata.rpc.quote.${broker}`,
    expirations: (broker: Broker) => `marketdata.rpc.expirations.${broker}`,
    chain: (broker: Broker) => `marketdata.rpc.chain.${broker}`,
    historicalChain: (broker: Broker) =>
      `marketdata.rpc.historical_chain.${broker}`,
    candles: (broker: Broker) => `marketdata.rpc.candles.${broker}`,
  },
  // Streaming pub/sub. With a symbol → the per-symbol subject the bridge
  // publishes to / a consumer subscribes to; without → the broker-level
  // base (e.g. for ownership logging or a wildcard subscription root).
  stream: (stream: MdStream, broker: Broker, symbol?: string) =>
    symbol === undefined
      ? `marketdata.${stream}.${broker}`
      : `marketdata.${stream}.${broker}.${symbol}`,
  quotes: (broker: Broker, symbol?: string) =>
    marketdata.stream("quotes", broker, symbol),
  trades: (broker: Broker, symbol?: string) =>
    marketdata.stream("trades", broker, symbol),
  book: (broker: Broker, symbol?: string) =>
    marketdata.stream("book", broker, symbol),
  // Liveness — §2.3. Every 10s; drives the data-quality gate.
  heartbeat: (broker: Broker) => `marketdata.${broker}.heartbeat`,
} as const;

// ── Broker events (portfolio lifecycle) — §3 (QF-309) ────────────────
// Option lifecycle events pushed by the NT broker bridges (assignment,
// exercise, expiry notifications). Consumed by the audit observer to
// mutate positions and realize P&L. Per broker pub-only.
export const brokerEvents = {
  stream: (broker: Broker) => `broker.events.${broker}`,
} as const;
