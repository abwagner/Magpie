// ── Write-Jobs Module Init (M10-1) ────────────────────────────────
//
// Wired from server/index.ts during boot. Returns
// the runner (callers can also enqueue jobs in-process via M10-4) and
// the API surface (HTTP routes).

import { resolve } from "node:path";
import type { Database } from "duckdb";
import type { Logger } from "../logger.js";
import { createWriteJobAuthenticator, type WriteJobAuthenticator } from "./auth.js";
import { createWriteJobsApi, type WriteJobsApi } from "./api.js";
import { createWriteJobRunner, type WriteJobRunner } from "./runner.js";
import { createWriteJobsStore } from "./store.js";
import {
  createFileWriteJobTokenStore,
  createMemoryWriteJobTokenStore,
  type WriteJobTokenStore,
} from "./tokens.js";
import { fmpBackfillHandler } from "./handlers/fmp-backfill.js";
import { collectBulkHandler } from "./handlers/collect-bulk.js";
import { ingestHandler } from "./handlers/ingest.js";
import { syncToS3Handler } from "./handlers/sync-to-s3.js";
import { chainStoreHandler } from "./handlers/chain-store.js";
import { orchestrateRefreshHandler } from "./handlers/orchestrate-refresh.js";
import { databentoPullHandler } from "./handlers/databento-pull.js";
import { backupObservabilityHandler } from "./handlers/backup-observability.js";
import { createAuditRetentionHandler } from "./handlers/audit-retention.js";

export interface WriteJobsModule {
  runner: WriteJobRunner;
  api: WriteJobsApi;
  auth: WriteJobAuthenticator;
  tokens: WriteJobTokenStore;
}

export interface WriteJobsInitOpts {
  db: Database;
  logger: Logger;
  /** Override the token-store path. Defaults to
   *  `${WRITE_JOB_TOKEN_PATH}` or `data/secrets/write-job-tokens.json`. */
  tokenStorePath?: string;
  /** Use the in-memory token store (for tests). */
  inMemoryTokens?: boolean;
}

export async function initWriteJobs(opts: WriteJobsInitOpts): Promise<WriteJobsModule> {
  const { db, logger } = opts;

  // 1. DDL.
  const store = createWriteJobsStore(db);
  await store.init();

  // 2. Token store.
  const tokens = opts.inMemoryTokens
    ? createMemoryWriteJobTokenStore()
    : createFileWriteJobTokenStore({
        path:
          opts.tokenStorePath ??
          process.env.WRITE_JOB_TOKEN_PATH ??
          resolve(process.cwd(), "data", "secrets", "write-job-tokens.json"),
      });

  // 3. Runner.
  const runner = createWriteJobRunner({ store, logger: logger.child("write-jobs") });
  runner.registerHandler(fmpBackfillHandler);
  runner.registerHandler(collectBulkHandler);
  runner.registerHandler(ingestHandler);
  runner.registerHandler(syncToS3Handler);
  runner.registerHandler(chainStoreHandler);
  runner.registerHandler(orchestrateRefreshHandler);
  runner.registerHandler(databentoPullHandler);
  runner.registerHandler(backupObservabilityHandler);
  runner.registerHandler(createAuditRetentionHandler(db));

  // 4. Orphan recovery — any job left in `running` from a prior process
  //    is now stale. Mark them failed before we start serving.
  const orphans = await runner.recoverOrphans("server restart");
  if (orphans > 0) {
    logger.warn("write-jobs orphan recovery", { count: orphans });
  }

  // 5. Auth + HTTP API.
  const auth = createWriteJobAuthenticator(tokens);
  const api = createWriteJobsApi(runner, auth, logger.child("write-jobs"));

  return { runner, api, auth, tokens };
}
