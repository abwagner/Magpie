// ── Fake Broker Fixture ────────────────────────────────────────────
// Test double for BrokerAdapter, used by OrderPlane tests now that the
// in-process paper adapter (QF-337) is retired. Replaces the deleted
// createPaperAdapter fixtures in kill-switch / lifecycle integration
// tests with an explicit, controllable fake.
//
// `autoFill: true` synthesizes a fill on submitOrder (the old paper
// simulator behavior the lifecycle test relied on). `autoFill: false`
// just records the submit and leaves the order working — tests drive
// fills/rejections through the returned control handle.

import type {
  BrokerAdapter,
  BrokerOrderStatus,
  BrokerPosition,
  BrokerRejection,
  Fill,
  SubmitOrderParams,
} from "../../../../src/types/order.js";

export interface FakeBrokerOptions {
  // When true, submitOrder schedules a synthesized fill on the next
  // tick (matches the retired paper adapter's setImmediate fill).
  autoFill?: boolean;
  // Price used for synthesized fills (autoFill mode). Default 12.5.
  fillPrice?: number;
  // Fees applied to synthesized fills. Default 0.
  fillFees?: number;
  generateId?: () => string;
}

export interface FakeBroker {
  adapter: BrokerAdapter;
  // Test control surface.
  submittedParams: SubmitOrderParams[];
  cancelledIds: string[];
  emitFill(fill: Omit<Partial<Fill>, "broker_order_id"> & { broker_order_id: string }): void;
  emitRejection(rejection: BrokerRejection): void;
}

export function createFakeBroker(options: FakeBrokerOptions = {}): FakeBroker {
  const autoFill = options.autoFill ?? false;
  const fillPrice = options.fillPrice ?? 12.5;
  const fillFees = options.fillFees ?? 0;
  const generateId =
    options.generateId ?? (() => `fill-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const fillCallbacks: Array<(fill: Fill) => void> = [];
  const rejectionCallbacks: Array<(rejection: BrokerRejection) => void> = [];
  const orderStatus = new Map<string, BrokerOrderStatus>();
  const submittedParams: SubmitOrderParams[] = [];
  const cancelledIds: string[] = [];
  let orderCounter = 0;

  function emitFill(
    partial: Omit<Partial<Fill>, "broker_order_id"> & { broker_order_id: string },
  ): void {
    const fill: Fill = {
      fill_id: partial.fill_id ?? generateId(),
      order_id: partial.order_id ?? partial.broker_order_id,
      intent_id: partial.intent_id ?? "",
      portfolio: partial.portfolio ?? "",
      symbol: partial.symbol ?? "",
      direction: partial.direction ?? "Long",
      quantity: partial.quantity ?? 1,
      price: partial.price ?? fillPrice,
      fees: partial.fees ?? fillFees,
      filled_at: partial.filled_at ?? new Date().toISOString(),
      broker: partial.broker ?? "fake",
      broker_order_id: partial.broker_order_id,
    };
    orderStatus.set(partial.broker_order_id, {
      broker_order_id: partial.broker_order_id,
      status: "filled",
      filled_quantity: fill.quantity,
      average_fill_price: fill.price,
      rejection_reason: null,
    });
    for (const cb of fillCallbacks) cb(fill);
  }

  function emitRejection(rejection: BrokerRejection): void {
    for (const cb of rejectionCallbacks) cb(rejection);
  }

  const adapter: BrokerAdapter = {
    name: "fake",

    async available(): Promise<boolean> {
      return true;
    },

    async submitOrder(params: SubmitOrderParams): Promise<string> {
      submittedParams.push(params);
      const brokerOrderId = `fake-${++orderCounter}`;
      orderStatus.set(brokerOrderId, {
        broker_order_id: brokerOrderId,
        status: "working",
        filled_quantity: 0,
        average_fill_price: null,
        rejection_reason: null,
      });
      if (autoFill) {
        setImmediate(() => {
          try {
            emitFill({
              broker_order_id: brokerOrderId,
              symbol: params.symbol,
              direction: params.direction,
              quantity: params.quantity,
            });
          } catch {
            // Mirror the retired paper adapter: a fill that lands after
            // the test tore down its fill log / temp dir is dropped
            // rather than surfacing as an unhandled rejection.
          }
        });
      }
      return brokerOrderId;
    },

    async cancelOrder(brokerOrderId: string): Promise<void> {
      cancelledIds.push(brokerOrderId);
    },

    async getOrderStatus(brokerOrderId: string): Promise<BrokerOrderStatus> {
      return (
        orderStatus.get(brokerOrderId) ?? {
          broker_order_id: brokerOrderId,
          status: "unknown",
          filled_quantity: 0,
          average_fill_price: null,
          rejection_reason: null,
        }
      );
    },

    async getPositions(): Promise<BrokerPosition[]> {
      return [];
    },

    onFill(callback: (fill: Fill) => void): void {
      fillCallbacks.push(callback);
    },

    onRejection(callback: (rejection: BrokerRejection) => void): void {
      rejectionCallbacks.push(callback);
    },
  };

  return { adapter, submittedParams, cancelledIds, emitFill, emitRejection };
}
