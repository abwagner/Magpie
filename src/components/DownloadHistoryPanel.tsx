// ── Recent Downloads Panel ────────────────────────────────────────
// Renders at the top of the Data Catalog tab. Surfaces the cross-
// source ingest run history from /api/downloads/runs so the user can
// answer: what was downloaded last night, from where, and how many
// MarketData credits did we burn?

import { useEffect, useMemo, useState } from "react";
import { C, mono, sans } from "../lib/constants.js";
import { Card, Btn, Pill } from "./common.js";
import { fmtNum, fmtAge, fmtDuration } from "../lib/format.js";
import { api } from "../lib/api.js";
import type { DownloadRun, RunsResponse, RunStatus } from "../types/downloads.js";
import { RunActivityDetail } from "./RunActivityDetail.js";

const STATUS_META: Record<RunStatus, { label: string; color: string; tip: string }> = {
  ok: { label: "ok", color: C.green, tip: "Run finished cleanly" },
  "stopped-credit-cap": {
    label: "credit cap",
    color: C.amber,
    tip: "Stopped because daily MarketData credit reserve was hit",
  },
  error: { label: "error", color: C.red, tip: "Run reported one or more errors" },
  incomplete: {
    label: "incomplete",
    color: C.amber,
    tip: "Run started but no completion marker — possibly crashed or still running",
  },
  synthesized: {
    label: "synth",
    color: C.dim,
    tip: "Source has no run log — synthesized from file timestamps",
  },
};

const SOURCE_COLOR: Record<string, string> = {
  "marketdata.app:chains-nightly": C.accent,
  "marketdata.app:chains-refresh": C.cyan,
  "marketdata.app:etf": C.cyan,
  fred: C.green,
  eia: C.amber,
  databento: C.purple,
  futures: C.amber,
};

function StatusPill({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      title={meta.tip}
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 3,
        background: `${meta.color}22`,
        border: `1px solid ${meta.color}55`,
        color: meta.color,
        fontFamily: mono,
        fontSize: 9,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

function CreditCell({ run }: { run: DownloadRun }) {
  if (!run.credits) return <span style={{ color: C.dim }}>—</span>;
  const { used, remaining, cap } = run.credits;
  // Red when within 5K of the cap; otherwise dim text.
  const danger = remaining < 5000;
  return (
    <span
      title={`${used.toLocaleString()} used / ${cap.toLocaleString()} cap · ${remaining.toLocaleString()} remaining`}
      style={{ color: danger ? C.red : C.text }}
    >
      {fmtNum(used)}/{fmtNum(cap)}
    </span>
  );
}

interface RunRowProps {
  run: DownloadRun;
  expanded: boolean;
  onToggle: () => void;
}

function RunRow({ run, expanded, onToggle }: RunRowProps) {
  const sourceColor = SOURCE_COLOR[run.source] ?? C.dim;
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderTop: `1px solid ${C.border}`,
          cursor: "pointer",
          background: expanded ? C.surfAlt : "transparent",
        }}
      >
        <td
          style={{ padding: "5px 8px", color: C.text, fontFamily: mono, fontSize: 11 }}
          title={run.started_at}
        >
          {fmtAge(run.started_at)} ago
        </td>
        <td style={{ padding: "5px 8px", color: sourceColor, fontFamily: mono, fontSize: 10 }}>
          {run.source}
        </td>
        <td style={{ padding: "5px 8px" }}>
          <StatusPill status={run.status} />
        </td>
        <td
          style={{
            padding: "5px 8px",
            textAlign: "right",
            color: C.dim,
            fontFamily: mono,
            fontSize: 10,
          }}
        >
          {fmtDuration(run.duration_seconds)}
        </td>
        <td
          style={{
            padding: "5px 8px",
            textAlign: "right",
            color: C.text,
            fontFamily: mono,
            fontSize: 10,
          }}
        >
          {fmtNum(run.files_written)}
        </td>
        <td
          style={{
            padding: "5px 8px",
            textAlign: "right",
            color: C.text,
            fontFamily: mono,
            fontSize: 10,
          }}
        >
          {fmtNum(run.rows_written)}
        </td>
        <td style={{ padding: "5px 8px", textAlign: "right", fontFamily: mono, fontSize: 10 }}>
          <CreditCell run={run} />
        </td>
        <td
          style={{
            padding: "5px 8px",
            textAlign: "right",
            color: run.error_count ? C.red : C.dim,
            fontFamily: mono,
            fontSize: 10,
          }}
        >
          {run.error_count || "—"}
        </td>
        <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 10, color: C.dim }}>
          {expanded ? "▲" : "▼"}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9} style={{ padding: "4px 12px 10px 12px" }}>
            {run.notes.length > 0 && (
              <div
                style={{
                  color: C.amber,
                  fontFamily: mono,
                  fontSize: 10,
                  marginBottom: 6,
                }}
              >
                {run.notes.join(" · ")}
              </div>
            )}
            <RunActivityDetail runId={run.id} />
          </td>
        </tr>
      )}
    </>
  );
}

