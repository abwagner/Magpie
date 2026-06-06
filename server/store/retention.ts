// ── Retention & Compaction ─────────────────────────────────────────
// Signal Parquet file retention was retired with the Arch-A signal
// subsystem (QF-261). This module is kept as a stub so any surviving
// import sites compile; implementations that referenced signal_catalog
// are gone.

import type { Database } from "duckdb";
import type { Logger } from "../logger.js";

export interface RetentionConfig {
  signals_max_age_days: number;
  compaction_enabled: boolean;
}

export interface RetentionDeps {
  db: Database;
  dataDir: string;
  config: RetentionConfig;
  logger: Logger;
}

export async function runRetention(deps: RetentionDeps): Promise<void> {
  deps.logger.info("Signal retention retired (QF-261) — no-op");
}
