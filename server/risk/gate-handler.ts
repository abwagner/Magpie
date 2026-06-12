// ── Risk Gate RPC handler ──────────────────────────────────────────────
//
// NATS subscriber on `orders.gate.<broker>` for the QF-side of the
// gate-evaluator contract (docs/tdd/risk-gate-architecture.md §3).
//
// Per-request flow:
//   1. Parse + validate GateRequest.
//   2. Mint intent_id (ULID) and envelope_id (= intent_id at v1).
//   3. Evaluate via `evaluateGate` (parent-budget semantic check); the
//      v1 evaluator delegates to PortfolioEngine.canExecute, which
//      covers per-strategy + portfolio-halt + halt-state checks but
//      NOT the cross-strategy aggregates that QF-317 wires up.
//   4. Reply with GateResponse on the request inbox.
//   5. Fire-and-forget audit_intents write with source='qf-gated',
//      gate_decision, gate_reason, envelope_id. Reply does NOT await
//      the write so we stay inside the 50ms RPC budget (§3.4).
//
// Restart / pending_intents log behavior, cross-strategy aggregate
// checks, and envelope revocation all live in separate tickets (QF-316,
// QF-317, QF-318 respectively).
//
// QF-315.

import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type { Logger } from "../logger.js";
import type { OrderIntent, RiskCheckResult } from "../../src/types/order.js";
import type { PortfolioEngine } from "../portfolio/engine.js";
import { buildIntentRow, type AuditIntentWriter } from "../order/audit-intent.js";
import type { PendingIntentsStore, PendingIntent } from "./pending-intents.js";
import type { WarmUpGate } from "./rehydration.js";
import { orders } from "../../src/types/subjects.js";

// ── Wire contract (mirrors risk-gate-architecture.md §3.2–3.3) ────────

export interface GateRequest {
  intent: OrderIntent;
  strategy_id: string;
  portfolio_id: string;
  current_position: { qty: number; avg_price: number } | null;
  account_balance: number;
  asof: string;
}

export type GateDecision = "approve" | "reject";

// Reasons mirror §3.3 RejectionReason but kept as a union of strings
// (string-typed wire field) so the gate plugin can add reasons without
// a coupled type update on the QF side.
export type GateRejectionReason =
  | "limit_exceeded_per_strategy"
  | "limit_exceeded_aggregate"
  | "limit_exceeded_portfolio"
  | "strategy_halted"
  | "concentration"
  | "config_invalid"
  | "gate_unavailable_open_blocked"
  | "gate_unavailable_nt_rejected";

export interface GateResponse {
  decision: GateDecision;
  reason: GateRejectionReason | null;
  intent_id: string;
  envelope_id: string | null;
}

// ── Evaluator surface ─────────────────────────────────────────────────
//
// Pluggable so QF-317 can land the cross-strategy aggregate-checks
// evaluator without touching the handler. v1 default below delegates to
// PortfolioEngine.canExecute.

export interface GateEvaluator {
  evaluate(req: GateRequest, intentId: string): GateEvaluation;
}

export interface GateEvaluation {
  decision: GateDecision;
  reason: GateRejectionReason | null;
}

export function createDefaultEvaluator(portfolioEngine: PortfolioEngine): GateEvaluator {
  return {
    evaluate(req: GateRequest, intentId: string): GateEvaluation {
      // Reconstruct the OrderIntent with the minted intent_id so the
      // engine's canExecute() sees a well-formed intent. The strategy
      // delivered .intent without an intent_id (the gate is the
      // assigner per §3.3).
      const intent: OrderIntent = { ...req.intent, intent_id: intentId };
      const result: RiskCheckResult = portfolioEngine.canExecute(req.portfolio_id, intent);
      if (result.ok) return { decision: "approve", reason: null };
      return { decision: "reject", reason: mapViolationToReason(result) };
    },
  };
}

function mapViolationToReason(result: RiskCheckResult): GateRejectionReason {
  // PortfolioEngine.canExecute emits Violation[] with a `limit` field
  // and `action: 'reject' | 'halt'`. Map limit → gate reason.
  // QF-317 will replace this with a richer evaluator that natively
  // emits GateRejectionReason values.
  const v = result.violations[0];
  if (!v) return "config_invalid";
  if (v.limit === "portfolio_halted") return "limit_exceeded_portfolio";
  if (v.limit === "strategy_halted") return "strategy_halted";
  if (v.limit.startsWith("concentration")) return "concentration";
  if (v.action === "halt") return "limit_exceeded_portfolio";
  return "limit_exceeded_per_strategy";
}

// ── Handler factory ───────────────────────────────────────────────────

export interface GateHandlerConfig {
  broker: string;
}

export interface GateHandlerDeps {
  nc: NatsConnection;
  config: GateHandlerConfig;
  logger: Logger;
  evaluator: GateEvaluator;
  auditIntentWriter: AuditIntentWriter;
  generateIntentId: () => string;
  // QF-316 — optional warm-up gate. When provided, requests received
  // before warmUpGate.markReady() is called reply with
  // gate_unavailable_open_blocked per risk-gate-architecture.md §5.2.
  // Absent in v1 unit tests + the v1 server bootstrap until rehydration
  // is wired (the wiring lands with the rehydration scheduler).
  warmUpGate?: WarmUpGate;
  // QF-316 — optional pending-intents store. When provided, approvals
  // enroll a parent intent into the in-flight log so cross-strategy
  // aggregate queries (QF-317) see them.
  pendingIntents?: PendingIntentsStore;
  // Test seam: defaults to Date.now() formatted.
  now?: () => string;
}

