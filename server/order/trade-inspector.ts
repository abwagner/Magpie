// ── Trade Inspector ───────────────────────────────────────────────────
// Aggregates the full audit chain (signal → intent → pricing_decision →
// order → fill) for a given fill_id. Backs the Trade Inspector GUI
// surface defined in `docs/design_handoff_quantfoundry/source_brief_gui.md`
// and addresses QF-215.
//
// The inspector is a read-only join across the five audit tables. It is
// deliberately a separate module from server/analytics so the OrderPlane
// surface owns its own forensic API alongside the writers (QF-207,
// QF-208, QF-42, QF-206).
//
// The signal join is the trickiest part: audit_intents.signal_ids is a
// JSON-encoded array of zero-or-more signal_ids. For v1 we expand only
// the first signal in the array (it's the originating one in practice)
// and surface the rest unjoined via a separate `related_signal_ids`
// field. Multi-signal joins (full set of upstream signals) can land in a
// follow-up when a real use case emerges.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";

// ── Public shape ──────────────────────────────────────────────────────

export interface InspectorFillRow {
  fill_id: string;
  order_id: string;
  price: number;
  quantity: number;
  fees: number | null;
  filled_at: string;
  expected_price: number | null;
  slippage: number | null;
  // QF-244: M12-2 — which Schwab account this fill came from.
  account_id: string;
}

export interface InspectorOrderRow {
  order_id: string;
  intent_id: string;
  broker: string;
  execution_mode: string;
  status: string;
  created_at: string;
  risk_checked_at: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  broker_order_id: string | null;
  operator_edits: unknown;
  risk_violations: unknown;
  halt_reason: string | null;
  broker_rejection_reason: string | null;
  quote_failure_reason: string | null;
  // QF-244: M12-2 — which Schwab account this order came from.
  account_id: string;
}

export interface InspectorIntentRow {
  intent_id: string;
  portfolio: string;
  strategy_id: string;
  symbol: string;
  direction: string;
  quantity: number;
  signal_ids: string[];
  created_at: string;
}

export interface InspectorPricingDecisionRow {
  decision_id: string;
  intent_id: string;
  strategy_id: string;
  strategy_chosen: string;
  profile_source: string;
  inputs: unknown;
  order_type: string;
  limit_price: number | null;
  limit_price_pre_snap: number | null;
  time_in_force: string;
  working_policy_id: string;
  reasoning: string;
  created_at: string;
}

export interface InspectorSignalRow {
  signal_id: string;
  model_id: string;
  model_version: string;
  symbol: string;
  asof: string;
  kind: string;
  batch_id: string | null;
  ingest_ts: string;
}

export interface TradeInspectorResult {
  fill: InspectorFillRow;
  order: InspectorOrderRow;
  intent: InspectorIntentRow;
  // Ordered by created_at ASC; multi-decision intents (working-policy
  // repegs) produce more than one row.
  pricing_decisions: InspectorPricingDecisionRow[];
  // Null when the intent referenced no signals (rare; legacy paths).
  originating_signal: InspectorSignalRow | null;
}

export class TradeInspectorNotFoundError extends Error {
  public readonly status = 404;
  constructor(fillId: string) {
    super(`No fill with fill_id=${fillId}`);
    this.name = "TradeInspectorNotFoundError";
  }
}

// ── Implementation ────────────────────────────────────────────────────

function runOne<T>(db: Database, sql: string, params: unknown[]): Promise<T | null> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else {
        const arr = (rows as T[]) ?? [];
        resolve(arr[0] ?? null);
      }
    });
  });
}

function runMany<T>(db: Database, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

function safeJsonParse(s: string | null | undefined): unknown {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s; // surface the raw string so the operator can debug malformed JSON
  }
}

