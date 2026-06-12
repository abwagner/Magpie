// ── FMP Historical Backfill — thin API client (M10-1) ─────────────
//
// Hard cutover. Pre-M10, this script wrote MinIO directly with S3
// credentials and tracked progress in ~/.cache/magpie/. Now the
// QF server is the only thing that holds write creds. This script
// submits a write job to the dispatcher and polls until done.
//
// Usage:
//   npm run fmp-backfill                                    # default universe
//   npm run fmp-backfill fundamentals/yfinance/universe.parquet
//
// Env:
//   WRITE_JOB_TOKEN          Bearer token (issue via `npm run issue-write-token`)
//   WRITE_JOB_API_BASE       Default http://localhost:3001
//   FMP_RATE_LIMIT_PER_SEC   Per-job override (passed as a param)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// .env auto-load — picks up WRITE_JOB_TOKEN from .env or ~/.env.
const __script_dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__script_dir, "..");
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
loadDotEnv(resolve(PROJECT_ROOT, ".env"));
loadDotEnv(resolve(homedir(), ".env"));

const API_BASE = (process.env.WRITE_JOB_API_BASE ?? "http://localhost:3001").replace(/\/$/, "");
const TOKEN = (process.env.WRITE_JOB_TOKEN ?? "").trim();
const POLL_INTERVAL_MS = 2000;

interface SubmitResp {
  job_id: string;
  status: string;
  deduped: boolean;
}

interface JobStatus {
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

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const resp = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${path}: ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error(
      "WRITE_JOB_TOKEN is not set.\n\nIssue a token with:\n  npm run issue-write-token -- --actor operator-yourname --scopes fmp-backfill\n\nThen export WRITE_JOB_TOKEN=… or add it to ~/.env.",
    );
    process.exit(2);
  }

  const universePath = process.argv[2];
  const rateLimitArg = process.env.FMP_RATE_LIMIT_PER_SEC
    ? Number(process.env.FMP_RATE_LIMIT_PER_SEC)
    : undefined;
  const params: Record<string, unknown> = {};
  if (universePath) params.universe_parquet = universePath;
  if (rateLimitArg !== undefined && Number.isFinite(rateLimitArg)) {
    params.rate_limit_per_sec = rateLimitArg;
  }

  console.log(`[fmp-backfill] submitting via ${API_BASE}/api/write-jobs`);
  const submit = await api<SubmitResp>("/api/write-jobs", {
    method: "POST",
    body: JSON.stringify({ kind: "fmp-backfill", params }),
  });
  console.log(
    `[fmp-backfill] job_id=${submit.job_id} status=${submit.status}${submit.deduped ? " (deduped — sharing an in-flight job)" : ""}`,
  );

  let lastReport = -1;
   
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const job = await api<JobStatus>(`/api/write-jobs/${encodeURIComponent(submit.job_id)}`);
    if (job.progress !== lastReport) {
      lastReport = job.progress;
      const total = job.total ?? "?";
      console.log(
        `[fmp-backfill] status=${job.status} progress=${job.progress}/${total}${job.error ? " error=" + job.error : ""}`,
      );
    }
    if (job.status === "completed") {
      console.log(`[fmp-backfill] done. Outputs:`);
      for (const p of job.output_paths) console.log(`  ${p}`);
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      console.error(`[fmp-backfill] ${job.status}: ${job.error ?? "(no error)"}`);
      process.exit(1);
    }
  }
}

void main().catch((e: unknown) => {
  console.error("[fmp-backfill] fatal:", e);
  process.exit(1);
});
