// ── Comparison Panel ────────────────────────────────────────────────
// Scaffold for the multi-run comparison view. Phase 3 lands the full
// matrix: pick N completed runs and diff their metrics, equity
// curves, fold-by-fold scores side by side. The scaffold renders a
// metric table for every completed run so the wire shape is visible
// end to end.

import { Panel } from "../components/ui/Panel.js";
import { ConnectionBadge, PhaseFooter } from "./JobQueuePanel.js";
import { useResearchEvents } from "../lib/research/useResearchEvents.js";

const HEADLINE_METRICS = ["sharpe", "sortino", "total_return", "max_drawdown"] as const;

export function ComparisonPanel() {
  const { jobs, results, connected, reconnecting, lastError, lastCorrelationId } =
    useResearchEvents();
  const completed = Object.values(jobs)
    .filter((j) => j.state === "completed")
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  return (
    <Panel title="Comparison" actions={["kebab"]}>
      <div
        style={{
          padding: 8,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          overflow: "hidden",
        }}
      >
        <ConnectionBadge
          connected={connected}
          reconnecting={reconnecting}
          lastError={lastError}
          correlationId={lastCorrelationId}
        />
        {completed.length === 0 ? (
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
            No completed runs to compare yet.
          </div>
        ) : (
          <div style={{ flex: 1, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Run</th>
                  <th style={thStyle}>Strategy</th>
                  {HEADLINE_METRICS.map((m) => (
                    <th key={m} style={thStyle}>
                      {m}
                    </th>
                  ))}
                  <th style={thStyle}>Trades</th>
                </tr>
              </thead>
              <tbody>
                {completed.map((row) => {
                  const r = results[row.job_id] ?? row.result;
                  return (
                    <tr key={row.job_id}>
                      <td style={tdStyle} title={row.job_id}>
                        {row.job_id.slice(0, 8)}
                      </td>
                      <td style={tdStyle}>{r?.strategy_id ?? "—"}</td>
                      {HEADLINE_METRICS.map((m) => (
                        <td key={m} style={tdStyle}>
                          {fmt(r?.metrics?.[m])}
                        </td>
                      ))}
                      <td style={tdStyle}>{r?.trade_count ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <PhaseFooter
          phase={3}
          note="Run-pinning, equity-curve overlay, and per-metric diff arrows land in Phase 3."
        />
      </div>
    </Panel>
  );
}

function fmt(v: number | undefined): string {
  return typeof v === "number" ? v.toFixed(3) : "—";
}

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
