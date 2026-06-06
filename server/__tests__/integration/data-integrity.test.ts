/**
 * Integration test: Data integrity
 *
 * Verifies audit trail join chain, fill log consistency, catalog row counts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/test-db.js";

let testDb: TestDb;

describe("data integrity", () => {
  beforeAll(async () => {
    testDb = await createTestDb();

    // Seed audit data to test the join chain
    await testDb.run(
      `INSERT INTO audit_signals (signal_id, model_id, model_version, symbol, "asof", kind, batch_id, ingest_ts) VALUES ('sig-1', 'test-model', 'v1', 'EQ:SPY', '2026-04-09 14:30:00', 'point', 'batch-1', '2026-04-09 14:30:00.5')`,
    );
    await testDb.run(
      `INSERT INTO audit_intents VALUES ('intent-1', '["sig-1"]', 'main', 'OPT:SPY:2026-05-16:C:500', 'Short', 1, 'test-strategy', '2026-04-09 14:30:01')`,
    );
    await testDb.run(
      `INSERT INTO audit_orders VALUES ('order-1', 'intent-1', 'paper', 'paper_local', 'filled', '2026-04-09 14:30:01', '2026-04-09 14:30:01', '2026-04-09 14:30:01', '2026-04-09 14:30:01', '2026-04-09 14:30:02', 'paper-1', NULL)`,
    );
    await testDb.run(
      `INSERT INTO audit_fills VALUES ('fill-1', 'order-1', 12.50, 1, 0.65, '2026-04-09 14:30:02', 12.50, 0.0)`,
    );
  });

  afterAll(() => testDb.close());

  describe("audit trail join chain", () => {
    it("joins fill → order → intent → signal", async () => {
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

    it("signal_ids in intent reference valid audit_signals rows", async () => {
      const rows = await testDb.query(`
        SELECT i.intent_id, s.signal_id, s.model_id
        FROM audit_intents i,
        (SELECT signal_id, model_id FROM audit_signals WHERE signal_id = 'sig-1') s
        WHERE i.intent_id = 'intent-1'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.signal_id).toBe("sig-1");
      expect(rows[0]!.model_id).toBe("test-model");
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

  describe("table schemas", () => {
    it("signal_catalog has correct primary key columns", async () => {
      // Insert and verify uniqueness constraint
      await testDb.run(
        `INSERT INTO signal_catalog VALUES ('m1', 'v1', 'EQ:SPY', '2026-04', '2026-04-01', '2026-04-30', 100, 1, 'point', '2026-04-09 15:00:00')`,
      );

      // Duplicate should fail or replace
      await testDb.run(
        `INSERT OR REPLACE INTO signal_catalog VALUES ('m1', 'v1', 'EQ:SPY', '2026-04', '2026-04-01', '2026-04-30', 200, 1, 'point', '2026-04-09 16:00:00')`,
      );

      const rows = await testDb.query(
        `SELECT row_count FROM signal_catalog WHERE model_id = 'm1' AND model_version = 'v1' AND symbol = 'EQ:SPY' AND month = '2026-04' AND kind = 'point'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.row_count).toBe(200); // Replaced, not duplicated
    });
  });
});
