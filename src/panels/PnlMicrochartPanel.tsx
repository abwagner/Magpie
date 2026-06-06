import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type Time,
} from "lightweight-charts";
import { Panel } from "../components/ui/Panel.js";
import { usePortfolio } from "../state/StateProvider.js";
import { getPortfolioSnapshots } from "../lib/api.js";
import { signed, usd, pct, pnlClass } from "../lib/numbers.js";

interface SnapshotRow {
  snapshot_ts: string;
  realized_pnl: number;
  unrealized_pnl: number;
}

interface IntradayResponse {
  snapshots?: SnapshotRow[];
}

// Intraday total-P&L sparkline rendered with lightweight-charts —
// the same library that backs the Quality chart in Signals, picked
// up in Phase 2c. Phase 0–1 shipped a hand-rolled SVG; Phase 5
// unifies the chart story under one library.

interface PnlPoint {
  ts: number;
  total: number;
}

export function PnlMicrochartPanel() {
  const portfolio = usePortfolio("main");
  const [series, setSeries] = useState<PnlPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = (await getPortfolioSnapshots("main")) as IntradayResponse;
        if (cancelled || !data.snapshots) return;
        const today = new Date().toISOString().slice(0, 10);
        const todays = data.snapshots
          .filter((s) => s.snapshot_ts.startsWith(today))
          .map<PnlPoint>((s) => ({
            ts: Math.floor(new Date(s.snapshot_ts).getTime() / 1000),
            total: (s.realized_pnl ?? 0) + (s.unrealized_pnl ?? 0),
          }));
        setSeries(todays);
      } catch {
        if (!cancelled) setSeries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [portfolio?.equity]);

  const total = (portfolio?.total_realized_pnl ?? 0) + (portfolio?.total_unrealized_pnl ?? 0);
  const equity = portfolio?.equity ?? 0;
  const equityBase = equity > 0 ? equity - total : 0;
  const totalPct = equityBase > 0 ? (total / equityBase) * 100 : 0;
  const high = series.length > 0 ? Math.max(...series.map((p) => p.total)) : null;
  const low = series.length > 0 ? Math.min(...series.map((p) => p.total)) : null;

  return (
    <Panel title="P&L · Intraday" actions={["expand", "kebab"]}>
      <div
        style={{ padding: "10px 12px", height: "100%", display: "flex", flexDirection: "column" }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            className={`num ${pnlClass(total)}`}
            style={{ fontSize: 22, fontWeight: 600 }}
            aria-label={`total P&L ${usd(total, 0)}`}
          >
            {usd(total, 0)}
          </span>
          <span className={`num ${pnlClass(totalPct)}`} style={{ fontSize: 12 }}>
            {pct(totalPct, 2)}
          </span>
          <span style={{ flex: 1 }} />
          {high != null && low != null && (
            <span className="dim" style={{ fontSize: 10 }}>
              HI {signed(high, 0)} · LO {signed(low, 0)}
            </span>
          )}
        </div>
        <PnlChart series={series} positive={total >= 0} />
      </div>
    </Panel>
  );
}

function PnlChart({ series, positive }: { series: PnlPoint[]; positive: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  // The series data shape lightweight-charts wants. UTCTimestamp is
  // a number alias; cast through Time for the public API.
  const data = useMemo<AreaData[]>(
    () =>
      series.map((p) => ({
        time: p.ts as Time,
        value: p.total,
      })),
    [series],
  );

  useEffect(() => {
    if (!ref.current) return;
    const styles = getComputedStyle(document.body);
    const chart = createChart(ref.current, {
      layout: {
        background: { color: "transparent" },
        textColor: styles.getPropertyValue("--text-3").trim() || "#999",
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 9,
      },
      grid: {
        vertLines: { color: "transparent" },
        horzLines: { color: styles.getPropertyValue("--border-1").trim() || "#222" },
      },
      timeScale: {
        borderColor: styles.getPropertyValue("--border-1").trim() || "#222",
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: styles.getPropertyValue("--border-1").trim() || "#222",
      },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    // Re-create the area series with the active P&L sign's color.
    if (seriesRef.current) chartRef.current.removeSeries(seriesRef.current);
    const styles = getComputedStyle(document.body);
    const stroke = styles.getPropertyValue(positive ? "--pos" : "--neg").trim() || "#0f0";
    const series = chartRef.current.addSeries(AreaSeries, {
      lineColor: stroke,
      topColor: rgba(stroke, 0.35),
      bottomColor: rgba(stroke, 0.0),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    seriesRef.current = series;
  }, [positive]);

  useEffect(() => {
    seriesRef.current?.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  if (data.length < 2) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 96,
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-3)",
          fontSize: 11,
        }}
      >
        Not enough samples yet for a curve.
      </div>
    );
  }

  return <div ref={ref} style={{ flex: 1, minHeight: 96, marginTop: 6 }} aria-hidden />;
}

// lightweight-charts wants colors as `rgba(...)`. Resolved CSS
// custom-property values come back as oklch/hex/etc — for the area
// fill we need a translucent variant, so we just wrap whatever
// stroke string the theme provides through a CSS color-mix function
// when supported. Fallback: hardcoded rgba.
function rgba(color: string, alpha: number): string {
  // color-mix is widely supported in modern browsers; if the
  // resolved string is already alpha-aware, pass it through.
  return `color-mix(in oklch, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}
