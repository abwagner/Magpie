// ── Research orchestrator wire types ─────────────────────────────────
// TS mirrors of the pydantic models in
// research/quantfoundry-research/src/quantfoundry_research/config.py
// and the event shapes published over NATS by
// research/quantfoundry-research/src/quantfoundry_research/events.py.
//
// The orchestrator's OpenAPI schema at /openapi.json is authoritative;
// when fields drift these declarations need to follow. A schema-diff
// integration test is on the QF-112 follow-on list.
//
// Reference: docs/polyglot-migration-tdd.md §5.5 (orchestrator).

// ── Submitted config ────────────────────────────────────────────────

export interface BacktestRunConfig {
  strategy_id: string;
  strategy_version: string;
  params: Record<string, unknown>;
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
  portfolio: string;
  seed?: number | null;
}

export type JobKind = "single" | "grid" | "walkforward";

export interface JobSubmission {
  kind: JobKind;
  config: BacktestRunConfig;
  correlation_id?: string | null;
}

// ── Status / result ────────────────────────────────────────────────

export type JobState = "pending" | "running" | "completed" | "failed";

export interface JobResult {
  job_id: string;
  run_id: string;
  strategy_id: string;
  strategy_version: string;
  start_date: string;
  end_date: string;
  portfolio: string;
  metrics: Record<string, number>;
  trade_count: number;
  notes?: string | null;
}

export interface JobStatus {
  job_id: string;
  state: JobState;
  submitted_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  correlation_id?: string | null;
  error?: string | null;
  result?: JobResult | null;
}

export interface JobAccepted {
  job_id: string;
  state: JobState;
  submitted_at: string;
}

export interface JobList {
  jobs: JobStatus[];
}

// ── Wire envelopes (NATS) ──────────────────────────────────────────

// Subjects published by the orchestrator (mirrors
// quantfoundry_research/nats.py).
export const RESEARCH_STATUS_SUBJECT_PREFIX = "research.jobs.status.";
export const RESEARCH_RESULT_SUBJECT_PREFIX = "research.jobs.result.";
export const DATA_WRITE_RESULTS_SUBJECT = "data.write.results";

export interface ResultEnvelope {
  job_id: string;
  correlation_id: string | null;
  published_at: string;
  producer: string;
  result: JobResult;
}

// ── WebSocket inbound (from server proxy) ──────────────────────────

// The TS server fan-outs NATS events to browser WS clients. Each
// message carries the subject + the decoded JSON payload.
//
// v1 wire format — narrow union over the two kinds the orchestrator
// actually publishes. The TS server may add 'envelope' (data.write.
// results) in a later PR; that's not part of the GUI's data model
// yet.

export type ResearchWsKind = "status" | "result";

export interface ResearchStatusMessage {
  kind: "status";
  subject: string; // e.g. "research.jobs.status.<job_id>"
  job: JobStatus;
}

export interface ResearchResultMessage {
  kind: "result";
  subject: string; // e.g. "research.jobs.result.<job_id>"
  result: JobResult;
}

export type ResearchWsMessage = ResearchStatusMessage | ResearchResultMessage;

// ── Helpers ────────────────────────────────────────────────────────

export function isTerminalState(state: JobState): boolean {
  return state === "completed" || state === "failed";
}

export function isStatusSubject(subject: string): boolean {
  return subject.startsWith(RESEARCH_STATUS_SUBJECT_PREFIX);
}

export function isResultSubject(subject: string): boolean {
  return subject.startsWith(RESEARCH_RESULT_SUBJECT_PREFIX);
}
