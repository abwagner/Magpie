// ── Paper Fill Adapter ─────────────────────────────────────────────
// Simulates fills using the existing fill model. No broker connection.
// Defined in: docs/tdd/order-execution.md, §4

import type {
  BrokerAdapter,
  BrokerOrderStatus,
  BrokerRejection,
  Fill,
  SubmitOrderParams,
  BrokerPosition,
} from "../../../src/types/order.js";
import { computeFillPrice } from "../fill-model.js";

// ── Types ──────────────────────────────────────────────────────────

export interface CommissionConfig {
  per_contract: number;
  per_order_min: number;
  exchange_per_contract: number;
  exercise_assignment: number;
  notes?: string;
}

// ── Default broker commission schedules ───────────────────────────
// Override via config/commissions.json or per-portfolio config.
// Sources:
//   IBKR: https://www.interactivebrokers.com/en/pricing/commissions-options.php
//   Schwab: https://www.schwab.com/pricing

export const BROKER_COMMISSIONS: Record<string, CommissionConfig> = {
  "ibkr-tiered": {
    per_contract: 0.65,
    per_order_min: 1.0,
    exchange_per_contract: 0.05,
    exercise_assignment: 0,
    notes:
      "IBKR Tiered: $0.65/contract (≤10k/mo), exchange+reg ~$0.03-0.06 varies by exchange. Using $0.05 avg.",
  },
  "ibkr-fixed": {
    per_contract: 0.65,
    per_order_min: 1.0,
    exchange_per_contract: 0,
    exercise_assignment: 0,
    notes: "IBKR Fixed: $0.65/contract all-in (exchange fees included). $1.00 min per order.",
  },
  schwab: {
    per_contract: 0.65,
    per_order_min: 0,
    exchange_per_contract: 0.01,
    exercise_assignment: 0,
    notes:
      "Schwab/thinkorswim: $0 base + $0.65/contract. No exercise/assignment fee. ~$0.01 reg fees.",
  },
  tastytrade: {
    per_contract: 1.0,
    per_order_min: 0,
    exchange_per_contract: 0.01,
    exercise_assignment: 0,
    notes: "tastytrade: $1.00/contract to open, $0 to close. Capped at $10/leg.",
  },
  zero: {
    per_contract: 0,
    per_order_min: 0,
    exchange_per_contract: 0,
    exercise_assignment: 0,
    notes: "No commissions (for testing).",
  },
};

interface PaperConfig {
  slippage?: number;
  broker?: string;
  commissions?: CommissionConfig;
}

interface MarketDataProvider {
  getQuote(symbol: string): Promise<{ bid: number; ask: number; mid: number }>;
}

// ── Implementation ─────────────────────────────────────────────────

export function createPaperAdapter(
  config: PaperConfig,
  marketData: MarketDataProvider,
  generateId: () => string,
): BrokerAdapter {
  const slippage = config.slippage ?? 0.75;
  const commissions =
    config.commissions ??
    BROKER_COMMISSIONS[config.broker ?? "ibkr-tiered"] ??
    BROKER_COMMISSIONS["ibkr-tiered"]!;
  const fillCallbacks: Array<(fill: Fill) => void> = [];
  // QF-209 — paper has no real "broker rejects after submit" condition
  // today; we still wire the callback array so test harnesses can
  // synthesize rejections via the returned `__rejectForTest__` helper.
  const rejectionCallbacks: Array<(rejection: BrokerRejection) => void> = [];
  // QF-234 — per-order status the getOrderStatus() observation hook
  // can return. Populated on submitOrder; mutated to "filled" by the
  // synthesized fill in the setImmediate below. Unknown broker_order_id
  // returns status: "unknown" (the QF-230 reconciliation contract for
  // "QF has no record" rows).
  const orderStatus = new Map<string, BrokerOrderStatus>();
  let orderCounter = 0;

  function computeFees(quantity: number): number {
    const perContract = commissions.per_contract + (commissions.exchange_per_contract ?? 0);
    const total = perContract * quantity;
    return Math.max(total, commissions.per_order_min ?? 0);
  }

  function fillPriceForQuote(
    bid: number,
    ask: number,
    direction: string,
    quantity: number = 1,
  ): number {
    const result = computeFillPrice({
      bid,
      ask,
      direction: direction === "Long" || direction === "buy" ? "buy" : "sell",
      quantity,
    });
    return result.price;
  }

  return {
    name: "paper",

    async available(): Promise<boolean> {
      return true;
    },

    async submitOrder(params: SubmitOrderParams): Promise<string> {
      const brokerOrderId = `paper-${++orderCounter}`;
      orderStatus.set(brokerOrderId, {
        broker_order_id: brokerOrderId,
        status: "working",
        filled_quantity: 0,
        average_fill_price: null,
        rejection_reason: null,
      });

      // Simulate fill asynchronously (but quickly)
      setImmediate(async () => {
        try {
          const quote = await marketData.getQuote(params.symbol);
          const price = fillPriceForQuote(quote.bid, quote.ask, params.direction, params.quantity);

          const fill: Fill = {
            fill_id: generateId(),
            order_id: brokerOrderId,
            intent_id: "",
            portfolio: "",
            symbol: params.symbol,
            direction: params.direction,
            quantity: params.quantity,
            price,
            fees: computeFees(params.quantity),
            filled_at: new Date().toISOString(),
            broker: "paper",
            broker_order_id: brokerOrderId,
          };

          orderStatus.set(brokerOrderId, {
            broker_order_id: brokerOrderId,
            status: "filled",
            filled_quantity: params.quantity,
            average_fill_price: price,
            rejection_reason: null,
          });

          for (const cb of fillCallbacks) {
            cb(fill);
          }
        } catch {
          // Paper adapter silently drops fills on market data failure
        }
      });

      return brokerOrderId;
    },

    async cancelOrder(_brokerOrderId: string): Promise<void> {
      // Paper orders fill instantly, nothing to cancel
    },

    // QF-234 — observation hook (restart reconciliation, QF-230).
    // Paper tracks per-submit state in `orderStatus`; unknown IDs return
    // status: "unknown" to match the cross-broker contract.
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
      // Paper adapter has no persistent state
      return [];
    },

    onFill(callback: (fill: Fill) => void): void {
      fillCallbacks.push(callback);
    },

    onRejection(callback: (rejection: BrokerRejection) => void): void {
      rejectionCallbacks.push(callback);
    },

    // QF-209 — test-only escape hatch so unit tests can synthesize an
    // async broker rejection without standing up a real broker. The
    // production OrderPlane never reaches into this; the type widens
    // BrokerAdapter on a per-adapter basis (see PaperBrokerAdapter).
    __rejectForTest__(rejection: BrokerRejection): void {
      for (const cb of rejectionCallbacks) cb(rejection);
    },
  } as BrokerAdapter & { __rejectForTest__(rejection: BrokerRejection): void };
}
