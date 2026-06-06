// QF-316 — pending_intents rehydration integration test.
//
// Drives rehydratePendingIntents against a real in-memory DuckDB with
// seeded audit rows. Covers:
//   - qf-gated approved intents with no orders → pending
//   - qf-gated approved intents with status='filled' order → filled
//   - qf-gated approved intents with status='rejected_by_broker' → rejected
//   - qf-gated approved intents with status='cancelled' → cancelled
//   - qf-gated rejected intents (gate_decision='reject') → excluded
//   - qf-gated approved intents with envelope_revoked_at set → excluded
//   - source='qf' rows (OPL-originated) → excluded
//   - remaining_qty computed from intent.qty - SUM(fills.quantity)

import { describe, it, expect } from "vitest";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import { createPendingIntentsStore } from "../../pending-intents.js";
import { rehydratePendingIntents } from "../../rehydration.js";

async function seedIntent(
  db: TestDb,
  args: {
    intent_id: string;
    source?: string;
    gate_decision?: string | null;
    envelope_revoked_at?: string | null;
    quantity?: number;
    envelope_id?: string | null;
    strategy_id?: string;
    portfolio?: string;
    direction?: string;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO audit_intents (
       intent_id, signal_ids, portfolio, symbol, direction, quantity,
       strategy_id, created_at, source, gate_decision, envelope_id,
       envelope_revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.intent_id,
      "[]",
      args.portfolio ?? "main",
      "SPY",
      args.direction ?? "Long",
      args.quantity ?? 10,
      args.strategy_id ?? "s-1",
      "2026-05-29T17:00:00Z",
      args.source ?? "qf-gated",
      args.gate_decision ?? "approve",
      args.envelope_id ?? args.intent_id,
      args.envelope_revoked_at ?? null,
    ],
  );
}

async function seedOrder(
  db: TestDb,
  args: { order_id: string; intent_id: string; status: string; broker?: string },
): Promise<void> {
  await db.run(
    `INSERT INTO audit_orders (
       order_id, intent_id, broker, execution_mode, status,
       created_at, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      args.order_id,
      args.intent_id,
      args.broker ?? "schwab",
      "live",
      args.status,
      "2026-05-29T17:01:00Z",
      "nt-native",
    ],
  );
}

async function seedFill(
  db: TestDb,
  args: { fill_id: string; order_id: string; quantity: number },
): Promise<void> {
  await db.run(
    `INSERT INTO audit_fills (
       fill_id, order_id, price, quantity, filled_at, source
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [args.fill_id, args.order_id, 100, args.quantity, "2026-05-29T17:02:00Z", "nt-native"],
  );
}

describe("rehydratePendingIntents (QF-316)", () => {
  it("classifies qf-gated approved intents per their order/fill state", async () => {
    const tdb = await createTestDb();
    try {
      // Pending: no orders.
      await seedIntent(tdb, { intent_id: "INT-PEND" });
      // Filled.
      await seedIntent(tdb, { intent_id: "INT-FILL", quantity: 10 });
      await seedOrder(tdb, { order_id: "O-FILL", intent_id: "INT-FILL", status: "filled" });
      await seedFill(tdb, { fill_id: "F-1", order_id: "O-FILL", quantity: 10 });
      // Rejected.
      await seedIntent(tdb, { intent_id: "INT-REJ" });
      await seedOrder(tdb, {
        order_id: "O-REJ",
        intent_id: "INT-REJ",
        status: "rejected_by_broker",
      });
      // Cancelled.
      await seedIntent(tdb, { intent_id: "INT-CAN" });
      await seedOrder(tdb, {
        order_id: "O-CAN",
        intent_id: "INT-CAN",
        status: "cancelled",
      });

      const store = createPendingIntentsStore();
      const stats = await rehydratePendingIntents({
        db: tdb.db,
        logger: createTestLogger(),
        store,
      });

      expect(stats.totalScanned).toBe(4);
      expect(stats.pending).toBe(1);
      expect(stats.filled).toBe(1);
      expect(stats.cancelled).toBe(1);
      expect(stats.rejected).toBe(1);
      expect(store.get("INT-PEND")?.status).toBe("pending");
      expect(store.get("INT-FILL")?.status).toBe("filled");
      expect(store.get("INT-REJ")?.status).toBe("rejected");
      expect(store.get("INT-CAN")?.status).toBe("cancelled");
    } finally {
      tdb.close();
    }
  });

  it("excludes source='qf' rows", async () => {
    const tdb = await createTestDb();
    try {
      await seedIntent(tdb, { intent_id: "INT-OPL", source: "qf", gate_decision: null });
      const store = createPendingIntentsStore();
      const stats = await rehydratePendingIntents({
        db: tdb.db,
        logger: createTestLogger(),
        store,
      });
      expect(stats.totalScanned).toBe(0);
      expect(store.size()).toBe(0);
    } finally {
      tdb.close();
    }
  });

  it("excludes qf-gated REJECTED intents", async () => {
    const tdb = await createTestDb();
    try {
      await seedIntent(tdb, { intent_id: "INT-GREJ", gate_decision: "reject" });
      const store = createPendingIntentsStore();
      const stats = await rehydratePendingIntents({
        db: tdb.db,
        logger: createTestLogger(),
        store,
      });
      expect(stats.totalScanned).toBe(0);
    } finally {
      tdb.close();
    }
  });

  it("excludes intents with envelope_revoked_at set", async () => {
    const tdb = await createTestDb();
    try {
      await seedIntent(tdb, {
        intent_id: "INT-REVOKED",
        envelope_revoked_at: "2026-05-29T17:30:00Z",
      });
      const store = createPendingIntentsStore();
      const stats = await rehydratePendingIntents({
        db: tdb.db,
        logger: createTestLogger(),
        store,
      });
      expect(stats.totalScanned).toBe(0);
    } finally {
      tdb.close();
    }
  });

  it("computes remaining_qty from intent.quantity - SUM(fills.quantity)", async () => {
    const tdb = await createTestDb();
    try {
      await seedIntent(tdb, { intent_id: "INT-PART", quantity: 10 });
      await seedOrder(tdb, {
        order_id: "O-PART",
        intent_id: "INT-PART",
        status: "submitted",
      });
      await seedFill(tdb, { fill_id: "F-A", order_id: "O-PART", quantity: 3 });
      await seedFill(tdb, { fill_id: "F-B", order_id: "O-PART", quantity: 2 });
      const store = createPendingIntentsStore();
      await rehydratePendingIntents({
        db: tdb.db,
        logger: createTestLogger(),
        store,
      });
      expect(store.get("INT-PART")?.remaining_qty).toBe(5);
    } finally {
      tdb.close();
    }
  });
});
