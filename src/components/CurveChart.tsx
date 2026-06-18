import { useRef, useEffect, useState } from "react";
import { C } from "../lib/constants.js";

// Plotly's typings are large; we treat the imported module as the
// minimal surface we actually call. This keeps CurveChart's type
// burden small while still flagging shape mismatches at the call
// sites within this file.

type PlotlyShape = Record<string, unknown>;
type PlotlyTrace = Record<string, unknown>;
interface PlotlyApi {
  newPlot(
    el: HTMLElement,
    traces: PlotlyTrace[],
    layout: PlotlyShape,
    config: PlotlyShape,
  ): unknown;
  react(el: HTMLElement, traces: PlotlyTrace[], layout: PlotlyShape, config: PlotlyShape): unknown;
  purge(el: HTMLElement): void;
}

let plotlyPromise: Promise<PlotlyApi> | null = null;
function loadPlotly(): Promise<PlotlyApi> {
  if (!plotlyPromise) {
    plotlyPromise = import("plotly.js-basic-dist-min").then((m) => {
      const mod = m as { default?: PlotlyApi } & PlotlyApi;
      return (mod.default ?? mod) as PlotlyApi;
    });
  }
  return plotlyPromise;
}

export interface CurveLine {
  key: string;
  label: string;
  color?: string;
  dash?: string;
}

export interface CurveChartProps {
  data: Record<string, number>[];
  xKey?: string;
  lines: CurveLine[];
  title?: string;
  xlabel?: string;
  ylabel?: string;
  height?: number;
  zeroline?: boolean;
  spotLine?: number;
}

/**
 * Reusable 2D line chart backed by Plotly. Used by ChainPicker for
 * payoff / vol-curve overlays. Phase 5+ may replace with
 * lightweight-charts; for now Plotly is fine because it's already
 * loaded for the GreekSurfaces 3D plot lineage.
 */
export default function CurveChart({
  data,
  xKey = "price",
  lines,
  title,
  xlabel,
  ylabel,
  height = 300,
  zeroline = true,
  spotLine,
}: CurveChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<boolean>(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (!containerRef.current || !data?.length || !lines?.length) return;

      const Plotly = await loadPlotly();
      if (cancelled) return;
      setLoading(false);

      const traces: PlotlyTrace[] = lines.map((line) => ({
        x: data.map((d) => d[xKey]),
        y: data.map((d) => d[line.key]),
        type: "scatter",
        mode: "lines",
        name: line.label,
        line: {
          color: line.color || C.accent,
          width: 2,
          dash: line.dash || "solid",
        },
        hovertemplate: `${xlabel || xKey}: %{x:.2f}<br>${line.label}: %{y:.2f}<extra></extra>`,
      }));

      const first = data[0];
      const last = data[data.length - 1];
      const shapes: PlotlyShape[] = [];
      if (zeroline && first && last) {
        shapes.push({
          type: "line",
          x0: first[xKey],
          x1: last[xKey],
          y0: 0,
          y1: 0,
          line: { color: C.dim, width: 1, dash: "dot" },
        });
      }
      if (spotLine != null) {
        shapes.push({
          type: "line",
          x0: spotLine,
          x1: spotLine,
          y0: 0,
          y1: 1,
          yref: "paper",
          line: { color: C.amber, width: 1, dash: "dash" },
        });
      }

      const layout: PlotlyShape = {
        title: title
          ? { text: title, font: { color: C.text, size: 13, family: "DM Sans" } }
          : undefined,
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        xaxis: {
          title: { text: xlabel || "", font: { color: C.dim, size: 10 } },
          color: C.dim,
          gridcolor: C.border,
          zerolinecolor: C.border,
        },
        yaxis: {
          title: { text: ylabel || "", font: { color: C.dim, size: 10 } },
          color: C.dim,
          gridcolor: C.border,
          zerolinecolor: C.border,
        },
        legend: { font: { color: C.dim, size: 10 }, bgcolor: "rgba(0,0,0,0)" },
        margin: { l: 60, r: 20, t: title ? 40 : 10, b: 40 },
        font: { color: C.dim, family: "JetBrains Mono" },
        shapes,
      };

      const config: PlotlyShape = { responsive: true, displayModeBar: false };

      if (plotRef.current) {
        Plotly.react(containerRef.current, traces, layout, config);
      } else {
        Plotly.newPlot(containerRef.current, traces, layout, config);
        plotRef.current = true;
      }
    }

    render();

    return () => {
      cancelled = true;
      if (containerRef.current && plotRef.current) {
        loadPlotly()
          .then((Plotly) => {
            if (containerRef.current) Plotly.purge(containerRef.current);
          })
          .catch(() => {});
        plotRef.current = false;
      }
    };
  }, [data, xKey, lines, title, xlabel, ylabel, zeroline, spotLine]);

  return (
    <div style={{ position: "relative" }}>
      {loading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: C.dim,
            fontSize: 11,
            zIndex: 1,
          }}
        >
          Loading chart...
        </div>
      )}
      <div ref={containerRef} style={{ width: "100%", height }} />
    </div>
  );
}
