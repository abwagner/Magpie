// ── Walk-Forward Panel ──────────────────────────────────────────────
// Scaffold for the walk-forward visualisation. Phase 3 lands the
// real per-fold OOS panel, IS/OOS comparison, and fold-by-fold
// drilldown. The scaffold lists every completed job in chronological
// order with its window + headline metrics — enough to validate
// the wire format end to end.

import { Panel } from "../components/ui/Panel.js";
import { ConnectionBadge, PhaseFooter } from "./JobQueuePanel.js";
import { useResearchEvents } from "../lib/research/useResearchEvents.js";

export function WalkForwardPanel() {
  const { jobs, results, connected, reconnecting, lastError, lastCorrelationId } =
    useResearchEvents();
  const completed = Object.values(jobs)
    .filter((j) => j.state === "completed")
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));

  return (
    <Panel title="Walk-Forward" actions={["kebab"]}>
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
            No walk-forward folds completed yet.
            <br />
            Submit a walk-forward job for the per-fold timeline to populate.
          </div>
        ) : (
          <div style={{ flex: 1, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Fold</th>
                  <th style={thStyle}>Window</th>
                  <th style={thStyle}>Sharpe</th>
                  <th style={thStyle}>Max DD</th>
                  <th style={thStyle}>Trades</th>
                </tr>
              </thead>
              <tbody>
                {completed.map((row, idx) => {
                  const r = results[row.job_id] ?? row.result;
                  return (
                    <tr key={row.job_id}>
                      <td style={tdStyle}>{idx + 1}</td>
                      <td style={tdStyle}>
                        {r?.start_date ?? "?"} → {r?.end_date ?? "?"}
                      </td>
                      <td style={tdStyle}>{fmt(r?.metrics?.sharpe)}</td>
                      <td style={tdStyle}>{fmt(r?.metrics?.max_drawdown)}</td>
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
          note="IS/OOS overlay, lineage badge, and per-fold equity curve land in Phase 3."
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