export interface GateHandler {
  close(): void;
}

export function createGateHandler(deps: GateHandlerDeps): GateHandler {
  const { nc, config, logger, evaluator, auditIntentWriter, generateIntentId } = deps;
  const warmUpGate = deps.warmUpGate;
  const pendingIntents = deps.pendingIntents;
  const now = deps.now ?? (() => new Date().toISOString());
  const sc = StringCodec();
  const subject = orders.gate(config.broker);
  const sub = nc.subscribe(subject);

  void (async () => {
    for await (const msg of sub) {
      let req: GateRequest;
      try {
        req = JSON.parse(sc.decode(msg.data)) as GateRequest;
      } catch (err) {
        logger.warn("gate: malformed request payload", {
          broker: config.broker,
          error: String(err),
        });
        // Reply with a reject so the NT plugin doesn't hang. Missing
        // intent_id is intentional — the plugin treats a malformed
        // reply as a closes-only fail-open trigger per §4.
        if (msg.reply) {
          msg.respond(
            sc.encode(
              JSON.stringify({
                decision: "reject",
                reason: "config_invalid",
                intent_id: "",
                envelope_id: null,
              }),
            ),
          );
        }
        continue;
      }
      // QF-316 — warm-up gate per §5.2. While rehydration is in
      // progress, every request rejects with
      // gate_unavailable_open_blocked (intentional inversion of fail-
      // open; cold-start with zero state can't safely allow closes).
      if (warmUpGate && !warmUpGate.isReady()) {
        if (msg.reply) {
          msg.respond(
            sc.encode(
              JSON.stringify({
                decision: "reject",
                reason: "gate_unavailable_open_blocked",
                intent_id: "",
                envelope_id: null,
              }),
            ),
          );
        }
        continue;
      }
      const intentId = generateIntentId();
      // envelope_id = intent_id at v1 per §3.3.
      const envelopeId = intentId;
      const correlationId = msg.headers?.get("X-Correlation-Id") ?? null;
      let evaluation: GateEvaluation;
      try {
        evaluation = evaluator.evaluate(req, intentId);
      } catch (err) {
        // Evaluator threw — log + reject as config_invalid. The plugin
        // treats this as a hard reject; it does NOT trigger fail-open
        // (fail-open is for transport-level failures, not eval errors).
        logger.error("gate: evaluator threw", {
          broker: config.broker,
          intent_id: intentId,
          error: String(err),
        });
        evaluation = { decision: "reject", reason: "config_invalid" };
      }
      const reply: GateResponse = {
        decision: evaluation.decision,
        reason: evaluation.reason,
        intent_id: intentId,
        envelope_id: evaluation.decision === "approve" ? envelopeId : null,
      };
      if (msg.reply) {
        msg.respond(sc.encode(JSON.stringify(reply)));
      }
      // Fire-and-forget audit write. §3.4: no DB writes on the hot
      // path. The writer is async; we don't await so the reply is not
      // delayed by DuckDB queuing. Errors are logged on the writer side.
      const row = buildIntentRow({
        intent_id: intentId,
        signal_ids: req.intent.signal_ids ?? [],
        portfolio: req.portfolio_id,
        symbol: req.intent.symbol,
        direction: req.intent.direction,
        quantity: req.intent.quantity,
        strategy_id: req.strategy_id,
        created_at: now(),
        source: "qf-gated",
        correlation_id: correlationId,
        gate_decision: evaluation.decision,
        gate_reason: evaluation.reason,
        envelope_id: evaluation.decision === "approve" ? envelopeId : null,
      });
      void auditIntentWriter(row).catch((err) => {
        logger.error("gate: audit write failed", {
          broker: config.broker,
          intent_id: intentId,
          error: String(err),
        });
      });
      // QF-316 — enroll approved parent intents into the in-memory log
      // so cross-strategy aggregate queries (QF-317) include this
      // in-flight commitment alongside settled positions. Observer
      // events drive subsequent transitions (filled / cancelled /
      // rejected); envelope-revoker drives envelope_revoked.
      if (evaluation.decision === "approve" && pendingIntents) {
        const intent: PendingIntent = {
          intent_id: intentId,
          strategy_id: req.strategy_id,
          portfolio_id: req.portfolio_id,
          broker: config.broker,
          symbol: req.intent.symbol,
          side: req.intent.direction.toLowerCase() === "short" ? "sell" : "buy",
          qty: req.intent.quantity,
          remaining_qty: req.intent.quantity,
          // Estimated notional/delta land with QF-317's evaluator; v1
          // gate doesn't compute them so the substrate is 0 here. The
          // aggregate evaluator that needs them will compute from
          // gateRequest.intent + current quote.
          estimated_notional: 0,
          estimated_delta: 0,
          asof: now(),
          status: "pending",
          envelope_id: envelopeId,
        };
        pendingIntents.add(intent);
      }
    }
  })();

  return {
    close(): void {
      // Subscription tears down with the NATS connection. Placeholder
      // for future graceful-shutdown wiring.
    },
  };
}
