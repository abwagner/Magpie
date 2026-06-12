/**
 * Integration test: Data integrity
 *
 * Verifies the audit-trail join chain (fill → order → intent) and
 * audit_orders lifecycle-timestamp consistency.
 *
 * QF-338 — the audit_signals seed + signal-reference assertions were
 * removed (the table was retired in QF-261). The chain now terminates
 * at audit_intents. signal_ids stay on the intent row as raw context.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db.js";

let testDb: TestDb;

describe("data integrity", () => {
  beforeAll(async () => {
    testDb = await createTestDb();

    // Seed audit data to test the join chain. Explicit column lists keep
    // the seed resilient to additive audit-table migrations.
    await testDb.run(
      `INSERT INTO audit_intents
         (intent_id, signal_ids, portfolio, symbol, direction, quantity, strategy_id, created_at)
       VALUES ('intent-1', '["sig-1"]', 'main', 'OPT:SPY:2026-05-16:C:500', 'Short', 1, 'test-strategy', '2026-04-09 14:30:01')`,
    );
    await testDb.run(
      `INSERT INTO audit_orders
         (order_id, intent_id, broker, execution_mode, status, created_at,
          risk_checked_at, approved_at, submitted_at, completed_at, broker_order_id)
       VALUES ('order-1', 'intent-1', 'paper', 'paper_local', 'filled', '2026-04-09 14:30:01',
          '2026-04-09 14:30:01', '2026-04-09 14:30:01', '2026-04-09 14:30:01', '2026-04-09 14:30:02', 'paper-1')`,
    );
    await testDb.run(
      `INSERT INTO audit_fills
         (fill_id, order_id, price, quantity, fees, filled_at, expected_price, slippage)
       VALUES ('fill-1', 'order-1', 12.50, 1, 0.65, '2026-04-09 14:30:02', 12.50, 0.0)`,
    );
  });

  afterAll(() => testDb.close());

  describe("audit trail join chain", () => {
    it("joins fill → order → intent", async () => {
      const rows = await testDb.query(`
        SELECT
          f.fill_id,
          o.order_id,
          i.intent_id,
          i.signal_ids,
          i.strategy_id,
          o.broker,
          f.price,
          f.quantity
        FROM audit_fills f
        JOIN audit_orders o ON f.order_id = o.order_id
        JOIN audit_intents i ON o.intent_id = i.intent_id
        WHERE f.fill_id = 'fill-1'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.fill_id).toBe("fill-1");
      expect(rows[0]!.order_id).toBe("order-1");
      expect(rows[0]!.intent_id).toBe("intent-1");
      expect(rows[0]!.strategy_id).toBe("test-strategy");
      expect(rows[0]!.broker).toBe("paper");
    });

    it("preserves the raw signal_ids on the intent row", async () => {
      const rows = await testDb.query(
        `SELECT signal_ids FROM audit_intents WHERE intent_id = 'intent-1'`,
      );

      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.signal_ids as string)).toEqual(["sig-1"]);
    });
  });

  describe("audit_orders lifecycle timestamps", () => {
    it("has all timestamp columns populated for a filled order", async () => {
      const rows = await testDb.query(
        `SELECT created_at, risk_checked_at, approved_at, submitted_at, completed_at FROM audit_orders WHERE order_id = 'order-1'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.created_at).toBeTruthy();
      expect(rows[0]!.submitted_at).toBeTruthy();
      expect(rows[0]!.completed_at).toBeTruthy();
    });
  });
});
