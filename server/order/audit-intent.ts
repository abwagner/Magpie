// ── audit_intents writer + row builder ────────────────────────────────
// Defined in: docs/tdd/order-flow.md §7.3 (audit-before-decision) +
// docs/tdd/cross-cutting.md §5 Audit trail tables.
//
// Every intent that flows through the Execution Layer leaves a row in
// audit_intents, even ones we know we'll reject downstream (risk
// violation, halt, broker rejection). The row is written at the TOP
// of execute() — before getQuote, before decidePrice, before submit —
// so a quote-fetch failure or risk rejection still leaves a trace.
//
// Schema lives in server/db/init.ts (audit_intents table). intent_id
// is the PK; the audit_pricing_decisions and audit_orders writers FK
// to it, so this row must exist before either of those writers fires.
//
// M11 / QF-206 + QF-203.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";

// ── Row + writer types ────────────────────────────────────────────────

export interface AuditIntentRow {
  intent_id: string;
  // JSON-encoded array of signal_id strings — DuckDB-side is VARCHAR.
  signal_ids: string;
  portfolio: string;
  symbol: string;
  direction: string;
  quantity: number;
  strategy_id: string;
  // ISO-8601 at the boundary; DuckDB stores as TIMESTAMP.
  created_at: string;
  // QF-214 — denormalized full Signal payload (JSON-stringified) so
  // restart recovery can rebuild the working-order monitor's
  // per-task originating Signal without an audit_signals join. Null
  // when the intent has no upstream signal.
  originating_signal_json: string | null;
  // QF-319 — writer-identity sourcing (Model A) per order-flow.md §4.2.
  // 'qf' for OPL-originated, 'qf-gated' for gate-evaluator-originated.
  source: "qf" | "qf-gated" | "nt-native";
  // QF-319 — chain anchor per observability.md §4.2. Optional from OPL
  // until lifecycle ULID wiring lands.
  correlation_id: string | null;
  // QF-315 — gate-evaluator outcome on source='qf-gated' rows.
  // Null for source='qf' rows (no gate decision).
  gate_decision: "approve" | "reject" | null;
  gate_reason: string | null;
  // QF-315 — envelope token returned to the NT plugin (== intent_id at
  // v1). Null on reject (no envelope to track).
  envelope_id: string | null;
}

export type AuditIntentWriter = (row: AuditIntentRow) => Promise<void>;

// ── Row builder ───────────────────────────────────────────────────────

export interface BuildIntentRowArgs {
  intent_id: string;
  signal_ids: string[];
  portfolio: string;
  symbol: string;
  direction: string;
  quantity: number;
  strategy_id: string;
  created_at?: string;
  originating_signal?: unknown;
  // QF-319 — defaults to 'qf' (OPL is the typical caller).
  source?: "qf" | "qf-gated" | "nt-native";
  correlation_id?: string | null;
  // QF-315 — gate-side fields. Defaults to null for the OPL path.
  gate_decision?: "approve" | "reject" | null;
  gate_reason?: string | null;
  envelope_id?: string | null;
}

export function buildIntentRow(args: BuildIntentRowArgs): AuditIntentRow {
  return {
    intent_id: args.intent_id,
    signal_ids: JSON.stringify(args.signal_ids),
    portfolio: args.portfolio,
    symbol: args.symbol,
    direction: args.direction,
    quantity: args.quantity,
    strategy_id: args.strategy_id,
    created_at: args.created_at ?? new Date().toISOString(),
    originating_signal_json: args.originating_signal
      ? JSON.stringify(args.originating_signal)
      : null,
    source: args.source ?? "qf",
    correlation_id: args.correlation_id ?? null,
    gate_decision: args.gate_decision ?? null,
    gate_reason: args.gate_reason ?? null,
    envelope_id: args.envelope_id ?? null,
  };
}

// ── DB-backed writer ──────────────────────────────────────────────────

export function createAuditIntentWriter(db: Database, logger: Logger): AuditIntentWriter {
  return async (row: AuditIntentRow): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      db.run(
        `INSERT INTO audit_intents (
           intent_id, signal_ids, portfolio, symbol,
           direction, quantity, strategy_id, created_at,
           originating_signal_json, source, correlation_id,
           gate_decision, gate_reason, envelope_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.intent_id,
        row.signal_ids,
        row.portfolio,
        row.symbol,
        row.direction,
        row.quantity,
        row.strategy_id,
        row.created_at,
        row.originating_signal_json,
        row.source,
        row.correlation_id,
        row.gate_decision,
        row.gate_reason,
        row.envelope_id,
        (err: Error | null) => {
          if (err) {
            logger.error("audit_intents write failed", {
              intent_id: row.intent_id,
              error: String(err),
            });
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  };
}
