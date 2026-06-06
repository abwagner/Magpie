// ── Write-Job Types (M10-1) ───────────────────────────────────────
//
// Single source of truth for the shape of jobs flowing through the
// write-dispatch chassis. Anything that submits, queries, or handles a
// job pulls types from here.
//
// Contract: docs/RUNBOOK.md §5 + the M10 plan
// (internal design notes).

import type { Logger } from "../logger.js";

export type WriteJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WriteJob {
  job_id: string;
  kind: string;
  /** Already JSON-deserialized when read from the store. */
  params: unknown;
  /** sha256(kind || canonical_json(params)). Submit dedupes against
   *  this when the existing job is queued or running. */
  idempotency_key: string;
  status: WriteJobStatus;
  /** Named actor identity from the token store (e.g. "operator:awagner",
   *  "cron-server"). */
  actor: string;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  /** Latest progress count (handler-reported via `progressSink`). */
  progress: number;
  /** Total work units if known; null when the handler reports just a
   *  running count. */
  total: number | null;
  /** Object-store paths the job wrote (parquet URIs etc.). */
  output_paths: string[];
  /** Upstream source slug (e.g. "fmp", "databento", "fred"). Null for
   *  multi-source or source-agnostic jobs. Populated at submit time from
   *  the handler's params. Required by the freshness derived view. */
  source: string | null;
  /** Latest data date covered by the job (YYYY-MM-DD). Populated at
   *  completion from the handler's result. Null for jobs that have no
   *  meaningful data-through concept (e.g. sync-to-s3). */
  data_through: string | null;
}

export interface WriteJobSubmission {
  kind: string;
  /** Free-form params; the handler validates. */
  params: unknown;
}

export interface SubmitResult {
  job_id: string;
  status: WriteJobStatus;
  /** True when an existing queued/running job collided on the
   *  idempotency key; the caller is sharing the prior submission's
   *  job_id rather than getting a fresh one. */
  deduped: boolean;
}

export interface ProgressSink {
  (done: number, total: number | null, note?: string): void;
}

export interface HandlerContext {
  actor: string;
  jobId: string;
  logger: Logger;
}

export interface HandlerResult {
  output_paths: string[];
  /** Max data date covered by the job (YYYY-MM-DD). Handlers that have no
   *  meaningful data-through concept (e.g. sync-to-s3) omit this field. */
  data_through?: string;
}

export interface JobHandler<P = unknown> {
  kind: string;
  /** Optional structural / semantic validation. Return non-empty array
   *  to reject the submit with 400 before the job ever queues. */
  validate?: (params: unknown) => string[];
  /** Optional: derive the source slug from this job's params. Populated
   *  into the write_jobs row at submit time. Return null (or omit) for
   *  source-agnostic or multi-source jobs. */
  sourceFor?: (params: P) => string | null;
  /** Handler body. Receives an in-process progress sink and a context
   *  with the actor identity + job id + scoped logger. Returns the
   *  list of output object-store URIs it wrote, plus optionally the
   *  latest data date covered. */
  run: (params: P, progress: ProgressSink, ctx: HandlerContext) => Promise<HandlerResult>;
}
