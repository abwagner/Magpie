// ── Disconnected Broker Adapter ────────────────────────────────────
// Fallback adapter the OrderPlane holds when no real broker is wired.
// Defined in: docs/tdd/order-execution.md, §3 "No paper adapter".
//
// QF-337 retired the in-process paper fill simulator. Paper-vs-live is
// now a deploy-target distinction: the Python NT bundle connects to
// paper or live credentials and QF's TS side talks to it through
// nt-bridge.ts. With no broker enabled in brokers.json there is no
// execution transport at all, so this adapter exists only to satisfy
// the OrderPlane's required BrokerAdapter contract.
//
// It never fabricates fills. submitOrder / cancelOrder throw, which
// drives the order to "submission_failed" — the honest state for an
// OPL with no broker behind it. To execute orders locally, operators
// run the paper-credentialed bundle (strategy-deployment-topology.md
// §2 paper-live) which enables a broker and wires the real nt-bridge
// adapter instead of this one.

import type {
  BrokerAdapter,
  BrokerOrderStatus,
  BrokerPosition,
  BrokerRejection,
  Fill,
} from "../../../src/types/order.js";

export function createDisconnectedAdapter(): BrokerAdapter {
  function refuse(): never {
    throw new Error(
      "no broker configured: enable a broker in brokers.json or run the paper-credentialed NT bundle",
    );
  }

  return {
    name: "disconnected",

    async available(): Promise<boolean> {
      return false;
    },

    async submitOrder(): Promise<string> {
      return refuse();
    },

    async cancelOrder(): Promise<void> {
      refuse();
    },

    async getOrderStatus(brokerOrderId: string): Promise<BrokerOrderStatus> {
      return {
        broker_order_id: brokerOrderId,
        status: "unknown",
        filled_quantity: 0,
        average_fill_price: null,
        rejection_reason: null,
      };
    },

    async getPositions(): Promise<BrokerPosition[]> {
      return [];
    },

    // No transport means no fills or rejections ever arrive; the
    // callbacks are accepted (so OPL wires up uniformly) and dropped.
    onFill(_callback: (fill: Fill) => void): void {},

    onRejection(_callback: (rejection: BrokerRejection) => void): void {},
  };
}
