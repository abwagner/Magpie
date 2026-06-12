// QF-206 — audit_intents builder + DuckDB writer tests.
// Spec: docs/tdd/order-flow.md §7.3 (audit-before-decision) +
// docs/tdd/cross-cutting.md §5 (Audit trail tables).

import { describe, it, expect } from "vitest";
import { createTestDb, type TestDb } from "../../../__tests__/helpers/test-db.js";
import { createLogger } from "../../../logger.js";
import { buildIntentRow, createAuditIntentWriter } from "../../audit-intent.js";

// ── buildIntentRow ────────────────────────────────────────────────────

describe("buildIntentRow", () => {
  it("serializes signal_ids as a JSON array", () => {
    const row = buildIntentRow({
      intent_id: "01HW00000000000000000000I",
      signal_ids: ["sig-1", "sig-2"],
      portfolio: "main",
      symbol: "OPT:SPY:2026-05-16:C:500",
      direction: "Short",
      quantity: 1,
      strategy_id: "short-straddle-spy",
    });
    expect(JSON.parse(row.signal_ids)).toEqual(["sig-1", "sig-2"]);
  });

  it("encodes an empty signal_ids array as '[]' (not undefined)", () => {
    const row = buildIntentRow({
      intent_id: "01HW00000000000000000000I",
      signal_ids: [],
      portfolio: "main",
      symbol: "OPT:SPY:2026-05-16:C:500",
      direction: "Long",
      quantity: 1,
      strategy_id: "short-straddle-spy",
    });
    expect(row.signal_ids).toBe("[]");
  });

  it("auto-generates created_at when not supplied", () => {
    const row = buildIntentRow({
      intent_id: "01HW00000000000000000000I",
      signal_ids: ["s"],
      portfolio: "main",
      symbol: "EQ:SPY",
      direction: "Long",
      quantity: 1,
      strategy_id: "x",
    });
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("respects caller-supplied created_at (test reproducibility)", () => {
    const row = buildIntentRow({
      intent_id: "01HW00000000000000000000I",
      signal_ids: ["s"],
      portfolio: "main",
      symbol: "EQ:SPY",
      direction: "Long",
      quantity: 1,
      strategy_id: "x",
      created_at: "2026-05-18T12:00:00.000Z",
    });
    expect(row.created_at).toBe("2026-05-18T12:00:00.000Z");
  });
});

// ── createAuditIntentWriter ──────────────────────────────────────────

describe("createAuditIntentWriter", () => {
  const log = createLogger("audit-intent-test", "error");

  it("persists an intent row that round-trips through DuckDB", async () => {
    const db: TestDb = await createTestDb();
    try {
      const writer = createAuditIntentWriter(db.db, log);
      await writer(
        buildIntentRow({
          intent_id: "01HW00000000000000000000I",
          signal_ids: ["sig-1"],
          portfolio: "main",
          symbol: "OPT:SPY:2026-05-16:C:500",
          direction: "Short",
          quantity: 2,
          strategy_id: "short-straddle-spy",
          created_at: "2026-05-18T12:00:00.000Z",
        }),
      );

      const rows = await db.query("SELECT * FROM audit_intents WHERE intent_id = ?", [
        "01HW00000000000000000000I",
      ]);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.portfolio).toBe("main");
      expect(row.symbol).toBe("OPT:SPY:2026-05-16:C:500");
      expect(row.direction).toBe("Short");
      expect(row.quantity).toBe(2);
      expect(row.strategy_id).toBe("short-straddle-spy");
      expect(JSON.parse(row.signal_ids as string)).toEqual(["sig-1"]);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate intent_id (PK constraint)", async () => {
    const db: TestDb = await createTestDb();
    try {
      const writer = createAuditIntentWriter(db.db, log);
      const row = buildIntentRow({
        intent_id: "01HW00000000000000000000I",
        signal_ids: ["sig-1"],
        portfolio: "main",
        symbol: "EQ:SPY",
        direction: "Long",
        quantity: 1,
        strategy_id: "x",
      });
      await writer(row);
      await expect(writer(row)).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
