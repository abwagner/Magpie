// ── Research orchestrator HTTP client ────────────────────────────────
// Thin fetch wrapper for the orchestrator's REST surface. The
// orchestrator runs as a separate process (default
// http://localhost:8080) and proxies are TBD; for now we hit it
// directly. Configurable via VITE_RESEARCH_API_URL.
//
// Endpoints (defined in research/quantfoundry-research/.../routes.py):
//   POST   /jobs                    → JobAccepted (202)
//   GET    /jobs?state=<state>      → JobList
//   GET    /jobs/{job_id}           → JobStatus (404 on missing)
//   GET    /healthz                 → { status, version }

import type {
  JobAccepted,
  JobList,
  JobState,
  JobStatus,
  JobSubmission,
} from "../../types/research.js";

interface ImportMetaEnv {
  readonly VITE_RESEARCH_API_URL?: string;
}
interface ImportMetaWithEnv {
  readonly env?: ImportMetaEnv;
}

export const DEFAULT_ORCHESTRATOR_URL = "http://localhost:8080";

export function orchestratorUrl(): string {
  return (
    (import.meta as unknown as ImportMetaWithEnv).env?.VITE_RESEARCH_API_URL ||
    DEFAULT_ORCHESTRATOR_URL
  );
}

// ── HTTP helpers ────────────────────────────────────────────────────

interface FetchOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function getJSON<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl ?? orchestratorUrl()}${path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new ResearchApiError(body.detail || `research API error: HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body: unknown, opts: FetchOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl ?? orchestratorUrl()}${path}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new ResearchApiError(
      errBody.detail || `research API error: HTTP ${res.status}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

export class ResearchApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ResearchApiError";
    this.status = status;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export function submitJob(
  submission: JobSubmission,
  opts: FetchOptions = {},
): Promise<JobAccepted> {
  return postJSON<JobAccepted>("/jobs", submission, opts);
}

export function listJobs(state?: JobState, opts: FetchOptions = {}): Promise<JobList> {
  const qs = state ? `?state=${encodeURIComponent(state)}` : "";
  return getJSON<JobList>(`/jobs${qs}`, opts);
}

export function getJob(jobId: string, opts: FetchOptions = {}): Promise<JobStatus> {
  return getJSON<JobStatus>(`/jobs/${encodeURIComponent(jobId)}`, opts);
}

export function healthz(opts: FetchOptions = {}): Promise<{ status: string; version: string }> {
  return getJSON("/healthz", opts);
}
