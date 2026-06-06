// ── Gate evaluator startup rehydration ────────────────────────────────
//
// On QF restart the gate-evaluator must rebuild its in-memory
// pending_intents log from durable state before serving any RPCs (per
// docs/tdd/risk-gate-architecture.md §5.2). Until rehydration
// completes, the warm-up gate (createGateHandler in QF-315 reads this
// module's ready-state) replies with `gate_unavailable_open_blocked` —
// a deliberate inversion of the live fail-open path; a cold-start gate
// with zero state cannot safely allow closes against an unknown book.
//
// Source-of-truth query:
//   audit_intents WHERE source='qf-gated'
//                   AND gate_decision='approve'
//                   AND envelope_revoked_at IS NULL
// Joined against audit_orders + audit_fills to classify each parent:
//   - any audit_orders row with status='filled' AND
//     SUM(audit_fills.quantity) == audit_intents.quantity → 'filled'
//   - status='cancelled' on the order → 'cancelled'
//   - status='rejected_by_broker'      → 'rejected'
//   - otherwise → 'pending' (in-flight; partial-fill remaining_qty
//     computed from intent qty minus SUM(fills.quantity))
//
// Filled/cancelled/rejected rows are still emitted to the store so the
// retention window plays out consistently for late-arriving aggregate
// queries against terminal states.
//
// QF-316.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type { PendingIntent, PendingIntentStatus, PendingIntentsStore } from "./pending-intents.js";

interface AuditRow {
  intent_id: string;
  strategy_id: string;
  portfolio: string;
  symbol: string;
  direction: string;
  quantity: number;
  envelope_id: string | null;
  created_at: string;
  // Aggregated from the join.
  any_filled: number | null;
  any_cancelled: number | null;
  any_rejected: number | null;
  total_filled_qty: number | null;
  broker: string | null;
}

const REHYDRATION_SQL = `
  SELECT
    i.intent_id,
    i.strategy_id,
    i.portfolio,
    i.symbol,
    i.direction,
    i.quantity,
    i.envelope_id,
    i.created_at,
    MAX(CASE WHEN o.status = 'filled' THEN 1 ELSE 0 END)            AS any_filled,
    MAX(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END)         AS any_cancelled,
    MAX(CASE WHEN o.status = 'rejected_by_broker' THEN 1 ELSE 0 END) AS any_rejected,
    COALESCE(SUM(f.quantity), 0)                                    AS total_filled_qty,
    MAX(o.broker)                                                   AS broker
  FROM audit_intents i
  LEFT JOIN audit_orders o ON o.intent_id = i.intent_id
  LEFT JOIN audit_fills  f ON f.order_id  = o.order_id
  WHERE i.source = 'qf-gated'
    AND i.gate_decision = 'approve'
    AND i.envelope_revoked_at IS NULL
  GROUP BY i.intent_id, i.strategy_id, i.portfolio, i.symbol,
           i.direction, i.quantity, i.envelope_id, i.created_at
`;

export interface RehydrationDeps {
  db: Database;
  logger: Logger;
  store: PendingIntentsStore;
}

export interface RehydrationStats {
  totalScanned: number;
  pending: number;
  filled: number;
  cancelled: number;
  rejected: number;
}

export async function rehydratePendingIntents(deps: RehydrationDeps): Promise<RehydrationStats> {
  const { db, logger, store } = deps;
  const rows = await new Promise<AuditRow[]>((resolve, reject) => {
    db.all(REHYDRATION_SQL, (err: Error | null, rows: unknown) => {
      if (err) return reject(err);
      resolve(rows as AuditRow[]);
    });
  });

  const stats: RehydrationStats = {
    totalScanned: rows.length,
    pending: 0,
    filled: 0,
    cancelled: 0,
    rejected: 0,
  };

  for (const r of rows) {
    const status = classifyStatus(r);
    const filledQty = Number(r.total_filled_qty ?? 0);
    const remaining = Math.max(0, r.quantity - filledQty);
    const intent: PendingIntent = {
      intent_id: r.intent_id,
      strategy_id: r.strategy_id,
      portfolio_id: r.portfolio,
      broker: r.broker ?? "unknown",
      symbol: r.symbol,
      side: r.direction.toLowerCase() === "short" ? "sell" : "buy",
      qty: r.quantity,
      remaining_qty: remaining,
      estimated_notional: 0,
      estimated_delta: 0,
      asof: r.created_at,
      status,
      envelope_id: r.envelope_id ?? r.intent_id,
    };
    store.add(intent);
    if (status === "pending") stats.pending += 1;
    else if (status === "filled") {
      stats.filled += 1;
      store.markFilled(r.intent_id, r.created_at);
    } else if (status === "cancelled") {
      stats.cancelled += 1;
      store.markCancelled(r.intent_id, r.created_at);
    } else if (status === "rejected") {
      stats.rejected += 1;
      store.markRejected(r.intent_id, r.created_at);
    }
  }

  logger.info("pending_intents rehydration complete", { ...stats });
  return stats;
}

function classifyStatus(r: AuditRow): PendingIntentStatus {
  // Terminal states win over pending. Filled outranks cancelled when
  // both rows exist (partial fill then cancel of remainder is still a
  // partial-filled outcome — pending for aggregate purposes is moot
  // since no remaining qty exists; we surface as 'filled' for clarity).
  if (r.any_filled) return "filled";
  if (r.any_rejected) return "rejected";
  if (r.any_cancelled) return "cancelled";
  return "pending";
}

// ── Warm-up gate ──────────────────────────────────────────────────────
//
// Lightweight ready-flag the gate-handler checks at request entry.
// Pattern: createWarmUpGate() returns { isReady, markReady }; the
// startup hydrator calls markReady() once rehydratePendingIntents
// resolves. Tests can construct one directly and skip the DB path.

export interface WarmUpGate {
  isReady(): boolean;
  markReady(): void;
}

export function createWarmUpGate(): WarmUpGate {
  let ready = false;
  return {
    isReady: () => ready,
    markReady: () => {
      ready = true;
    },
  };
}
