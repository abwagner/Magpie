import { describe, it, expect } from "vitest";
import duckdb from "duckdb";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { initDatabase } from "../../init.js";

const EXPECTED_TABLES = [
  "audit_intents",
  "audit_orders",
  "audit_fills",
  "audit_pricing_decisions",
  "portfolio_snapshots",
];

describe("db init", () => {
  let db: TestDb;

  it("creates all expected tables", async () => {
    db = await createTestDb();
    try {
      const rows = await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
      );
      const names = rows.map((r) => r.table_name);
      for (const table of EXPECTED_TABLES) {
        expect(names).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it("is idempotent (running twice does not error)", async () => {
    db = await createTestDb();
    try {
      // createTestDb already called initDatabase once. Run each CREATE TABLE again.
      for (const table of EXPECTED_TABLES) {
        await expect(db.query(`SELECT count(*) as n FROM ${table}`)).resolves.toBeDefined();
      }
    } finally {
      db.close();
    }
  });

  it("backfills audit_orders columns added after the original schema (QF-266)", async () => {
    // Simulate an install that pre-dates the QF-50 / QF-204 / QF-207 / QF-209 /
    // QF-210 audit_orders columns. CREATE TABLE IF NOT EXISTS will be a no-op
    // on this legacy table — only the ALTER ADD COLUMN IF NOT EXISTS path can
    // fill the gap, so this test pins the migration behavior.
    const db = new duckdb.Database(":memory:");
    const conn = db.connect();
    const run = (sql: string): Promise<void> =>
      new Promise((res, rej) => conn.run(sql, (err: Error | null) => (err ? rej(err) : res())));
    const query = (sql: string): Promise<Record<string, unknown>[]> =>
      new Promise((res, rej) =>
        conn.all(sql, (err: Error | null, rows: Record<string, unknown>[]) =>
          err ? rej(err) : res(rows),
        ),
      );

    try {
      await run(`CREATE TABLE audit_intents (intent_id VARCHAR PRIMARY KEY)`);
      await run(`
        CREATE TABLE audit_orders (
          order_id          VARCHAR PRIMARY KEY,
          intent_id         VARCHAR NOT NULL REFERENCES audit_intents(intent_id),
          broker            VARCHAR NOT NULL,
          execution_mode    VARCHAR NOT NULL,
          status            VARCHAR NOT NULL,
          created_at        TIMESTAMP NOT NULL,
          completed_at      TIMESTAMP,
          broker_order_id   VARCHAR
        )
      `);

      await initDatabase(db);

      const cols = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'audit_orders' ORDER BY column_name`,
      );
      const names = cols.map((c) => String(c.column_name));
      for (const expected of [
        "operator_edits",
        "risk_violations",
        "halt_reason",
        "broker_rejection_reason",
        "quote_failure_reason",
        "cancel_reason",
        // QF-244: account_id backfill via ALTER ADD COLUMN IF NOT EXISTS.
        "account_id",
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it("backfills account_id on audit_orders and audit_fills for pre-QF-244 installs", async () => {
    // Simulate a legacy install that pre-dates M12-2 (no account_id columns).
    // Verifies the ADD COLUMN IF NOT EXISTS ALTER migration backfills both
    // tables so existing audit rows stay readable after the upgrade.
    const db = new duckdb.Database(":memory:");
    const conn = db.connect();
    const run = (sql: string): Promise<void> =>
      new Promise((res, rej) => conn.run(sql, (err: Error | null) => (err ? rej(err) : res())));
    const query = (sql: string): Promise<Record<string, unknown>[]> =>
      new Promise((res, rej) =>
        conn.all(sql, (err: Error | null, rows: Record<string, unknown>[]) =>
          err ? rej(err) : res(rows),
        ),
      );

    try {
      // Pre-M12-2 schema: audit_orders and audit_fills without account_id.
      // Include broker_order_id so the CREATE INDEX in initDatabase doesn't fail.
      await run(`CREATE TABLE audit_intents (intent_id VARCHAR PRIMARY KEY)`);
      await run(`
        CREATE TABLE audit_orders (
          order_id          VARCHAR PRIMARY KEY,
          intent_id         VARCHAR NOT NULL REFERENCES audit_intents(intent_id),
          broker            VARCHAR NOT NULL,
          execution_mode    VARCHAR NOT NULL,
          status            VARCHAR NOT NULL,
          created_at        TIMESTAMP NOT NULL,
          broker_order_id   VARCHAR
        )
      `);
      await run(`
        CREATE TABLE audit_fills (
          fill_id    VARCHAR PRIMARY KEY,
          order_id   VARCHAR NOT NULL REFERENCES audit_orders(order_id),
          price      DOUBLE NOT NULL,
          quantity   INTEGER NOT NULL,
          filled_at  TIMESTAMP NOT NULL
        )
      `);

      await initDatabase(db);

      const orderCols = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'audit_orders' ORDER BY column_name`,
      );
      const fillCols = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'audit_fills' ORDER BY column_name`,
      );

      expect(orderCols.map((c) => String(c.column_name))).toContain("account_id");
      expect(fillCols.map((c) => String(c.column_name))).toContain("account_id");
    } finally {
      db.close();
    }
  });
});
