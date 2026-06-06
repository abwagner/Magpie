// ── RunHeatmap ────────────────────────────────────────────────────
// Grid heatmap of qo-run fold OOS metrics. One row per run, one
// column per fold_id (union across runs); each cell coloured by the
// selected metric's directional score so the operator can spot
// fold-level instability across one or several runs at a glance.
// QF-123 acceptance: metric selector switches the encoding without
// reloading; TS + .tsx only; no chart library.

import type { CSSProperties } from "react";
import { C, mono } from "../lib/constants.js";
import { type OosMetric, formatMetric, type FoldRow } from "./WfChart.js";

// ── Public types ──────────────────────────────────────────────────

export interface RunHeatmapRow {
  // Human label rendered on the left (≤ 22 chars before truncation).
  label: string;
  // Optional second-line label (e.g. lineage shortid). Same column.
  sublabel?: string;
  folds: FoldRow[];
  // Click handler scoped to this row's fold; lets the parent route
  // to per-fold drill-down or just log to console for now.
  onCellClick?: (foldId: number) => void;
}

export interface RunHeatmapProps {
  rows: RunHeatmapRow[];
  metric: OosMetric;
  // Sizing — cells scale to fit the implied grid.
  cellWidth?: number;
  cellHeight?: number;
  labelColWidth?: number;
  style?: CSSProperties;
}

// ── Directional scoring ───────────────────────────────────────────
// Each OOS metric has a "what counts as good" semantics: signed
// metrics (net_pnl, sortino) are higher-better around 0; hit_rate
// is centered around 0.5; max_dd is one-tailed, lower-better.

type Direction = "higher_signed" | "centered_half" | "lower_better";

