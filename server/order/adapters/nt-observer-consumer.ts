// ── NT Audit Observer Consumer ────────────────────────────────────────
//
// Completes the two-flow audit chain (docs/tdd/order-flow.md §4).
// Subscribes to `orders.exec_reports.<broker>` and writes audit_orders /
// audit_fills rows with source='nt-native' for chains whose OPL/gate
// counterpart did NOT write them.
//
// Dedup contract per §4.3: before any write, query audit_orders by
// broker_order_id. If a row already exists, OPL owns the chain — skip
// both audit_orders and audit_fills (OPL's fill handler will write the
// fill with source='qf'). For pure-NT-native orders (no QF parent), the
// dispatcher skips when BrokerExecReport.intent_id is null because the
// FK audit_orders.intent_id → audit_intents.intent_id can't be satisfied
// without a QF-side intent row.
//
// The bridge module (nt-bridge.ts) ALSO subscribes to the same subject
// to drive OPL's onFill / onRejection callbacks. NATS allows multiple
// subscribers; the two paths don't interfere. See §4.3 race notes.
//
// QF-319.

import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type { BrokerExecReport } from "../../../src/types/order.js";
import type { Logger } from "../../logger.js";
import { buildNtNativeOrderRow, type AuditOrderWriter } from "../audit-orders.js";
import { buildFillRow, type AuditFillWriter } from "../audit-fills.js";

// ── Public surface ────────────────────────────────────────────────────

export interface NtObserverConsumerConfig {
  broker: string;
}

// Dedup lookup: returns the audit_orders.order_id for the given
// broker_order_id, or null if no row exists. Production wires this to
// a DuckDB SELECT; tests stub it with an in-memory map.
export type LookupQfOrderId = (brokerOrderId: string) => Promise<string | null>;

export interface NtObserverConsumerDeps {
  nc: NatsConnection;
  config: NtObserverConsumerConfig;
  logger: Logger;
  lookupQfOrderId: LookupQfOrderId;
  auditOrderWriter: AuditOrderWriter;
  auditFillWriter: AuditFillWriter;
}

export interface NtObserverConsumer {
  // For test introspection / graceful-shutdown wiring. The subscription
  // closes when the underlying NATS connection drains.
  close(): void;
}

// ── Implementation ────────────────────────────────────────────────────

const X_CORRELATION_ID = "X-Correlation-Id";

export function createNtObserverConsumer(deps: NtObserverConsumerDeps): NtObserverConsumer {
  const { nc, config, logger, lookupQfOrderId, auditOrderWriter, auditFillWriter } = deps;
  const sc = StringCodec();
  const subject = `orders.exec_reports.${config.broker}`;
  const sub = nc.subscribe(subject);

  void (async () => {
    for await (const msg of sub) {
      let report: BrokerExecReport;
      try {
        report = JSON.parse(sc.decode(msg.data)) as BrokerExecReport;
      } catch (err) {
        logger.warn("nt-observer: malformed exec_report payload", {
          broker: config.broker,
          error: String(err),
        });
        continue;
      }
      // Correlation: NATS header first, payload fallback.
      const correlationId = msg.headers?.get(X_CORRELATION_ID) || report.correlation_id || null;
      try {
        await handleExecReport(report, correlationId);
      } catch (err) {
        // Don't crash the subscription on a single bad row — log and
        // move on. The audit gap is itself observable via downstream
        // reconciliation; per docs/tdd/order-flow.md §5 "Audit DB
        // unreachable" / "Audit observer + OPL race on a fill".
        logger.error("nt-observer: handler threw on exec_report", {
          broker: config.broker,
          broker_order_id: report.broker_order_id,
          event: report.event,
          error: String(err),
        });
      }
    }
  })();

  async function handleExecReport(
    report: BrokerExecReport,
    correlationId: string | null,
  ): Promise<void> {
    // Only fill / partial_fill / rejected events drive audit writes.
    // 'submitted' and 'cancelled' are informational for nt-bridge's OPL
    // callbacks; the observer doesn't synthesize a row for them.
    if (report.event !== "fill" && report.event !== "partial_fill" && report.event !== "rejected") {
      return;
    }

    // §4.3 dedup: if OPL has already inserted an audit_orders row for
    // this broker_order_id, OPL owns the chain. Skip both writes.
    const existingQfOrderId = await lookupQfOrderId(report.broker_order_id);
    if (existingQfOrderId !== null) {
      logger.debug("nt-observer: dedup skip (qf row exists)", {
        broker: config.broker,
        broker_order_id: report.broker_order_id,
        qf_order_id: existingQfOrderId,
        event: report.event,
      });
      return;
    }

    // No QF chain. We need an intent_id to satisfy the audit_orders FK
    // to audit_intents. Per §4.1, a null intent_id marks a pure-NT-
    // native order with no QF parent — drop silently. The IBKR bridge
    // always emits null here today (NT-side initiated).
    const intentId = report.intent_id ?? null;
    if (intentId === null) {
      logger.debug("nt-observer: skip (no intent_id, pure-NT order)", {
        broker: config.broker,
        broker_order_id: report.broker_order_id,
      });
      return;
    }

    // Build the nt-native audit_orders row. The PK uses broker_order_id
    // directly because no QF-side ULID was minted for this chain — the
    // broker id is unique within a broker namespace and stable across
    // restarts via NT MessageBus replay.
    const orderRow = buildNtNativeOrderRow({
      order_id: report.broker_order_id,
      intent_id: intentId,
      broker: config.broker,
      status: statusFromEvent(report),
      created_at: report.ts,
      broker_order_id: report.broker_order_id,
      broker_rejection_reason:
        report.event === "rejected" ? (report.rejection_reason ?? "unknown") : null,
      correlation_id: correlationId,
    });
    await auditOrderWriter(orderRow);

    // Fill row only on fill / partial_fill. Rejected has no fill.
    if (report.event === "fill" || report.event === "partial_fill") {
      if (!report.fill) {
        logger.warn("nt-observer: fill event missing fill payload", {
          broker: config.broker,
          broker_order_id: report.broker_order_id,
        });
        return;
      }
      const fillRow = buildFillRow({
        fill: {
          fill_id: report.fill.fill_id,
          order_id: report.broker_order_id,
          intent_id: intentId,
          portfolio: "",
          symbol: "",
          direction: "",
          quantity: report.fill.quantity,
          price: report.fill.price,
          fees: report.fill.fees ?? 0,
          filled_at: report.ts,
          broker: report.broker,
          broker_order_id: report.broker_order_id,
        },
        source: "nt-native",
        correlation_id: correlationId,
      });
      await auditFillWriter(fillRow);
    }
  }

  return {
    close(): void {
      // Subscriptions tear down via the NATS connection close; nothing
      // observer-specific to release here. Kept as a placeholder so the
      // factory's return type can grow without changing call sites.
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function statusFromEvent(report: BrokerExecReport): string {
  switch (report.event) {
    case "fill":
      return "filled";
    case "partial_fill":
      return "partial_filled";
    case "rejected":
      return "rejected_by_broker";
    default:
      // The dispatcher guards against other events, so this is
      // unreachable in practice. Throw to keep the type narrowing tight.
      throw new Error(`nt-observer: unexpected event ${report.event}`);
  }
}
