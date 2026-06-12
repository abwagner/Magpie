// ── Shared write-jobs API client (M10-3) ──────────────────────────
//
// Submit + poll helper for the M10-1 dispatch API. Used by every
// thin-client CLI (fmp-backfill, collect-bulk, ingest, sync-to-s3).
//
// Env:
//   WRITE_JOB_TOKEN          Bearer token (issue via `npm run issue-write-token`)
//   WRITE_JOB_API_BASE       Default http://localhost:3001

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bootstrap .env loading from project root + ~/.env. */
export function loadJobClientEnv(): void {
  const __script_dir = dirname(fileURLToPath(import.meta.url));
  const PROJECT_ROOT = resolve(__script_dir, "..");
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  loadDotEnv(resolve(homedir(), ".env"));
}

function loadDotEnv(path: string): void {
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1]!.trim()]) {
        process.env[m[1]!.trim()] = m[2]!.trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* file missing is fine */
  }
}

function apiBase(): string {
  return (process.env.WRITE_JOB_API_BASE ?? "http://localhost:3001").replace(/\/$/, "");
}

function token(): string {
  const t = (process.env.WRITE_JOB_TOKEN ?? "").trim();
  if (!t) {
    console.error(
      "WRITE_JOB_TOKEN is not set.\n\nIssue a token with:\n  npm run issue-write-token -- --actor operator-yourname --scopes '*'\n\nThen export WRITE_JOB_TOKEN=… or add it to ~/.env.",
    );
    process.exit(2);
  }
  return t;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token()}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const resp = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${path}: ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

export interface JobStatus {
  job_id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  actor: string;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  progress: number;
  total: number | null;
  output_paths: string[];
}

interface SubmitResp {
  job_id: string;
  status: string;
  deduped: boolean;
}

/** Submit a job and stream-poll until terminal status. Prints
 *  progress updates as they change. Exits the process with the
 *  appropriate code on failure. */
export async function submitAndPoll(
  kind: string,
  params: Record<string, unknown>,
  opts: { pollMs?: number; label?: string } = {},
): Promise<JobStatus> {
  const label = opts.label ?? kind;
  const pollMs = opts.pollMs ?? 2000;

  console.log(`[${label}] submitting via ${apiBase()}/api/write-jobs`);
  const submit = await api<SubmitResp>("/api/write-jobs", {
    method: "POST",
    body: JSON.stringify({ kind, params }),
  });
  console.log(
    `[${label}] job_id=${submit.job_id} status=${submit.status}${submit.deduped ? " (deduped — sharing an in-flight job)" : ""}`,
  );

  let lastReport = -1;
   
  while (true) {
    await new Promise((r) => setTimeout(r, pollMs));
    const job = await api<JobStatus>(`/api/write-jobs/${encodeURIComponent(submit.job_id)}`);
    if (job.progress !== lastReport) {
      lastReport = job.progress;
      const total = job.total ?? "?";
      console.log(`[${label}] status=${job.status} progress=${job.progress}/${total}`);
    }
    if (job.status === "completed") {
      console.log(`[${label}] done. Outputs:`);
      for (const p of job.output_paths) console.log(`  ${p}`);
      return job;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      console.error(`[${label}] ${job.status}: ${job.error ?? "(no error)"}`);
      process.exit(1);
    }
  }
}
