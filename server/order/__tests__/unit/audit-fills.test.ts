// QF-208 — audit_fills builder + DuckDB writer tests.

import { describe, it, expect } from "vitest";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { createLogger } from "../../../logger.js";
import { buildFillRow, createAuditFillWriter } from "../../audit-fills.js";
import type { Fill } from "../../../../src/types/order.js";

async function seedParentChain(db: TestDb, intentId: string, orderId: string): Promise<void> {
  await db.run(
    `INSERT INTO audit_intents (intent_id, signal_ids, portfolio, symbol, direction, quantity, strategy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      intentId,
      JSON.stringify(["sig-1"]),
      "main",
      "OPT:SPY:2026-05-16:C:500",
      "Short",
      2,
      "short-straddle-spy",
      "2026-05-18T12:00:00.000Z",
    ],
  );
  await db.run(
    `INSERT INTO audit_orders (order_id, intent_id, broker, execution_mode, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, intentId, "paper", "paper_local", "submitted", "2026-05-18T12:00:00.000Z"],
  );
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    fill_id: "01HW_FILL",
    order_id: "01HW_ORDER",
    broker_order_id: "paper-1",
    symbol: "OPT:SPY:2026-05-16:C:500",
    direction: "Short",
    quantity: 1,
    price: 12.5,
    fees: 0.65,
    filled_at: "2026-05-18T12:00:05.000Z",
    intent_id: "01HW_INTENT",
    portfolio: "main",
    broker: "paper",
    ...overrides,
  };
}

describe("buildFillRow", () => {
  it("computes slippage when an expected_price is supplied (buy filling above ask)", () => {
    const row = buildFillRow({ fill: fill({ price: 12.55 }), expected_price: 12.5 });
    expect(row.slippage).toBeCloseTo(0.05, 5);
    expect(row.expected_price).toBe(12.5);
  });

  it("leaves slippage null when expected_price is absent (market orders)", () => {
    const row = buildFillRow({ fill: fill() });
    expect(row.slippage).toBeNull();
    expect(row.expected_price).toBeNull();
  });

  it("captures fees verbatim (zero is preserved, missing → null)", () => {
    expect(buildFillRow({ fill: fill({ fees: 0 }) }).fees).toBe(0);
    const noFees = fill();
    delete (noFees as Partial<Fill>).fees;
    expect(buildFillRow({ fill: noFees }).fees).toBeNull();
  });

  it("defaults account_id to 'default' when not supplied (M12-2 backward-compat)", () => {
    const row = buildFillRow({ fill: fill() });
    expect(row.account_id).toBe("default");
  });

  it("carries account_id when explicitly provided (M12-3 routing path)", () => {
    const row = buildFillRow({ fill: fill(), account_id: "schwab-acct-7842" });
    expect(row.account_id).toBe("schwab-acct-7842");
  });
});

describe("createAuditFillWriter", () => {
  const log = createLogger("audit-fills-test", "error");

  it("persists a fill row that joins back through audit_orders → audit_intents", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentChain(db, "01HW_INTENT_FILL", "01HW_ORDER_FILL");
      const writer = createAuditFillWriter(db.db, log);
      await writer(
        buildFillRow({
          fill: fill({ fill_id: "01HW_FILL_1", order_id: "01HW_ORDER_FILL" }),
          expected_price: 12.5,
        }),
      );
      const rows = await db.query(
        `SELECT f.fill_id, o.intent_id
         FROM audit_fills f JOIN audit_orders o ON f.order_id = o.order_id
         WHERE f.fill_id = ?`,
        ["01HW_FILL_1"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fill_id).toBe("01HW_FILL_1");
      expect(rows[0]!.intent_id).toBe("01HW_INTENT_FILL");
    } finally {
      db.close();
    }
  });

  it("persists account_id on the fill row", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentChain(db, "01HW_INTENT_ACCT", "01HW_ORDER_ACCT");
      const writer = createAuditFillWriter(db.db, log);
      await writer(
        buildFillRow({
          fill: fill({ fill_id: "01HW_FILL_ACCT", order_id: "01HW_ORDER_ACCT" }),
          account_id: "schwab-acct-9999",
        }),
      );
      const rows = await db.query("SELECT account_id FROM audit_fills WHERE fill_id = ?", [
        "01HW_FILL_ACCT",
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.account_id).toBe("schwab-acct-9999");
    } finally {
      db.close();
    }
  });

  it("rejects when order_id FK does not exist", async () => {
    const db: TestDb = await createTestDb();
    try {
      const writer = createAuditFillWriter(db.db, log);
      await expect(
        writer(buildFillRow({ fill: fill({ order_id: "01HW_DOES_NOT_EXIST" }) })),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("supports multiple fills per order_id (partial-fill case)", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentChain(db, "01HW_INTENT_MULTI", "01HW_ORDER_MULTI");
      const writer = createAuditFillWriter(db.db, log);
      await writer(
        buildFillRow({
          fill: fill({ fill_id: "01HW_PART_1", order_id: "01HW_ORDER_MULTI", quantity: 1 }),
        }),
      );
      await writer(
        buildFillRow({
          fill: fill({ fill_id: "01HW_PART_2", order_id: "01HW_ORDER_MULTI", quantity: 1 }),
        }),
      );
      const rows = await db.query(
        `SELECT fill_id FROM audit_fills WHERE order_id = ? ORDER BY fill_id`,
        ["01HW_ORDER_MULTI"],
      );
      expect(rows).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
