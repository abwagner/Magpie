// ── Grid Heatmap Panel ──────────────────────────────────────────────
// Scaffold for the parameter-grid heatmap. Phase 3 lands the real
// visualisation (2D heat over two swept params, colored by Sharpe /
// other selected metric). The scaffold renders a fixed-shape grid
// of cells coloured by the most-recent completed-job metric so
// reviewers can see the wire data flow without a real grid sweep.
//
// When no completed jobs are available it shows an empty-state
// notice + the connection badge from JobQueuePanel.

import { Panel } from "../components/ui/Panel.js";
import { ConnectionBadge, PhaseFooter } from "./JobQueuePanel.js";
import { useResearchEvents } from "../lib/research/useResearchEvents.js";

const CELL_COUNT = 25; // 5×5 placeholder grid

export function GridHeatmapPanel() {
  const { jobs, results, connected, reconnecting, lastError, lastCorrelationId } =
    useResearchEvents();

  const completed = Object.values(jobs).filter((j) => j.state === "completed");
  const sharpeValues = completed
    .map((j) => results[j.job_id]?.metrics?.sharpe ?? j.result?.metrics?.sharpe)
    .filter((v): v is number => typeof v === "number");

  const min = sharpeValues.length > 0 ? Math.min(...sharpeValues) : 0;
  const max = sharpeValues.length > 0 ? Math.max(...sharpeValues) : 1;
  const span = max - min || 1;

  return (
    <Panel title="Grid Heatmap" actions={["kebab"]}>
      <div
        style={{
          padding: 8,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <ConnectionBadge
          connected={connected}
          reconnecting={reconnecting}
          lastError={lastError}
          correlationId={lastCorrelationId}
        />
        {sharpeValues.length === 0 ? (
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
            No completed grid runs.
            <br />
            Submit a grid job for the heatmap to populate.
          </div>
        ) : (
          <div
            role="grid"
            aria-label="Sharpe heatmap (placeholder shape)"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gridTemplateRows: "repeat(5, 1fr)",
              gap: 2,
              flex: 1,
              minHeight: 0,
            }}
          >
            {Array.from({ length: CELL_COUNT }).map((_, i) => {
              const value = sharpeValues[i % sharpeValues.length];
              const t = value !== undefined ? (value - min) / span : 0;
              const color = `hsl(${Math.round(120 * t)}, 60%, 35%)`;
              return (
                <div
                  key={i}
                  role="gridcell"
                  title={value !== undefined ? `sharpe ${value.toFixed(3)}` : ""}
                  style={{
                    background: color,
                    borderRadius: 2,
                  }}
                />
              );
            })}
          </div>
        )}
        <PhaseFooter
          phase={3}
          note="Real (x, y) axis selection + linkage to fold scores ships in Phase 3."
        />
      </div>
    </Panel>
  );
}
