import { Panel } from "../components/ui/Panel.js";
import { usePortfolio, useRiskLimits } from "../state/StateProvider.js";
import { signed, usd } from "../lib/numbers.js";

// Risk Headroom is the centerpiece of Operate. The bars show
// |current value| / threshold for each tracked limit; the warn
// marker sits at 70% (subtle tick), halt at 100% (red tick).
//
// Limits come from config/risk_limits.yaml via /ws/state's snapshot
// (the risk_limits block). Drawdown is stored as a dollar amount in
// PortfolioState and as a dollar threshold in RiskLimits, so the
// percentage display has been replaced with absolute USD.

const FALLBACK = {
  max_net_delta: 5_800,
  max_net_vega: 5_000,
  max_daily_loss: 25_000,
  max_drawdown: 10_000,
};

interface BarRow {
  label: string;
  fraction: number;
  current: string;
  threshold: string;
  warn: boolean;
}

export function RiskHeadroomPanel() {
  const portfolio = usePortfolio("main");
  const limitsCfg = useRiskLimits();
  // Phase 1: single hardcoded portfolio name. Phase 5 / multi-account
  // adds a portfolio selector that updates ui-store.
  const limits = {
    max_net_delta: limitsCfg?.portfolios.main?.max_net_delta ?? FALLBACK.max_net_delta,
    max_net_vega: limitsCfg?.portfolios.main?.max_net_vega ?? FALLBACK.max_net_vega,
    max_daily_loss: limitsCfg?.portfolios.main?.max_daily_loss ?? FALLBACK.max_daily_loss,
    max_drawdown: limitsCfg?.portfolios.main?.max_drawdown ?? FALLBACK.max_drawdown,
  };

  const rows: BarRow[] = portfolio
    ? buildRows(portfolio, limits)
    : [emptyRow("Net Δ"), emptyRow("Net Vega"), emptyRow("Daily loss"), emptyRow("Drawdown")];

  return (
    <Panel title="Risk Headroom" actions={["cog", "kebab"]}>
      <div style={{ padding: "10px 12px" }}>
        {rows.map((b) => (
          <Bar key={b.label} {...b} />
        ))}
        <Footer />
      </div>
    </Panel>
  );
}

interface PortfolioStateLite {
  net_delta?: number;
  net_vega?: number;
  daily_realized_pnl?: number;
  drawdown?: number;
}

interface ResolvedLimits {
  max_net_delta: number;
  max_net_vega: number;
  max_daily_loss: number;
  max_drawdown: number;
}

function buildRows(p: PortfolioStateLite, lim: ResolvedLimits): BarRow[] {
  const dailyLoss = Math.min(0, p.daily_realized_pnl ?? 0); // negative or zero
  const dd = p.drawdown ?? 0;
  return [
    bar(
      "Net Δ",
      Math.abs(p.net_delta ?? 0),
      lim.max_net_delta,
      signed(p.net_delta ?? 0, 0),
      `±${lim.max_net_delta.toLocaleString()}`,
    ),
    bar(
      "Net Vega",
      Math.abs(p.net_vega ?? 0),
      lim.max_net_vega,
      signed(p.net_vega ?? 0, 0),
      `±${lim.max_net_vega.toLocaleString()}`,
    ),
    bar(
      "Daily loss",
      Math.abs(dailyLoss),
      lim.max_daily_loss,
      usd(dailyLoss, 0),
      usd(-lim.max_daily_loss, 0),
    ),
    bar(
      "Drawdown",
      Math.abs(dd),
      lim.max_drawdown,
      usd(-Math.abs(dd), 0),
      usd(-lim.max_drawdown, 0),
    ),
  ];
}

function bar(
  label: string,
  current: number,
  max: number,
  currentFmt: string,
  thresholdFmt: string,
): BarRow {
  const f = max <= 0 ? 0 : Math.min(1.4, current / max);
  return {
    label,
    fraction: f,
    current: currentFmt,
    threshold: thresholdFmt,
    warn: f > 0.7,
  };
}

function emptyRow(label: string): BarRow {
  return { label, fraction: 0, current: "—", threshold: "—", warn: false };
}

function Bar({ label, fraction, current, threshold, warn }: BarRow) {
  const color = fraction >= 1 ? "var(--neg)" : fraction > 0.7 ? "var(--warn)" : "var(--pos)";
  return (
    <div style={{ marginBottom: 9 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          marginBottom: 3,
        }}
      >
        <span style={{ color: "var(--text-2)" }}>{label}</span>
        <span className="num" style={{ color: warn ? "var(--neg)" : "var(--text-1)" }}>
          <span className="dim">{threshold}</span>
          <span style={{ margin: "0 4px", color: "var(--text-4)" }}>·</span>
          {current}
        </span>
      </div>
      <div
        style={{
          position: "relative",
          height: 6,
          background: "var(--bg-input)",
        }}
        role="progressbar"
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: "70%",
            top: -2,
            bottom: -2,
            width: 1,
            background: "var(--text-4)",
          }}
        />
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: "100%",
            top: -2,
            bottom: -2,
            width: 1,
            background: "var(--neg-dim)",
          }}
        />
        <span
          aria-hidden
          style={{
            display: "block",
            width: `${Math.min(100, fraction * 100)}%`,
            height: "100%",
            background: color,
          }}
        />
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div
      style={{
        borderTop: "1px solid var(--border-1)",
        marginTop: 8,
        paddingTop: 8,
        fontSize: 10,
        color: "var(--text-3)",
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <span>
        thresholds: <span style={{ color: "var(--pos)" }}>●</span>&nbsp;&lt;70%&nbsp;
        <span style={{ color: "var(--warn)" }}>●</span>&nbsp;70–100%&nbsp;
        <span style={{ color: "var(--neg)" }}>●</span>&nbsp;&gt;100%
      </span>
      <span className="mono">config/risk_limits.yaml</span>
    </div>
  );
}
