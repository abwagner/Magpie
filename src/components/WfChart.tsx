// ── WfChart ───────────────────────────────────────────────────────
// Walk-forward chart: per-fold IS metric vs OOS metric over time.
// Two series overlaid on the same axes so IS/OOS divergence is
// visually obvious — that's the QF-124 acceptance criterion.
//
// Inline SVG implementation (no chart library) is deliberate:
// walk-forward runs typically have 5-20 folds, far below the point
// where a charting library pays for itself. Keeps the dep graph small
// and the rendering deterministic for snapshot tests.

import type { CSSProperties } from "react";
import { C, mono } from "../lib/constants.js";

// Order matters: this is also the order of the metric-selector chips.
export const OOS_METRICS = ["net_pnl", "sortino", "hit_rate", "max_dd"] as const;
export type OosMetric = (typeof OOS_METRICS)[number];

export interface OosPanel {
  n_trades?: number;
  net_pnl?: number;
  sortino?: number;
  hit_rate?: number;
  max_dd?: number;
}

export interface FoldRow {
  fold_id?: number;
  is_start?: string;
  is_end?: string;
  oos_start?: string;
  oos_end?: string;
  is_metric?: number;
  oos?: OosPanel;
}

interface ChartPoint {
  foldId: number;
  isValue: number | null;
  oosValue: number | null;
}

function pickOos(panel: OosPanel | undefined, metric: OosMetric): number | null {
  if (!panel) return null;
  const v = panel[metric];
  return typeof v === "number" ? v : null;
}

interface WfChartProps {
  folds: FoldRow[];
  metric: OosMetric;
  width?: number;
  height?: number;
  // Optional label shown above the chart — useful in comparison mode.
  title?: string;
  style?: CSSProperties;
}

