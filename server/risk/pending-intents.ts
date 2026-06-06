// ── Pending intents in-memory log ────────────────────────────────────
//
// Implements docs/tdd/risk-gate-architecture.md §5.1. Tracks parent
// intents the gate has approved but the broker has not yet fully
// filled/cancelled/rejected. Cross-strategy aggregate checks (QF-317)
// sum over the `status='pending'` rows to compute in-flight delta /
// notional / qty alongside the settled portfolio state.
//
// Entries lifecycle:
//   1. add()                  — gate approve enrolls a parent intent
//   2. markPartialFill()      — observer event reduces remaining qty
//   3. markFilled() / markCancelled() / markRejected() /
//      markEnvelopeRevoked() — terminal transitions; the row stays in
//      a `terminalAt` window (default 5 minutes) so late aggregate
//      queries see consistent state, then drops via sweep().
//
// Retention sweep is invoked by an external scheduler (the server
// loop or a periodic timer). Tests drive it explicitly via sweep(now).
//
// Pending-intent revocation reclaim: when the envelope-revoker (QF-318)
// marks an envelope revoked, the matching row transitions to
// `envelope_revoked` and is dropped after the retention window.
//
// QF-316.

export type PendingIntentStatus =
  | "pending"
  | "filled"
  | "cancelled"
  | "rejected"
  | "envelope_revoked";

export interface PendingIntent {
  intent_id: string;
  strategy_id: string;
  portfolio_id: string;
  broker: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  // The remaining-to-fill qty. Equal to qty on enrollment; reduced on
  // partial fills. Tracked separately so the full envelope size is
  // preserved for audit + diagnostics.
  remaining_qty: number;
  estimated_notional: number;
  estimated_delta: number;
  asof: string;
  status: PendingIntentStatus;
  envelope_id: string;
}

export interface PendingIntentsConfig {
  // ms after terminal-state transition to retain before sweep drops.
  // Default 5 minutes per §5.1.
  retentionMs?: number;
}

export interface PendingIntentsStore {
  add(intent: PendingIntent): void;
  has(intentId: string): boolean;
  get(intentId: string): PendingIntent | null;
  markPartialFill(intentId: string, filledQty: number, now: string): void;
  markFilled(intentId: string, now: string): void;
  markCancelled(intentId: string, now: string): void;
  markRejected(intentId: string, now: string): void;
  markEnvelopeRevoked(intentId: string, now: string): void;
  // Aggregate-query helpers used by QF-317.
  getActive(): PendingIntent[];
  getActiveForStrategy(strategyId: string): PendingIntent[];
  getActiveForPortfolio(portfolioId: string): PendingIntent[];
  // Drop entries whose terminalAt + retentionMs is in the past.
  sweep(now: string): number;
  // Test seam: total size including retained terminals.
  size(): number;
}

const DEFAULT_RETENTION_MS = 5 * 60 * 1000;

interface Entry {
  intent: PendingIntent;
  // ms epoch when the row hit a terminal state. null while pending.
  terminalAtMs: number | null;
}

export function createPendingIntentsStore(config: PendingIntentsConfig = {}): PendingIntentsStore {
  const retentionMs = config.retentionMs ?? DEFAULT_RETENTION_MS;
  const entries = new Map<string, Entry>();

  function markTerminal(
    intentId: string,
    status: Exclude<PendingIntentStatus, "pending">,
    now: string,
  ): void {
    const e = entries.get(intentId);
    if (!e) return;
    e.intent.status = status;
    e.terminalAtMs = Date.parse(now);
  }

  return {
    add(intent) {
      entries.set(intent.intent_id, { intent, terminalAtMs: null });
    },
    has(intentId) {
      return entries.has(intentId);
    },
    get(intentId) {
      return entries.get(intentId)?.intent ?? null;
    },
    markPartialFill(intentId, filledQty, now) {
      const e = entries.get(intentId);
      if (!e) return;
      e.intent.remaining_qty = Math.max(0, e.intent.remaining_qty - filledQty);
      // If the partial fill completes the parent, auto-transition to
      // 'filled'. The observer can still call markFilled() explicitly —
      // it's a no-op when status is already terminal.
      if (e.intent.remaining_qty === 0) {
        e.intent.status = "filled";
        e.terminalAtMs = Date.parse(now);
      }
    },
    markFilled(intentId, now) {
      markTerminal(intentId, "filled", now);
    },
    markCancelled(intentId, now) {
      markTerminal(intentId, "cancelled", now);
    },
    markRejected(intentId, now) {
      markTerminal(intentId, "rejected", now);
    },
    markEnvelopeRevoked(intentId, now) {
      markTerminal(intentId, "envelope_revoked", now);
    },
    getActive() {
      const out: PendingIntent[] = [];
      for (const e of entries.values()) {
        if (e.intent.status === "pending") out.push(e.intent);
      }
      return out;
    },
    getActiveForStrategy(strategyId) {
      return this.getActive().filter((i) => i.strategy_id === strategyId);
    },
    getActiveForPortfolio(portfolioId) {
      return this.getActive().filter((i) => i.portfolio_id === portfolioId);
    },
    sweep(now) {
      const cutoff = Date.parse(now) - retentionMs;
      let dropped = 0;
      for (const [id, e] of entries) {
        if (e.terminalAtMs !== null && e.terminalAtMs <= cutoff) {
          entries.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },
    size() {
      return entries.size;
    },
  };
}
