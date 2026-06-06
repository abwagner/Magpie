// Client-side mirror of server/writeJobs/types.ts. Server is authoritative.

export type WriteJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WriteJob {
  job_id: string;
  kind: string;
  params: unknown;
  idempotency_key: string;
  status: WriteJobStatus;
  actor: string;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  progress: number;
  total: number | null;
  output_paths: string[];
  /** Upstream source slug; null for multi-source or source-agnostic jobs. */
  source: string | null;
  /** Latest data date covered (YYYY-MM-DD); null when not applicable. */
  data_through: string | null;
}

export interface SubmitWriteJobResponse {
  job_id: string;
  status: WriteJobStatus;
  deduped: boolean;
}

export interface WriteJobsListResponse {
  jobs: WriteJob[];
}
