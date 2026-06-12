// ── Broker Lifecycle Events Consumer ──────────────────────────────────
// Subscribes to `broker.events.<broker>` and processes option lifecycle
// events (assignment, exercise, expiry notifications) pushed by the NT
// broker bridges. For each event it:
//   1. Writes the audit chain: audit_intents (FK parent, source=nt-native)
//      → audit_orders (status=assigned/exercised/expired, source=nt-native).
//   2. Mutates the position ledger via PortfolioEngine.settleLifecycle —
//      closes the option, crystallizes realized P&L, adjusts cash, and for
//      physical settlement opens/modifies the resulting underlying leg.
//
// Defined in: docs/tdd/portfolio-risk-engine.md §11.3.
//
// NOTE (bridge-side dependency): this consumer assumes the Python NT
// bundles already translate broker-specific assignment/exercise events
// into the uniform BrokerLifecycleEvent wire payload on broker.events.*.
// That translator (§11.8 PR 3, Schwab/IBKR side) is NOT part of this
// ticket — we consume the documented contract.

import type { NatsConnection } from "nats";
import { StringCodec } from "nats";
import type { BrokerLifecycleEvent } from "../../src/types/broker-lifecycle.js";
import type { Logger } from "../logger.js";
import type { AuditOrderWriter } from "../order/audit-orders.js";
import { buildNtNativeOrderRow } from "../order/audit-orders.js";
import type { AuditIntentWriter } from "../order/audit-intent.js";
import { buildIntentRow } from "../order/audit-intent.js";
import type { PortfolioEngine, LifecycleSettlement } from "./engine.js";
import { canonicalToUnderlying } from "../symbols/convert.js";
import { brokerEvents } from "../../src/types/subjects.js";
import { ulid } from "ulid";

// ── Public surface ────────────────────────────────────────────────────

export interface BrokerEventsConsumerConfig {
  broker: string;
  // Portfolio whose ledger these events mutate. v1 routes all broker
  // events to the single configured portfolio; QF-244 multi-account
  // routing can resolve this per broker_position_id later.
  portfolioId: string;
}

export interface BrokerEventsConsumerDeps {
  nc: NatsConnection;
  config: BrokerEventsConsumerConfig;
  logger: Logger;
  engine: PortfolioEngine;
  auditIntentWriter: AuditIntentWriter;
  auditOrderWriter: AuditOrderWriter;
}

export interface BrokerEventsConsumer {
  close(): void;
}

// ── Implementation ────────────────────────────────────────────────────

const X_CORRELATION_ID = "X-Correlation-Id";

const STATUS_BY_EVENT: Record<BrokerLifecycleEvent["event"], string> = {
  option_assigned: "assigned",
  option_exercised: "exercised",
  option_expired: "expired",
};

const KIND_BY_EVENT: Record<BrokerLifecycleEvent["event"], LifecycleSettlement["kind"]> = {
  option_assigned: "assigned",
  option_exercised: "exercised",
  option_expired: "expired",
};

export function createBrokerEventsConsumer(
  deps: BrokerEventsConsumerDeps,
): BrokerEventsConsumer {
  const { nc, config, logger, engine, auditIntentWriter, auditOrderWriter } = deps;
  const sc = StringCodec();
  const subject = brokerEvents.stream(config.broker);
  const sub = nc.subscribe(subject);

  void (async () => {
    for await (const msg of sub) {
      let event: BrokerLifecycleEvent;
      try {
        event = JSON.parse(sc.decode(msg.data)) as BrokerLifecycleEvent;
      } catch (err) {
        logger.warn("broker-events-consumer: malformed event payload", {
          broker: config.broker,
          error: String(err),
        });
        continue;
      }

      const correlationId = msg.headers?.get(X_CORRELATION_ID) || null;
      try {
        await handleLifecycleEvent(event, correlationId);
      } catch (err) {
        // Don't crash the subscription on a single bad event — the audit
        // gap is observable via reconciliation (§11.7).
        logger.error("broker-events-consumer: handler threw", {
          broker: config.broker,
          event: event.event,
          position_symbol: event.position_symbol,
          error: String(err),
        });
      }
    }
  })();

  async function handleLifecycleEvent(
    event: BrokerLifecycleEvent,
    correlationId: string | null,
  ): Promise<void> {
    const status = STATUS_BY_EVENT[event.event];
    if (!status) {
      logger.warn("broker-events-consumer: unknown event type", {
        event: event.event,
        position_symbol: event.position_symbol,
      });
      return;
    }

    // Thread one correlation_id across the whole chain. Prefer the NATS
    // header (set by the bridge); mint one if the bridge didn't supply it.
    const corr = correlationId ?? ulid();
    const intentId = ulid();
    const orderId = ulid();

    // 1. audit_intents (FK parent for audit_orders — the table enforces
    //    audit_orders.intent_id REFERENCES audit_intents.intent_id).
    await auditIntentWriter(
      buildIntentRow({
        intent_id: intentId,
        signal_ids: [],
        portfolio: config.portfolioId,
        symbol: event.position_symbol,
        // Closing the option leg: inverse of the event's resulting side.
        direction: event.side === "buy" ? "Sell" : "Buy",
        quantity: event.quantity,
        strategy_id: "__operator__",
        created_at: event.asof,
        source: "nt-native",
        correlation_id: corr,
      }),
    );

    // 2. audit_orders (terminal lifecycle state, source=nt-native).
    const orderRow = buildNtNativeOrderRow({
      order_id: orderId,
      intent_id: intentId,
      broker: config.broker,
      status,
      created_at: event.asof,
      broker_order_id: event.broker_position_id ?? "",
      correlation_id: corr,
    });
    orderRow.completed_at = event.asof; // assigned/exercised/expired are terminal
    await auditOrderWriter(orderRow);

    // 3. Position ledger mutation + settlement (§11.3/§11.4).
    const settlement: LifecycleSettlement = {
      option_symbol: event.position_symbol,
      kind: KIND_BY_EVENT[event.event],
      // Worthless expiry closes at 0; assignment/exercise close at the
      // option's settled value (the broker reports the cash impact via the
      // resulting underlying leg, so the option leg itself closes at 0
      // intrinsic and the leg P&L crystallizes against entry).
      option_close_price: 0,
      settlement_type: event.settlement_type,
      cash_delta: null, // derive from the legs (broker truth via cash recon)
      asof: event.asof,
    };
    if (event.settlement_type === "physical") {
      settlement.underlying = {
        symbol: event.underlying_symbol,
        direction: event.side === "buy" ? "Long" : "Short",
        quantity: event.quantity,
        price: event.settlement_price,
      };
    }

    const result = engine.settleLifecycle(config.portfolioId, settlement);

    logger.info("broker-events-consumer: lifecycle event settled", {
      broker: config.broker,
      event: event.event,
      position_symbol: event.position_symbol,
      underlying: canonicalToUnderlying(event.position_symbol),
      status,
      option_closed: result.option_closed,
      realized_pnl: result.realized_pnl,
      underlying_position_id: result.underlying_position_id,
      correlation_id: corr,
    });
  }

  return {
    close(): void {
      // Subscriptions tear down via the NATS connection close; nothing
      // consumer-specific to release here.
    },
  };
}
