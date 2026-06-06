import { useCallback, useEffect, useMemo, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { getWriteJobToken, listWriteJobs, setWriteJobToken, submitWriteJob } from "../lib/api.js";
import type { WriteJob, WriteJobStatus } from "../types/write-jobs.js";

// Settings · System · Jobs (M10-2)
//
// Operator-facing view of the write-dispatch from M10-1. Lists recent
// jobs with status + progress + actor + duration; lets an operator
// trigger an fmp-backfill from a form (other kinds gain buttons in
// M10-3+). 5s poll; bearer token lives in sessionStorage and is
// pasted once per browser session.

const REFRESH_MS = 5000;

const STATUS_TONE: Record<WriteJobStatus, string> = {
  queued: "warn",
  running: "warn",
  completed: "pos",
  failed: "neg",
  cancelled: "neg",
};

export function JobsScreen() {
  const [jobs, setJobs] = useState<WriteJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState<string>(getWriteJobToken() ?? "");
  const [tokenSaved, setTokenSaved] = useState<string | null>(getWriteJobToken());

  const reload = useCallback(async () => {
    if (!tokenSaved) {
      setLoading(false);
      return;
    }
    try {
      const res = await listWriteJobs({ limit: 50 });
      setJobs(res.jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tokenSaved]);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  function onSaveToken(): void {
    const trimmed = tokenInput.trim();
    setWriteJobToken(trimmed.length > 0 ? trimmed : null);
    setTokenSaved(trimmed.length > 0 ? trimmed : null);
  }

  function onClearToken(): void {
    setWriteJobToken(null);
    setTokenSaved(null);
    setTokenInput("");
    setJobs([]);
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · System · Jobs"
        title="Write jobs"
        body="Recent submissions to the write-dispatch (server-mediated MinIO writes). Bearer token is required; mint one with `npm run issue-write-token` and paste the plaintext below."
      />
      <TokenPanel
        tokenInput={tokenInput}
        setTokenInput={setTokenInput}
        tokenSaved={tokenSaved}
        onSave={onSaveToken}
        onClear={onClearToken}
      />
      {tokenSaved && <TriggerPanel onSubmitted={() => void reload()} />}
      {tokenSaved && <JobsTable jobs={jobs} loading={loading} error={error} />}
    </div>
  );
}

function TokenPanel({
  tokenInput,
  setTokenInput,
  tokenSaved,
  onSave,
  onClear,
}: {
  tokenInput: string;
  setTokenInput: (s: string) => void;
  tokenSaved: string | null;
  onSave: () => void;
  onClear: () => void;
}) {
  const masked = tokenSaved ? tokenSaved.slice(0, 4) + "…" + tokenSaved.slice(-4) : "";
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        Bearer token
      </div>
      {tokenSaved ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <span className="mono" style={{ color: "var(--text-1)" }}>
            {masked}
          </span>
          <span className="dim2" style={{ fontSize: 11 }}>
            stored in sessionStorage
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClear}
            style={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--r-2)",
              padding: "4px 12px",
              fontSize: 12,
              color: "var(--text-2)",
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
            }}
          >
            Clear
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="password"
            placeholder="Paste write-dispatch bearer token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{
              flex: 1,
              background: "var(--bg-elev)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--r-2)",
              padding: "6px 10px",
              fontSize: 12,
              color: "var(--text-1)",
              fontFamily: "var(--font-mono)",
            }}
          />
          <button
            type="button"
            onClick={onSave}
            disabled={tokenInput.trim().length === 0}
            style={{
              background: "var(--accent)",
              color: "var(--text-1)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--r-2)",
              padding: "6px 14px",
              fontSize: 12,
              cursor: tokenInput.trim().length === 0 ? "not-allowed" : "pointer",
              opacity: tokenInput.trim().length === 0 ? 0.5 : 1,
              fontFamily: "var(--font-ui)",
            }}
          >
            Save
          </button>
        </div>
      )}
      <div className="dim2" style={{ fontSize: 10, marginTop: 8 }}>
        Mint a token from the server:{" "}
        <span className="mono">
          npm run issue-write-token -- --actor your-name --scopes fmp-backfill
        </span>
      </div>
    </div>
  );
}

