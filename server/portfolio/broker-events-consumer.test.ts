// QF-309 — broker lifecycle events consumer:
//  - subscribes to broker.events.<broker>
//  - writes audit_intents (FK parent) + audit_orders (terminal status)
//  - mutates the position ledger via PortfolioEngine.settleLifecycle
//  - threads correlation_id from NATS headers
//
// Uses an in-memory NATS fake mirroring nt-observer-consumer.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StringCodec } from "nats";
import type { BrokerLifecycleEvent } from "../../src/types/broker-lifecycle.js";
import type { Logger } from "../logger.js";
import type { AuditIntentRow } from "../order/audit-intent.js";
import type { AuditOrderRow } from "../order/audit-orders.js";
import type { PortfolioConfig } from "../../src/types/portfolio.js";
import { createPortfolioEngine } from "./engine.js";
import { createBrokerEventsConsumer } from "./broker-events-consumer.js";

// ── Mock logger ────────────────────────────────────────────────────

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

// ── Fake NATS (subscribe + headers) ──────────────────────────────────

const sc = StringCodec();

interface FakeMsg {
  data: Uint8Array;
  headers?: { get(key: string): string | undefined };
}
interface FakeSub {
  pump(msg: FakeMsg): void;
}

function makeFakeNats() {
  const subscribers = new Map<string, FakeSub>();
  function subscribe(subject: string) {
    const queue: FakeMsg[] = [];
    let resolveNext: ((v: IteratorResult<FakeMsg>) => void) | null = null;
    const sub: FakeSub = {
      pump(msg) {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: msg, done: false });
        } else {
          queue.push(msg);
        }
      },
    };
    subscribers.set(subject, sub);
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<FakeMsg>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            return new Promise((r) => {
              resolveNext = r;
            });
          },
        };
      },
    };
  }
  return {
    isClosed: () => false,
    subscribe,
    async pumpEvent(
      subject: string,
      event: BrokerLifecycleEvent,
      headersMap?: Record<string, string>,
    ): Promise<void> {
      const sub = subscribers.get(subject);
      if (!sub) throw new Error(`no subscriber for ${subject}`);
      const msg: FakeMsg = { data: sc.encode(JSON.stringify(event)) };
      if (headersMap) msg.headers = { get: (k) => headersMap[k] };
      sub.pump(msg);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<BrokerLifecycleEvent> = {}): BrokerLifecycleEvent {
  return {
    broker: "schwab",
    event: "option_assigned",
    position_symbol: "OPT:SPY:2026-05-16:C:500",
    underlying_symbol: "EQ:SPY",
    side: "sell",
    quantity: 100,
    settlement_price: 500.0,
    settlement_type: "physical",
    asof: "2026-05-16T20:00:00Z",
    broker_position_id: "pos-123",
    ...overrides,
  };
}

const PORTFOLIO_CONFIG = {
  initial_cash: 100_000,
  limits: {
    max_net_delta: null,
    max_net_vega: null,
    max_daily_loss: null,
    max_symbol_concentration: null,
    max_drawdown: null,
    max_order_size: null,
    max_open_orders: null,
  },
} as PortfolioConfig;

describe("broker-events-consumer (QF-309)", () => {
  let fakeNats: ReturnType<typeof makeFakeNats>;
  let engine: ReturnType<typeof createPortfolioEngine>;
  let writtenIntents: AuditIntentRow[];
  let writtenOrders: AuditOrderRow[];
  const SUBJECT = "broker.events.schwab";

  beforeEach(() => {
    vi.clearAllMocks();
    fakeNats = makeFakeNats();
    engine = createPortfolioEngine({ logger: mockLogger });
    engine.initPortfolio("main", PORTFOLIO_CONFIG);
    writtenIntents = [];
    writtenOrders = [];
    createBrokerEventsConsumer({
      nc: fakeNats as never,
      config: { broker: "schwab", portfolioId: "main" },
      logger: mockLogger,
      engine,
      auditIntentWriter: async (row) => {
        writtenIntents.push(row);
      },
      auditOrderWriter: async (row) => {
        writtenOrders.push(row);
      },
    });
  });

  // Seed a short option position the assignment will close.
  function seedShortCall(): void {
    engine.applyFill("main", {
      fill_id: "OPT:SPY:2026-05-16:C:500",
      order_id: "o-1",
      intent_id: "i-1",
      portfolio: "main",
      symbol: "OPT:SPY:2026-05-16:C:500",
      direction: "Short",
      quantity: 1,
      price: 3.0,
      fees: 0,
      filled_at: "2026-05-01",
      broker: "schwab",
    } as never);
  }

  it("writes audit_intents + audit_orders and closes the option on assignment", async () => {
    seedShortCall();
    await fakeNats.pumpEvent(SUBJECT, makeEvent({ event: "option_assigned" }));

    expect(writtenIntents).toHaveLength(1);
    expect(writtenOrders).toHaveLength(1);
    expect(writtenOrders[0]).toMatchObject({
      status: "assigned",
      source: "nt-native",
      broker: "schwab",
      broker_order_id: "pos-123",
    });
    // FK linkage + correlation threading.
    expect(writtenOrders[0]!.intent_id).toBe(writtenIntents[0]!.intent_id);
    expect(writtenOrders[0]!.correlation_id).toBe(writtenIntents[0]!.correlation_id);

    // Option position is gone; physical settlement opened the short
    // underlying leg (side=sell → Short EQ:SPY).
    const positions = engine.getState("main").positions;
    expect(positions.find((p) => p.symbol === "OPT:SPY:2026-05-16:C:500")).toBeUndefined();
    const underlying = positions.find((p) => p.symbol === "EQ:SPY");
    expect(underlying).toMatchObject({ direction: "Short", quantity: 100, entry_price: 500 });
  });

  it("threads correlation_id from the NATS header", async () => {
    seedShortCall();
    await fakeNats.pumpEvent(SUBJECT, makeEvent(), { "X-Correlation-Id": "CORR-XYZ" });
    expect(writtenIntents[0]!.correlation_id).toBe("CORR-XYZ");
    expect(writtenOrders[0]!.correlation_id).toBe("CORR-XYZ");
  });

  it("maps exercise events to status=exercised and opens a long underlying", async () => {
    engine.applyFill("main", {
      fill_id: "OPT:SPY:2026-05-16:C:500",
      order_id: "o",
      intent_id: "i",
      portfolio: "main",
      symbol: "OPT:SPY:2026-05-16:C:500",
      direction: "Long",
      quantity: 1,
      price: 2.0,
      fees: 0,
      filled_at: "2026-05-01",
      broker: "schwab",
    } as never);
    await fakeNats.pumpEvent(
      SUBJECT,
      makeEvent({ event: "option_exercised", side: "buy" }),
    );
    expect(writtenOrders[0]!.status).toBe("exercised");
    const underlying = engine.getState("main").positions.find((p) => p.symbol === "EQ:SPY");
    expect(underlying).toMatchObject({ direction: "Long", quantity: 100 });
  });

  it("cash settlement closes the option without opening an underlying", async () => {
    seedShortCall();
    await fakeNats.pumpEvent(
      SUBJECT,
      makeEvent({ event: "option_expired", settlement_type: "cash" }),
    );
    expect(writtenOrders[0]!.status).toBe("expired");
    const positions = engine.getState("main").positions;
    expect(positions.find((p) => p.symbol === "EQ:SPY")).toBeUndefined();
    expect(positions.find((p) => p.symbol.startsWith("OPT:"))).toBeUndefined();
  });

  it("logs and skips unknown event types without throwing", async () => {
    await fakeNats.pumpEvent(SUBJECT, makeEvent({ event: "garbage" as never }));
    expect(writtenOrders).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "broker-events-consumer: unknown event type",
      expect.any(Object),
    );
  });

  it("still records the audit row + opens underlying when the option is unknown to QF", async () => {
    // No seed: broker pushes an assignment for a position QF never opened.
    await fakeNats.pumpEvent(SUBJECT, makeEvent({ event: "option_assigned", side: "buy" }));
    expect(writtenOrders).toHaveLength(1);
    expect(writtenOrders[0]!.status).toBe("assigned");
    // Physical settlement still opens the underlying leg per §11.7.
    expect(
      engine.getState("main").positions.find((p) => p.symbol === "EQ:SPY"),
    ).toMatchObject({ direction: "Long", quantity: 100 });
  });
});
