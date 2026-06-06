// ── Store Query Interface ──────────────────────────────────────────
// Query interface for the data store. Signal-specific queries were
// retired with the Arch-A signal subsystem (QF-261).

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface StoreQuery {
  // Intentionally minimal — signal queries retired per QF-261.
  // Extend here for new chain/non-signal query surfaces.
  _db: Database;
}

// ── Implementation ─────────────────────────────────────────────────

export function createStoreQuery(db: Database, _logger: Logger): StoreQuery {
  return { _db: db };
}
