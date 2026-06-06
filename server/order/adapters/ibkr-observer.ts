// ── IBKR Observation Adapter ──────────────────────────────────────
// IBKR orders are submitted by NT against whichever IB Gateway session
// is logged in — QF does NOT call ib.placeOrder, and never will. QF's
// role is observation: receive fill notifications for orders NT placed;
// query order/position state for restart reconciliation (QF-230).
//
// Implementation is a narrowed view of the NT-bridge adapter (QF-233).
// The Python NT-side service publishes IBKR exec reports on
// orders.exec_reports.ibkr alongside Schwab's; getOrderStatus /
// getPositions are NATS requests against the same broker-suffixed
// subject layout. See docs/tdd/broker-integration.md §2.3 + §3.
//
// QF-235.

import type { NatsConnection } from "nats";
import type {
  BrokerOrderStatus,
  BrokerPosition,
  BrokerRejection,
  Fill,
  OrderObservationAdapter,
} from "../../../src/types/order.js";
import type { Logger } from "../../logger.js";
import { createNtBridgeAdapter, type NtBridgeConfig } from "./nt-bridge.js";

// ── Config ─────────────────────────────────────────────────────────

export interface IbkrObserverConfig {
  // Reply timeout for status / positions queries. Same default as the
  // NT bridge: 2s. Broker submission is out of scope, so there's no
  // submitTimeoutMs equivalent.
  queryTimeoutMs?: number;
}

// ── Factory ────────────────────────────────────────────────────────

export function createIbkrObserverAdapter(
  nc: NatsConnection,
  config: IbkrObserverConfig,
  logger: Logger,
): OrderObservationAdapter {
  const bridgeConfig: NtBridgeConfig = {
    broker: "ibkr",
    ...(config.queryTimeoutMs !== undefined ? { queryTimeoutMs: config.queryTimeoutMs } : {}),
  };
  const bridge = createNtBridgeAdapter(nc, bridgeConfig, logger);

  // Return only the observation half of the bridge. submitOrder /
  // cancelOrder are deliberately not exposed — the type narrowing
  // is what enforces "QF doesn't submit IBKR orders".
  return {
    name: bridge.name,
    available: bridge.available,
    async getOrderStatus(brokerOrderId: string): Promise<BrokerOrderStatus> {
      return bridge.getOrderStatus(brokerOrderId);
    },
    async getPositions(): Promise<BrokerPosition[]> {
      return bridge.getPositions();
    },
    onFill(callback: (fill: Fill) => void): void {
      bridge.onFill(callback);
    },
    onRejection(callback: (rejection: BrokerRejection) => void): void {
      bridge.onRejection?.(callback);
    },
  };
}
