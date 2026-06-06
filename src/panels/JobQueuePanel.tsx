// ── Job Queue Panel ──────────────────────────────────────────────────
// Scaffold for the orchestrator job queue. Live-connects to the
// research WS and renders a compact table of every job the
// orchestrator has emitted status for during this session. Phase 3
// turns this into the full queue management view (cancel, retry,
// view logs).
//
// The panel is intentionally minimal so reviewers can see exactly
// what wire data the WS hook delivers — this is the load-bearing
// proof that QF-110/QF-111 plug into the GUI.

import { Panel } from "../components/ui/Panel.js";
import { useResearchEvents } from "../lib/research/useResearchEvents.js";
import type { JobState } from "../types/research.js";

const STATE_TONES: Record<JobState, string> = {
  pending: "var(--text-3)",
  running: "var(--warn)",
  completed: "var(--pos)",
  failed: "var(--neg)",
};

export function JobQueuePanel() {
  const { jobs, connected, reconnecting, lastError, lastCorrelationId } = useResearchEvents();
  const rows = Object.values(jobs).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  return (
    <Panel title="Job Queue" actions={["kebab"]}>
      <div style={{ padding: 8, height: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
        <ConnectionBadge
          connected={connected}
          reconnecting={reconnecting}
          lastError={lastError}
          correlationId={lastCorrelationId}
        />
        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Job</th>
                <th style={thStyle}>Strategy</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.job_id}>
                  <td style={tdStyle} title={row.job_id}>
                    {row.job_id.slice(0, 8)}
                  </td>
                  <td style={tdStyle}>{row.result?.strategy_id ?? "—"}</td>
                  <td style={{ ...tdStyle, color: STATE_TONES[row.state] }}>{row.state}</td>
                  <td style={tdStyle}>{row.submitted_at.slice(0, 19).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PhaseFooter
          phase={3}
          note="Filtering, cancel/retry, and per-job log drawer land in Phase 3."
        />
      </div>
    </Panel>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────

export interface ConnectionBadgeProps {
  connected: boolean;
  reconnecting: boolean;
  lastError: string | null;
  correlationId: string | null;
}

export function ConnectionBadge({
  connected,
  reconnecting,
  lastError,
  correlationId,
}: ConnectionBadgeProps) {
  const tone = connected ? "var(--pos)" : reconnecting ? "var(--warn)" : "var(--neg)";
  const label = connected ? "live" : reconnecting ? "reconnecting" : "disconnected";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 11,
        color: "var(--text-3)",
      }}
      aria-label="Research WS connection status"
    >
      <span
        aria-label="connection state"
        style={{
          color: tone,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>
      {correlationId && (
        <span
          title={`last correlation_id: ${correlationId}`}
          style={{ fontFamily: "var(--font-code, monospace)" }}
        >
          cid:{correlationId.slice(0, 8)}
        </span>
      )}
      {lastError && (
        <span style={{ color: "var(--neg)" }} title={lastError}>
          err
        </span>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        padding: 16,
        textAlign: "center",
        color: "var(--text-3)",
        fontSize: 12,
        border: "1px dashed var(--border)",
        borderRadius: 6,
        flex: 1,
      }}
    >
      No jobs in this session.
      <br />
      Submit a job via the orchestrator API to see it stream here.
    </div>
  );
}

export interface PhaseFooterProps {
  phase: number;
  note: string;
}

export function PhaseFooter({ phase, note }: PhaseFooterProps) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--text-3)",
        borderTop: "1px solid var(--border-subtle, var(--border))",
        paddingTop: 6,
      }}
    >
      <span className="dim2">Phase {phase} scaffold · </span>
      {note}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: 11,
};
const thStyle = {
  textAlign: "left" as const,
  fontWeight: 600,
  color: "var(--text-3)",
  padding: "4px 6px",
  borderBottom: "1px solid var(--border)",
};
const tdStyle = {
  padding: "4px 6px",
  fontFamily: "var(--font-code, monospace)" as const,
  fontSize: 11,
};
