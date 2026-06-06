// ── Halt Audit (QF-60) ────────────────────────────────────────────
//
// Records and queries per-portfolio halt / reset events. The runtime
// state itself already lives on the PortfolioEngine; this store adds
// the audit history that powers Settings → Risk → Emergency.
//
// The store stays small on purpose — wraps a single DuckDB table.
// Cancel-all-pending and drain-mode flags are deferred (separate
// follow-up tickets) so this PR doesn't drag the OrderPlane refactor
// in. Per-portfolio halt audit is the operator-visible improvement
// that lands today.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import type { PortfolioEngine } from "../portfolio/engine.js";

export type HaltEventKind = "halt" | "reset";

export interface HaltEvent {
  ts: string;
  portfolio_id: string;
  kind: HaltEventKind;
  reason: string;
  actor: string;
}

export interface HaltsStoreOpts {
  db: Database;
  logger: Logger;
  portfolioEngine: PortfolioEngine;
}

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS audit_system_halts (
    ts            TIMESTAMP NOT NULL,
    portfolio_id  VARCHAR NOT NULL,
    kind          VARCHAR NOT NULL,
    reason        VARCHAR NOT NULL,
    actor         VARCHAR NOT NULL
  )
`;

function runExec(db: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, ...params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function runQuery<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: unknown) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

export interface HaltsStore {
  init(): Promise<void>;
  halt(portfolioId: string, reason: string, actor?: string): Promise<HaltEvent>;
  reset(portfolioId: string, reason: string, actor?: string): Promise<HaltEvent>;
  /** Newest-first audit history; capped by `limit` (default 100). */
  history(limit?: number): Promise<HaltEvent[]>;
}

export function createHaltsStore(opts: HaltsStoreOpts): HaltsStore {
  const { db, logger, portfolioEngine } = opts;

  async function appendEvent(event: HaltEvent): Promise<void> {
    await runExec(
      db,
      "INSERT INTO audit_system_halts (ts, portfolio_id, kind, reason, actor) VALUES (?, ?, ?, ?, ?)",
      [event.ts, event.portfolio_id, event.kind, event.reason, event.actor],
    );
  }

  return {
    async init(): Promise<void> {
      await runExec(db, TABLE_DDL);
    },

    async halt(portfolioId, reason, actor = "operator"): Promise<HaltEvent> {
      if (!reason || reason.trim() === "") {
        throw new Error("reason is required");
      }
      portfolioEngine.halt(portfolioId, reason);
      const event: HaltEvent = {
        ts: new Date().toISOString(),
        portfolio_id: portfolioId,
        kind: "halt",
        reason: reason.trim(),
        actor,
      };
      await appendEvent(event);
      logger.warn("portfolio halted (audit)", {
        portfolio_id: portfolioId,
        reason: event.reason,
        actor,
      });
      return event;
    },

    async reset(portfolioId, reason, actor = "operator"): Promise<HaltEvent> {
      // Reason is required even on reset so the audit trail explains
      // why an operator un-halted (e.g., "fill engine recovered" /
      // "investigated, false alarm").
      if (!reason || reason.trim() === "") {
        throw new Error("reason is required");
      }
      portfolioEngine.resetHalt(portfolioId);
      const event: HaltEvent = {
        ts: new Date().toISOString(),
        portfolio_id: portfolioId,
        kind: "reset",
        reason: reason.trim(),
        actor,
      };
      await appendEvent(event);
      logger.info("portfolio reset (audit)", {
        portfolio_id: portfolioId,
        reason: event.reason,
        actor,
      });
      return event;
    },

    async history(limit = 100): Promise<HaltEvent[]> {
      // DuckDB doesn't accept `?` parameter for LIMIT in some setups;
      // clamp + interpolate the int directly. Cap at 1000 for safety.
      const safe = Math.max(1, Math.min(1000, Math.floor(limit)));
      const rows = await runQuery<{
        ts: Date | string;
        portfolio_id: string;
        kind: string;
        reason: string;
        actor: string;
      }>(
        db,
        `SELECT ts, portfolio_id, kind, reason, actor
           FROM audit_system_halts
       ORDER BY ts DESC
          LIMIT ${safe}`,
      );
      return rows.map((r) => ({
        ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
        portfolio_id: r.portfolio_id,
        kind: r.kind as HaltEventKind,
        reason: r.reason,
        actor: r.actor,
      }));
    },
  };
}