const DIRECTION: Record<OosMetric, Direction> = {
  net_pnl: "higher_signed",
  sortino: "higher_signed",
  hit_rate: "centered_half",
  max_dd: "lower_better",
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Score a cell relative to the visible corpus, returning -1..+1
// where +1 is unambiguously good and -1 is unambiguously bad.
// Visible-corpus relativity is deliberate: the heatmap answers
// "which folds carried this run / these runs?" not "did this run
// hit profitability?" — that's what the metric column in the
// per-fold table is for.
export function scoreCell(value: number, allValues: number[], metric: OosMetric): number {
  if (allValues.length === 0 || !Number.isFinite(value)) return 0;
  const d = DIRECTION[metric];
  if (d === "higher_signed") {
    const mag = Math.max(1e-9, ...allValues.map((v) => Math.abs(v)));
    return clamp(value / mag, -1, 1);
  }
  if (d === "lower_better") {
    const mx = Math.max(...allValues);
    const mn = Math.min(...allValues);
    const range = mx - mn;
    if (range < 1e-9) return 0;
    // Closer to min ⇒ better ⇒ +1; closer to max ⇒ worse ⇒ -1.
    return clamp(1 - (2 * (value - mn)) / range, -1, 1);
  }
  // centered_half: 0.5 is neutral; >0.5 good, <0.5 bad.
  return clamp(2 * (value - 0.5), -1, 1);
}

// Map -1..+1 to a fill color. Stops keep the cells legible against
// the panel background (C.surface) without leaning on alpha so that
// snapshot tests can grep exact strings.
export function colorFor(score: number): string {
  if (score < -0.6) return "#b91c1c"; // strong red
  if (score < -0.2) return "#dc2626"; // mid red
  if (score < 0.2) return "#1f2937"; // neutral slate
  if (score < 0.6) return "#059669"; // mid green
  return "#047857"; // strong green
}

// ── Component ─────────────────────────────────────────────────────

export function RunHeatmap({
  rows,
  metric,
  cellWidth = 28,
  cellHeight = 22,
  labelColWidth = 180,
  style,
}: RunHeatmapProps) {
  // Union of fold_ids across all rows, sorted ascending. Rows that
  // don't have a fold contribute an empty cell at that column —
  // visually obvious that the windows aren't aligned.
  const foldIdSet = new Set<number>();
  for (const r of rows) {
    for (const f of r.folds) {
      if (typeof f.fold_id === "number" && Number.isInteger(f.fold_id)) {
        foldIdSet.add(f.fold_id);
      }
    }
  }
  const foldIds = [...foldIdSet].sort((a, b) => a - b);

  // Collect all metric values across cells for the scoring step.
  // Done once per render — at typical scale (≤ 3 runs × ≤ 20 folds)
  // this is microsecond-level so no memo needed.
  const allValues: number[] = [];
  const cellValueByRowFold = new Map<string, number>(); // key = rowIdx:foldId
  rows.forEach((r, rowIdx) => {
    for (const f of r.folds) {
      const v = pickMetric(f, metric);
      if (v !== null) {
        allValues.push(v);
        if (typeof f.fold_id === "number") {
          cellValueByRowFold.set(`${rowIdx}:${f.fold_id}`, v);
        }
      }
    }
  });

  const width = labelColWidth + foldIds.length * cellWidth + 16;
  const headerH = 22;
  const height = headerH + rows.length * cellHeight + 8;

  // Empty state — keep the SVG well-formed so callers can still
  // measure the box but signal "nothing to render."
  if (rows.length === 0 || foldIds.length === 0) {
    return (
      <div style={style}>
        <div
          style={{
            padding: 10,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            background: C.surface,
            color: C.dim,
            fontFamily: mono,
            fontSize: 10,
            textAlign: "center",
          }}
        >
          No folds to plot.
        </div>
      </div>
    );
  }

  return (
    <div style={style}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Run heatmap: ${rows.length} run(s) × ${foldIds.length} fold(s), coloured by ${metric}`}
        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4 }}
      >
        {/* Fold-id header row */}
        {foldIds.map((id, colIdx) => (
          <text
            key={`hdr-${id}`}
            x={labelColWidth + colIdx * cellWidth + cellWidth / 2}
            y={headerH - 6}
            textAnchor="middle"
            fontFamily={mono}
            fontSize={9}
            fill={C.dim}
          >
            f{id}
          </text>
        ))}

        {/* One row per run */}
        {rows.map((row, rowIdx) => {
          const y = headerH + rowIdx * cellHeight;
          return (
            <g key={`row-${rowIdx}`}>
              {/* Label column */}
              <text x={8} y={y + cellHeight / 2 + 3} fontFamily={mono} fontSize={11} fill={C.text}>
                {row.label.length > 22 ? row.label.slice(0, 21) + "…" : row.label}
              </text>
              {row.sublabel && (
                <text
                  x={labelColWidth - 6}
                  y={y + cellHeight / 2 + 3}
                  textAnchor="end"
                  fontFamily={mono}
                  fontSize={9}
                  fill={C.dim}
                >
                  {row.sublabel}
                </text>
              )}

              {/* Cells */}
              {foldIds.map((foldId, colIdx) => {
                const v = cellValueByRowFold.get(`${rowIdx}:${foldId}`);
                const x = labelColWidth + colIdx * cellWidth;
                if (v === undefined) {
                  // Run doesn't have this fold — render a hashed cell.
                  return (
                    <g key={`cell-${rowIdx}-${foldId}`}>
                      <rect
                        x={x}
                        y={y}
                        width={cellWidth - 2}
                        height={cellHeight - 2}
                        fill="transparent"
                        stroke={C.border}
                        strokeDasharray="2 2"
                      />
                      <title>{`fold ${foldId}: not present in this run`}</title>
                    </g>
                  );
                }
                const s = scoreCell(v, allValues, metric);
                const fill = colorFor(s);
                const clickable = !!row.onCellClick;
                return (
                  <g
                    key={`cell-${rowIdx}-${foldId}`}
                    style={clickable ? { cursor: "pointer" } : undefined}
                    onClick={
                      clickable ? () => row.onCellClick && row.onCellClick(foldId) : undefined
                    }
                  >
                    <rect
                      x={x}
                      y={y}
                      width={cellWidth - 2}
                      height={cellHeight - 2}
                      fill={fill}
                      stroke={C.border}
                    />
                    <text
                      x={x + (cellWidth - 2) / 2}
                      y={y + cellHeight / 2 + 3}
                      textAnchor="middle"
                      fontFamily={mono}
                      fontSize={9}
                      fill={C.text}
                    >
                      {abbreviate(v, metric)}
                    </text>
                    <title>{`${row.label} · fold ${foldId} · ${metric} = ${formatMetric(v, metric)}`}</title>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Legend strip, bottom — five swatches matching colorFor's stops */}
      </svg>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginTop: 6,
          fontFamily: mono,
          fontSize: 9,
          color: C.dim,
        }}
      >
        <span>worse</span>
        {[-0.8, -0.4, 0, 0.4, 0.8].map((s) => (
          <span
            key={s}
            style={{
              display: "inline-block",
              width: 14,
              height: 10,
              background: colorFor(s),
              border: `1px solid ${C.border}`,
            }}
          />
        ))}
        <span>better</span>
        <span style={{ marginLeft: 12, color: C.dim }}>· relative to visible cells</span>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function pickMetric(fold: FoldRow, metric: OosMetric): number | null {
  const v = fold.oos?.[metric];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Short label rendered inside the cell. Uses the same formatMetric
// rules as WfChart but trims aggressively so the values fit.
function abbreviate(v: number, metric: OosMetric): string {
  if (metric === "hit_rate") return `${(v * 100).toFixed(0)}%`;
  if (metric === "sortino") return v.toFixed(1);
  // net_pnl, max_dd: use compact $-ish scaling
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return v.toFixed(0);
}