export function DownloadHistoryPanel() {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSources, setActiveSources] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load(refresh = false): Promise<void> {
    try {
      if (refresh) setRefreshing(true);
      const res = await api.getDownloadRuns({ refresh });
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load(false);
  }, []);

  const runs = data?.runs ?? [];
  const sources = data?.sources ?? [];

  const filtered = useMemo(() => {
    if (activeSources.length === 0) return runs;
    return runs.filter((r) => activeSources.includes(r.source));
  }, [runs, activeSources]);

  // Header summary: most recent run, file count and credits used in last 24h.
  const summary = useMemo(() => {
    const last = runs[0] ?? null;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let files24h = 0;
    let credits24h = 0;
    let creditCap = 0;
    for (const r of runs) {
      if (Date.parse(r.started_at) < cutoff) continue;
      files24h += r.files_written ?? 0;
      if (r.credits) {
        credits24h += r.credits.used;
        creditCap = Math.max(creditCap, r.credits.cap);
      }
    }
    return { last, files24h, credits24h, creditCap };
  }, [runs]);

  function toggleSource(s: string): void {
    setActiveSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  return (
    <Card
      title={<span style={{ color: C.accent }}>Recent Downloads</span>}
      actions={
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            fontSize: 10,
            color: C.dim,
            fontFamily: mono,
          }}
        >
          {summary.last && (
            <span>
              Last: {fmtAge(summary.last.started_at)} ago ({summary.last.status})
            </span>
          )}
          <span>Files 24h: {fmtNum(summary.files24h)}</span>
          {summary.creditCap > 0 && (
            <span>
              Credits 24h: {fmtNum(summary.credits24h)}/{fmtNum(summary.creditCap)}
            </span>
          )}
          <Btn onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Btn>
        </div>
      }
    >
      {loading && (
        <div style={{ color: C.dim, padding: 12, fontFamily: sans, fontSize: 12 }}>
          Loading download history…
        </div>
      )}
      {error && (
        <div style={{ color: C.red, padding: 12, fontFamily: mono, fontSize: 11 }}>
          Error: {error}
        </div>
      )}
      {!loading && !error && data && (
        <>
          <div
            style={{
              display: "flex",
              gap: 4,
              flexWrap: "wrap",
              padding: "4px 0 8px 0",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: 9,
                color: C.dim,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                marginRight: 4,
              }}
            >
              Source
            </span>
            {sources.map((s) => (
              <Pill
                key={s}
                small
                active={activeSources.length === 0 || activeSources.includes(s)}
                color={SOURCE_COLOR[s] ?? C.accent}
                onClick={() => toggleSource(s)}
              >
                {s}
              </Pill>
            ))}
          </div>
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            <table
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: mono,
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr
                  style={{
                    color: C.dim,
                    fontSize: 9,
                    textTransform: "uppercase",
                    position: "sticky",
                    top: 0,
                    background: C.surface,
                  }}
                >
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>Started</th>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>Source</th>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>Status</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Duration</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Files</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Rows</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Credits</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Errors</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <RunRow
                    key={r.id}
                    run={r}
                    expanded={expandedId === r.id}
                    onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  />
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div style={{ color: C.dim, padding: 16, textAlign: "center", fontSize: 11 }}>
                No runs match the selected sources.
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export default DownloadHistoryPanel;