function TriggerPanel({ onSubmitted }: { onSubmitted: () => void }) {
  const [universe, setUniverse] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function onSubmit(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const params: Record<string, unknown> = {};
      if (universe.trim().length > 0) params.universe_parquet = universe.trim();
      if (rate.trim().length > 0) {
        const n = Number(rate);
        if (Number.isFinite(n) && n > 0) params.rate_limit_per_sec = n;
      }
      const res = await submitWriteJob("fmp-backfill", params);
      setFeedback({
        kind: "ok",
        text: `Submitted job_id=${res.job_id}${res.deduped ? " (deduped — joined in-flight job)" : ""}`,
      });
      onSubmitted();
    } catch (e) {
      setFeedback({
        kind: "err",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        Trigger fmp-backfill
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 200px auto",
          gap: 8,
          alignItems: "center",
        }}
      >
        <input
          type="text"
          placeholder="universe_parquet (default: fundamentals/yfinance/universe.parquet)"
          value={universe}
          onChange={(e) => setUniverse(e.target.value)}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--r-2)",
            padding: "6px 10px",
            fontSize: 12,
            color: "var(--text-1)",
            fontFamily: "var(--font-mono)",
          }}
        />
        <input
          type="text"
          placeholder="rate_limit_per_sec (e.g. 12)"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--r-2)",
            padding: "6px 10px",
            fontSize: 12,
            color: "var(--text-1)",
          }}
        />
        <button
          type="button"
          onClick={() => void onSubmit()}
          disabled={busy}
          style={{
            background: "var(--accent)",
            color: "var(--text-1)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--r-2)",
            padding: "6px 14px",
            fontSize: 12,
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
            fontFamily: "var(--font-ui)",
          }}
        >
          {busy ? "Submitting…" : "Submit"}
        </button>
      </div>
      {feedback && (
        <div
          className={feedback.kind === "ok" ? "pos" : "neg"}
          style={{ fontSize: 11, marginTop: 8 }}
        >
          {feedback.text}
        </div>
      )}
    </div>
  );
}

function JobsTable({
  jobs,
  loading,
  error,
}: {
  jobs: WriteJob[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        Recent jobs (newest first)
      </div>
      {error ? (
        <div className="neg" style={{ fontSize: 11 }}>
          {error}
        </div>
      ) : loading && jobs.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : jobs.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No jobs submitted yet.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-4)", fontSize: 11 }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500 }}>Kind</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Status</th>
              <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 500 }}>Progress</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Actor</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Submitted</th>
              <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 500 }}>Duration</th>
              <th style={{ textAlign: "left", padding: "4px 0 4px 8px", fontWeight: 500 }}>
                Error / Outputs
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <JobRow key={job.job_id} job={job} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function JobRow({ job }: { job: WriteJob }) {
  const duration = useMemo(() => formatDuration(job), [job]);
  return (
    <tr style={{ borderTop: "1px solid var(--border-1)", verticalAlign: "top" }}>
      <td style={{ padding: "6px 8px 6px 0" }}>
        <div className="mono">{job.kind}</div>
        <div className="mono dim2" style={{ fontSize: 10 }}>
          {job.job_id}
        </div>
      </td>
      <td style={{ padding: "6px 8px" }}>
        <span className={`badge ${STATUS_TONE[job.status]}`}>{job.status.toUpperCase()}</span>
      </td>
      <td className="mono" style={{ padding: "6px 8px", textAlign: "right" }}>
        {job.total === null ? job.progress.toLocaleString() : `${job.progress}/${job.total}`}
      </td>
      <td className="mono dim" style={{ padding: "6px 8px", fontSize: 11 }}>
        {job.actor}
      </td>
      <td className="mono dim" style={{ padding: "6px 8px", fontSize: 11 }}>
        {new Date(job.submitted_at).toLocaleString()}
      </td>
      <td className="mono dim" style={{ padding: "6px 8px", textAlign: "right", fontSize: 11 }}>
        {duration}
      </td>
      <td style={{ padding: "6px 0 6px 8px", fontSize: 11 }}>
        {job.error ? (
          <span className="neg">{job.error}</span>
        ) : job.output_paths.length > 0 ? (
          <span className="dim2 mono" style={{ fontSize: 10 }}>
            {job.output_paths.length} parquet{job.output_paths.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="dim2">—</span>
        )}
      </td>
    </tr>
  );
}

function formatDuration(job: WriteJob): string {
  if (!job.started_at) return "—";
  const end = job.completed_at ?? new Date().toISOString();
  const ms = Date.parse(end) - Date.parse(job.started_at);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
