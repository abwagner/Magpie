// QF-207 — audit_orders builder + DuckDB upsert writer.
// Spec: docs/tdd/order-flow.md §3 (state machine) + §7.2.

import { describe, it, expect } from "vitest";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { createLogger } from "../../../logger.js";
import { buildOrderRow, createAuditOrderWriter } from "../../audit-orders.js";
import type { Order, Violation } from "../../../../src/types/order.js";

// ── Fixtures ──────────────────────────────────────────────────────────

async function seedParentIntent(db: TestDb, intentId: string): Promise<void> {
  await db.run(
    `INSERT INTO audit_intents (intent_id, signal_ids, portfolio, symbol, direction, quantity, strategy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      intentId,
      JSON.stringify(["sig-1"]),
      "main",
      "OPT:SPY:2026-05-16:C:500",
      "Short",
      1,
      "short-straddle-spy",
      "2026-05-18T12:00:00.000Z",
    ],
  );
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "01HW_ORDER_A",
    intent_id: "01HW_INTENT_A",
    // QF-310: defaults to intent_id when overrides don't supply a value;
    // mirrors OPL's intent_id-fallback derivation for tests that don't
    // care about the broker idempotency surface.
    client_order_id: "01HW_INTENT_A",
    portfolio: "main",
    broker: "paper",
    execution_mode: "paper_local",
    status: "risk_check",
    created_at: "2026-05-18T12:00:00.000Z",
    ...overrides,
  };
}

// ── buildOrderRow ─────────────────────────────────────────────────────

describe("buildOrderRow", () => {
  it("captures lifecycle timestamps when present", () => {
    const row = buildOrderRow({
      order: order({
        status: "submitted",
        risk_checked_at: "2026-05-18T12:00:01.000Z",
        approved_at: "2026-05-18T12:00:02.000Z",
        submitted_at: "2026-05-18T12:00:03.000Z",
        broker_order_id: "paper-1",
      }),
    });
    expect(row.status).toBe("submitted");
    expect(row.risk_checked_at).toBe("2026-05-18T12:00:01.000Z");
    expect(row.approved_at).toBe("2026-05-18T12:00:02.000Z");
    expect(row.submitted_at).toBe("2026-05-18T12:00:03.000Z");
    expect(row.broker_order_id).toBe("paper-1");
    expect(row.completed_at).toBeNull();
  });

  it("nulls out missing timestamps (DuckDB-friendly)", () => {
    const row = buildOrderRow({ order: order() });
    expect(row.risk_checked_at).toBeNull();
    expect(row.approved_at).toBeNull();
    expect(row.submitted_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.broker_order_id).toBeNull();
  });

  it("serializes operator_edits as JSON when present, null otherwise", () => {
    const withEdits = buildOrderRow({
      order: order({ operator_edits: { limit_price: 12.55, time_in_force: "gtc" } }),
    });
    expect(JSON.parse(withEdits.operator_edits!)).toEqual({
      limit_price: 12.55,
      time_in_force: "gtc",
    });

    const without = buildOrderRow({ order: order() });
    expect(without.operator_edits).toBeNull();
  });

  it("serializes risk_violations as JSON array", () => {
    const v: Violation[] = [
      { limit: "max_order_size", current: 5, proposed: 20, threshold: 10, action: "reject" },
    ];
    const row = buildOrderRow({
      order: order({ status: "rejected", completed_at: "2026-05-18T12:00:01.000Z" }),
      risk_violations: v,
    });
    expect(JSON.parse(row.risk_violations!)).toEqual(v);
    expect(row.halt_reason).toBeNull();
  });

  it("captures halt_reason for kill-switch rejections", () => {
    const row = buildOrderRow({
      order: order({ status: "rejected", completed_at: "2026-05-18T12:00:01.000Z" }),
      halt_reason: "manual kill — bad data",
    });
    expect(row.halt_reason).toBe("manual kill — bad data");
    expect(row.risk_violations).toBeNull();
  });

  it("defaults account_id to 'default' when not supplied (M12-2 backward-compat)", () => {
    const row = buildOrderRow({ order: order() });
    expect(row.account_id).toBe("default");
  });

  it("carries account_id when explicitly provided (M12-3 routing path)", () => {
    const row = buildOrderRow({ order: order(), account_id: "schwab-acct-7842" });
    expect(row.account_id).toBe("schwab-acct-7842");
  });
});

// ── createAuditOrderWriter ───────────────────────────────────────────

describe("createAuditOrderWriter (upsert)", () => {
  const log = createLogger("audit-orders-test", "error");

  it("inserts on first write", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentIntent(db, "01HW_INTENT_INSERT");
      const writer = createAuditOrderWriter(db.db, log);
      await writer(
        buildOrderRow({
          order: order({ order_id: "01HW_ORDER_INSERT", intent_id: "01HW_INTENT_INSERT" }),
        }),
      );
      const rows = await db.query("SELECT * FROM audit_orders WHERE order_id = ?", [
        "01HW_ORDER_INSERT",
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("risk_check");
    } finally {
      db.close();
    }
  });

  it("updates on second write with the same order_id (idempotent transition)", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentIntent(db, "01HW_INTENT_UPDATE");
      const writer = createAuditOrderWriter(db.db, log);
      const orderId = "01HW_ORDER_UPDATE";
      const intentId = "01HW_INTENT_UPDATE";

      // First state: risk_check
      await writer(buildOrderRow({ order: order({ order_id: orderId, intent_id: intentId }) }));

      // Second state: submitted — same order_id
      await writer(
        buildOrderRow({
          order: order({
            order_id: orderId,
            intent_id: intentId,
            status: "submitted",
            risk_checked_at: "2026-05-18T12:00:01.000Z",
            approved_at: "2026-05-18T12:00:02.000Z",
            submitted_at: "2026-05-18T12:00:03.000Z",
            broker_order_id: "paper-1",
          }),
        }),
      );

      // Third state: filled
      await writer(
        buildOrderRow({
          order: order({
            order_id: orderId,
            intent_id: intentId,
            status: "filled",
            risk_checked_at: "2026-05-18T12:00:01.000Z",
            approved_at: "2026-05-18T12:00:02.000Z",
            submitted_at: "2026-05-18T12:00:03.000Z",
            completed_at: "2026-05-18T12:00:05.000Z",
            broker_order_id: "paper-1",
          }),
        }),
      );

      // Only one row in the table (snapshot, not append-only).
      const rows = await db.query("SELECT * FROM audit_orders WHERE order_id = ?", [orderId]);
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r.status).toBe("filled");
      expect(r.broker_order_id).toBe("paper-1");
    } finally {
      db.close();
    }
  });

  it("persists risk_violations on a risk-check rejection", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentIntent(db, "01HW_INTENT_RISK");
      const writer = createAuditOrderWriter(db.db, log);
      await writer(
        buildOrderRow({
          order: order({
            order_id: "01HW_ORDER_RISK",
            intent_id: "01HW_INTENT_RISK",
            status: "rejected",
            completed_at: "2026-05-18T12:00:01.000Z",
          }),
          risk_violations: [
            { limit: "max_net_delta", current: 45, proposed: 55, threshold: 50, action: "reject" },
          ],
        }),
      );
      const rows = await db.query(
        "SELECT risk_violations, halt_reason FROM audit_orders WHERE order_id = ?",
        ["01HW_ORDER_RISK"],
      );
      expect(rows).toHaveLength(1);
      const violations = JSON.parse(rows[0]!.risk_violations as string);
      expect(violations[0].limit).toBe("max_net_delta");
      expect(violations[0].proposed).toBe(55);
      expect(rows[0]!.halt_reason).toBeNull();
    } finally {
      db.close();
    }
  });

  it("persists halt_reason on a kill-switch rejection", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentIntent(db, "01HW_INTENT_HALT");
      const writer = createAuditOrderWriter(db.db, log);
      await writer(
        buildOrderRow({
          order: order({
            order_id: "01HW_ORDER_HALT",
            intent_id: "01HW_INTENT_HALT",
            status: "rejected",
            completed_at: "2026-05-18T12:00:01.000Z",
          }),
          halt_reason: "manual kill — bad data",
        }),
      );
      const rows = await db.query("SELECT halt_reason FROM audit_orders WHERE order_id = ?", [
        "01HW_ORDER_HALT",
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.halt_reason).toBe("manual kill — bad data");
    } finally {
      db.close();
    }
  });

  it("persists account_id on INSERT and does not overwrite it on UPDATE", async () => {
    const db: TestDb = await createTestDb();
    try {
      await seedParentIntent(db, "01HW_INTENT_ACCT");
      const writer = createAuditOrderWriter(db.db, log);
      const orderId = "01HW_ORDER_ACCT";
      const intentId = "01HW_INTENT_ACCT";

      // Insert with explicit account_id.
      await writer(
        buildOrderRow({
          order: order({ order_id: orderId, intent_id: intentId }),
          account_id: "schwab-acct-1234",
        }),
      );

      // Update to a new status — account_id is INSERT-only, must not change.
      await writer(
        buildOrderRow({
          order: order({ order_id: orderId, intent_id: intentId, status: "filled" }),
          account_id: "should-not-overwrite",
        }),
      );

      const rows = await db.query(
        "SELECT account_id, status FROM audit_orders WHERE order_id = ?",
        [orderId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.account_id).toBe("schwab-acct-1234");
      expect(rows[0]!.status).toBe("filled");
    } finally {
      db.close();
    }
  });

  it("rejects when intent_id FK does not exist", async () => {
    const db: TestDb = await createTestDb();
    try {
      const writer = createAuditOrderWriter(db.db, log);
      await expect(
        writer(
          buildOrderRow({
            order: order({ order_id: "01HW_ORPHAN", intent_id: "01HW_DOES_NOT_EXIST" }),
          }),
        ),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
