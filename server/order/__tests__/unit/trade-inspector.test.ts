// QF-215 — Trade Inspector: read-only join across the audit tables.
// QF-338 — audit_pricing_decisions + audit_signals retired; the inspector
// now joins intent → order → fill only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTradeInspector,
  TradeInspectorNotFoundError,
  type TradeInspector,
} from "../../trade-inspector.js";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";

// ── DB seed helpers ───────────────────────────────────────────────────

async function seedIntent(
  tdb: TestDb,
  args: {
    intent_id: string;
    signal_ids: string[];
    portfolio?: string;
    symbol?: string;
    strategy_id?: string;
  },
): Promise<void> {
  await tdb.run(
    `INSERT INTO audit_intents
       (intent_id, signal_ids, portfolio, symbol, direction, quantity, strategy_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.intent_id,
      JSON.stringify(args.signal_ids),
      args.portfolio ?? "main",
      args.symbol ?? "OPT:SPY:2026-06-19:C:500",
      "Short",
      1,
      args.strategy_id ?? "vol-buyer-spy",
      "2026-05-19T12:00:02.000Z",
    ],
  );
}

async function seedOrder(
  tdb: TestDb,
  args: { order_id: string; intent_id: string; status?: string; account_id?: string },
): Promise<void> {
  const accountId = args.account_id ?? "default";
  await tdb.run(
    `INSERT INTO audit_orders
       (order_id, intent_id, broker, execution_mode, status, created_at,
        risk_checked_at, approved_at, submitted_at, completed_at,
        broker_order_id, operator_edits, risk_violations,
        halt_reason, broker_rejection_reason, quote_failure_reason,
        account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.order_id,
      args.intent_id,
      "paper",
      "paper_local",
      args.status ?? "filled",
      "2026-05-19T12:00:03.000Z",
      "2026-05-19T12:00:03.100Z",
      "2026-05-19T12:00:03.200Z",
      "2026-05-19T12:00:03.300Z",
      "2026-05-19T12:00:04.000Z",
      "broker-abc-123",
      null,
      null,
      null,
      null,
      null,
      accountId,
    ],
  );
}

async function seedFill(
  tdb: TestDb,
  args: {
    fill_id: string;
    order_id: string;
    price?: number;
    expected_price?: number | null;
    account_id?: string;
  },
): Promise<void> {
  const price = args.price ?? 12.5;
  const expected = args.expected_price ?? 12.5;
  const slippage = expected === null ? null : price - expected;
  const accountId = args.account_id ?? "default";
  await tdb.run(
    `INSERT INTO audit_fills
       (fill_id, order_id, price, quantity, fees, filled_at, expected_price, slippage, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.fill_id,
      args.order_id,
      price,
      1,
      0.5,
      "2026-05-19T12:00:04.000Z",
      expected,
      slippage,
      accountId,
    ],
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("TradeInspector.inspect", () => {
  let tdb: TestDb;
  let inspector: TradeInspector;

  beforeEach(async () => {
    tdb = await createTestDb();
    inspector = createTradeInspector(tdb.db, createTestLogger());
  });

  afterEach(() => {
    tdb.close();
  });

  it("returns the audit chain (intent → order → fill) for a complete fill", async () => {
    await seedIntent(tdb, { intent_id: "int-1", signal_ids: ["sig-1"] });
    await seedOrder(tdb, { order_id: "ord-1", intent_id: "int-1" });
    await seedFill(tdb, { fill_id: "fill-1", order_id: "ord-1", price: 12.55 });

    const result = await inspector.inspect("fill-1");

    expect(result.fill.fill_id).toBe("fill-1");
    expect(result.fill.price).toBe(12.55);
    expect(result.fill.slippage).toBeCloseTo(0.05, 5);
    expect(result.order.order_id).toBe("ord-1");
    expect(result.order.status).toBe("filled");
    expect(result.intent.intent_id).toBe("int-1");
    expect(result.intent.symbol).toBe("OPT:SPY:2026-06-19:C:500");
  });

  it("surfaces the raw signal_ids on the intent row", async () => {
    // audit_signals retired (QF-338) — signal_ids are no longer joined into
    // a signal, but the raw ids stay on the intent for forensic context.
    await seedIntent(tdb, { intent_id: "int-1", signal_ids: ["sig-1", "sig-2"] });
    await seedOrder(tdb, { order_id: "ord-1", intent_id: "int-1" });
    await seedFill(tdb, { fill_id: "fill-1", order_id: "ord-1" });

    const result = await inspector.inspect("fill-1");
    expect(result.intent.signal_ids).toEqual(["sig-1", "sig-2"]);
  });

  it("surfaces an empty signal_ids array when the intent had no signals", async () => {
    await seedIntent(tdb, { intent_id: "int-1", signal_ids: [] });
    await seedOrder(tdb, { order_id: "ord-1", intent_id: "int-1" });
    await seedFill(tdb, { fill_id: "fill-1", order_id: "ord-1" });

    const result = await inspector.inspect("fill-1");
    expect(result.intent.signal_ids).toEqual([]);
  });

  it("surfaces rejection reasons (risk_violations, halt_reason, broker_rejection_reason)", async () => {
    await seedIntent(tdb, { intent_id: "int-1", signal_ids: ["sig-1"] });
    // Manually update audit_orders to a rejected_by_broker state with a reason.
    await seedOrder(tdb, { order_id: "ord-1", intent_id: "int-1", status: "rejected_by_broker" });
    await tdb.run(
      `UPDATE audit_orders SET
         broker_rejection_reason = ?,
         risk_violations = ?
       WHERE order_id = ?`,
      [
        "Symbol not found",
        JSON.stringify([{ limit: "max_order_size", current: 20, max: 10 }]),
        "ord-1",
      ],
    );
    await seedFill(tdb, { fill_id: "fill-1", order_id: "ord-1" });

    const result = await inspector.inspect("fill-1");
    expect(result.order.status).toBe("rejected_by_broker");
    expect(result.order.broker_rejection_reason).toBe("Symbol not found");
    const violations = result.order.risk_violations as Array<{ limit: string }>;
    expect(violations[0]!.limit).toBe("max_order_size");
  });

  it("throws TradeInspectorNotFoundError for an unknown fill_id", async () => {
    await expect(inspector.inspect("does-not-exist")).rejects.toBeInstanceOf(
      TradeInspectorNotFoundError,
    );
  });

  it("surfaces account_id on both the order and fill rows (QF-244 multi-account smoke)", async () => {
    await seedIntent(tdb, { intent_id: "int-1", signal_ids: ["sig-1"] });
    await seedOrder(tdb, {
      order_id: "ord-1",
      intent_id: "int-1",
      account_id: "schwab-acct-7842",
    });
    await seedFill(tdb, {
      fill_id: "fill-1",
      order_id: "ord-1",
      account_id: "schwab-acct-7842",
    });

    const result = await inspector.inspect("fill-1");

    expect(result.order.account_id).toBe("schwab-acct-7842");
    expect(result.fill.account_id).toBe("schwab-acct-7842");
  });
});