export function WfChart({ folds, metric, width = 480, height = 200, title, style }: WfChartProps) {
  const padding = { top: 16, right: 16, bottom: 28, left: 44 };
  const innerW = Math.max(20, width - padding.left - padding.right);
  const innerH = Math.max(20, height - padding.top - padding.bottom);

  const sorted = [...folds].sort((a, b) => (a.fold_id ?? 0) - (b.fold_id ?? 0));
  const points: ChartPoint[] = sorted.map((f) => ({
    foldId: f.fold_id ?? 0,
    isValue: typeof f.is_metric === "number" ? f.is_metric : null,
    oosValue: pickOos(f.oos, metric),
  }));

  // Numeric domain across both series; nulls excluded. Empty-series
  // fallback keeps the SVG well-formed.
  const allValues = points.flatMap((p) =>
    [p.isValue, p.oosValue].filter((v): v is number => v !== null),
  );
  const hasData = points.length > 0 && allValues.length > 0;
  const yMin = hasData ? Math.min(...allValues) : 0;
  const yMax = hasData ? Math.max(...allValues) : 1;
  // Pad y range slightly so the extrema don't sit flush against the
  // axes; if the range is degenerate (yMin == yMax), expand around it.
  const yRange = yMax - yMin || Math.max(1, Math.abs(yMax));
  const yLo = yMin - yRange * 0.08;
  const yHi = yMax + yRange * 0.08;

  const xMin = 0;
  const xMax = Math.max(1, points.length - 1);
  const xScale = (foldIdx: number): number => padding.left + (foldIdx / Math.max(1, xMax)) * innerW;
  const yScale = (v: number): number => padding.top + innerH - ((v - yLo) / (yHi - yLo)) * innerH;

  function buildPath(series: "isValue" | "oosValue"): string {
    // Skip nulls by breaking the path into separate move/line
    // segments — gives a "dotted" look across missing data instead
    // of an interpolated lie.
    let d = "";
    let penUp = true;
    points.forEach((p, idx) => {
      const v = p[series];
      if (v === null) {
        penUp = true;
        return;
      }
      const x = xScale(idx);
      const y = yScale(v);
      d += `${penUp ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)} `;
      penUp = false;
    });
    return d.trim();
  }

  const isPath = buildPath("isValue");
  const oosPath = buildPath("oosValue");

  // Y axis ticks: 4 round-ish stops so the chart is readable without
  // a full axis library.
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const t = yLo + (yHi - yLo) * (i / tickCount);
    return { value: t, label: formatMetric(t, metric) };
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
      {title && (
        <div
          style={{
            fontSize: 10,
            color: C.dim,
            fontFamily: mono,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          {title}
        </div>
      )}
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Walk-forward chart: IS metric vs OOS ${metric} across ${points.length} folds`}
        style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4 }}
      >
        {/* Y gridlines + tick labels */}
        {ticks.map((t, i) => {
          const y = yScale(t.value);
          return (
            <g key={i}>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={y}
                y2={y}
                stroke={C.border}
                strokeWidth={1}
              />
              <text
                x={padding.left - 6}
                y={y + 3}
                textAnchor="end"
                fontFamily={mono}
                fontSize={9}
                fill={C.dim}
              >
                {t.label}
              </text>
            </g>
          );
        })}

        {/* X tick labels — fold ids */}
        {points.map((p, idx) => (
          <text
            key={p.foldId}
            x={xScale(idx)}
            y={padding.top + innerH + 14}
            textAnchor="middle"
            fontFamily={mono}
            fontSize={9}
            fill={C.dim}
          >
            f{p.foldId}
          </text>
        ))}

        {/* Series — IS = amber, OOS = accent. Matches DataCatalogTab's
            convention where amber is the "IS / configured" color and
            accent is the "OOS / observed" color. */}
        {isPath && <path d={isPath} stroke={C.amber} strokeWidth={1.5} fill="none" />}
        {oosPath && <path d={oosPath} stroke={C.accent} strokeWidth={1.5} fill="none" />}

        {/* Per-point dots so single-fold series are still visible. */}
        {points.map((p, idx) => (
          <g key={`pts-${p.foldId}`}>
            {p.isValue !== null && (
              <circle cx={xScale(idx)} cy={yScale(p.isValue)} r={2.5} fill={C.amber} />
            )}
            {p.oosValue !== null && (
              <circle cx={xScale(idx)} cy={yScale(p.oosValue)} r={2.5} fill={C.accent} />
            )}
          </g>
        ))}

        {/* Legend, top-right. Swatches are squares (rect) rather than
            circles so they're trivially distinguishable from per-point
            dots — tests count circles to verify a dot lands on every
            (fold, series) pair. */}
        <g transform={`translate(${padding.left + innerW - 100}, ${padding.top + 4})`}>
          <rect x={0} y={-10} width={100} height={26} fill={C.surface} fillOpacity={0.85} />
          <rect x={3} y={-4} width={6} height={6} fill={C.amber} />
          <text x={14} y={2} fontFamily={mono} fontSize={9} fill={C.text}>
            IS metric
          </text>
          <rect x={3} y={7} width={6} height={6} fill={C.accent} />
          <text x={14} y={13} fontFamily={mono} fontSize={9} fill={C.text}>
            OOS {metric}
          </text>
        </g>

        {!hasData && (
          <text
            x={padding.left + innerW / 2}
            y={padding.top + innerH / 2}
            textAnchor="middle"
            fontFamily={mono}
            fontSize={10}
            fill={C.dim}
          >
            No data
          </text>
        )}
      </svg>
    </div>
  );
}

// Format helper — same rules used by BacktestsTab's detail table for
// consistency. Exported so the same formatting can be reused next to
// a chart if needed.
export function formatMetric(v: number, metric: OosMetric): string {
  if (metric === "hit_rate") return `${(v * 100).toFixed(0)}%`;
  if (metric === "sortino") return v.toFixed(2);
  // net_pnl, max_dd: dollar-ish, no decimals
  return v.toFixed(0);
}