function parseSignalIds(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export interface TradeInspector {
  inspect(fillId: string): Promise<TradeInspectorResult>;
}

export function createTradeInspector(db: Database, logger: Logger): TradeInspector {
  return {
    async inspect(fillId: string): Promise<TradeInspectorResult> {
      // 1. Fill row (anchors everything; 404 if missing).
      type RawFill = {
        fill_id: string;
        order_id: string;
        price: number;
        quantity: number;
        fees: number | null;
        filled_at: string;
        expected_price: number | null;
        slippage: number | null;
        account_id: string;
      };
      const fillRaw = await runOne<RawFill>(
        db,
        `SELECT fill_id, order_id, price, quantity, fees, filled_at,
                expected_price, slippage, account_id
         FROM audit_fills WHERE fill_id = ?`,
        [fillId],
      );
      if (!fillRaw) throw new TradeInspectorNotFoundError(fillId);

      // 2. Order, intent, pricing decisions, originating signal — one
      // query per table. DuckDB handles these in O(microseconds) at this
      // scale; the alternative single big JOIN risks Cartesian blowup on
      // multi-decision intents.
      type RawOrder = {
        order_id: string;
        intent_id: string;
        broker: string;
        execution_mode: string;
        status: string;
        created_at: string;
        risk_checked_at: string | null;
        approved_at: string | null;
        submitted_at: string | null;
        completed_at: string | null;
        broker_order_id: string | null;
        operator_edits: string | null;
        risk_violations: string | null;
        halt_reason: string | null;
        broker_rejection_reason: string | null;
        quote_failure_reason: string | null;
        account_id: string;
      };
      const orderRaw = await runOne<RawOrder>(
        db,
        `SELECT order_id, intent_id, broker, execution_mode, status,
                created_at, risk_checked_at, approved_at, submitted_at,
                completed_at, broker_order_id, operator_edits,
                risk_violations, halt_reason, broker_rejection_reason,
                quote_failure_reason, account_id
         FROM audit_orders WHERE order_id = ?`,
        [fillRaw.order_id],
      );
      if (!orderRaw) {
        // FK constraint should make this unreachable, but surface
        // explicitly rather than NPE.
        throw new Error(
          `Inconsistent audit chain: fill ${fillId} references missing order ${fillRaw.order_id}`,
        );
      }

      type RawIntent = {
        intent_id: string;
        portfolio: string;
        strategy_id: string;
        symbol: string;
        direction: string;
        quantity: number;
        signal_ids: string;
        created_at: string;
      };
      const intentRaw = await runOne<RawIntent>(
        db,
        `SELECT intent_id, portfolio, strategy_id, symbol, direction,
                quantity, signal_ids, created_at
         FROM audit_intents WHERE intent_id = ?`,
        [orderRaw.intent_id],
      );
      if (!intentRaw) {
        throw new Error(
          `Inconsistent audit chain: order ${orderRaw.order_id} references missing intent ${orderRaw.intent_id}`,
        );
      }
      const signalIds = parseSignalIds(intentRaw.signal_ids);

      type RawDecision = {
        decision_id: string;
        intent_id: string;
        strategy_id: string;
        strategy_chosen: string;
        profile_source: string;
        inputs_json: string;
        order_type: string;
        limit_price: number | null;
        limit_price_pre_snap: number | null;
        time_in_force: string;
        working_policy_id: string;
        reasoning: string;
        created_at: string;
      };
      const decisionsRaw = await runMany<RawDecision>(
        db,
        `SELECT decision_id, intent_id, strategy_id, strategy_chosen,
                profile_source, inputs_json, order_type, limit_price,
                limit_price_pre_snap, time_in_force, working_policy_id,
                reasoning, created_at
         FROM audit_pricing_decisions
         WHERE intent_id = ?
         ORDER BY created_at ASC`,
        [intentRaw.intent_id],
      );

      // audit_signals table retired with Arch-A signal subsystem (QF-261).
      // originating_signal is always null after retirement.
      const originatingSignal: InspectorSignalRow | null = null;

      return {
        fill: {
          fill_id: fillRaw.fill_id,
          order_id: fillRaw.order_id,
          price: fillRaw.price,
          quantity: fillRaw.quantity,
          fees: fillRaw.fees,
          filled_at: fillRaw.filled_at,
          expected_price: fillRaw.expected_price,
          slippage: fillRaw.slippage,
          account_id: fillRaw.account_id,
        },
        order: {
          order_id: orderRaw.order_id,
          intent_id: orderRaw.intent_id,
          broker: orderRaw.broker,
          execution_mode: orderRaw.execution_mode,
          status: orderRaw.status,
          created_at: orderRaw.created_at,
          risk_checked_at: orderRaw.risk_checked_at,
          approved_at: orderRaw.approved_at,
          submitted_at: orderRaw.submitted_at,
          completed_at: orderRaw.completed_at,
          broker_order_id: orderRaw.broker_order_id,
          operator_edits: safeJsonParse(orderRaw.operator_edits),
          risk_violations: safeJsonParse(orderRaw.risk_violations),
          halt_reason: orderRaw.halt_reason,
          broker_rejection_reason: orderRaw.broker_rejection_reason,
          quote_failure_reason: orderRaw.quote_failure_reason,
          account_id: orderRaw.account_id,
        },
        intent: {
          intent_id: intentRaw.intent_id,
          portfolio: intentRaw.portfolio,
          strategy_id: intentRaw.strategy_id,
          symbol: intentRaw.symbol,
          direction: intentRaw.direction,
          quantity: intentRaw.quantity,
          signal_ids: signalIds,
          created_at: intentRaw.created_at,
        },
        pricing_decisions: decisionsRaw.map((d) => ({
          decision_id: d.decision_id,
          intent_id: d.intent_id,
          strategy_id: d.strategy_id,
          strategy_chosen: d.strategy_chosen,
          profile_source: d.profile_source,
          inputs: safeJsonParse(d.inputs_json),
          order_type: d.order_type,
          limit_price: d.limit_price,
          limit_price_pre_snap: d.limit_price_pre_snap,
          time_in_force: d.time_in_force,
          working_policy_id: d.working_policy_id,
          reasoning: d.reasoning,
          created_at: d.created_at,
        })),
        originating_signal: originatingSignal,
      };
    },
  };
}
