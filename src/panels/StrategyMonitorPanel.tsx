import { useEffect, useMemo, useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import { num, signed, clock, pnlClass } from "../lib/numbers.js";
import type { Strategy } from "../types/strategy.js";

interface StrategyMonitorFill {
  fill_id: string;
  order_id: string;
  symbol: string;
  direction: string;
  price: number;
  quantity: number;
  fees: number | null;
  filled_at: string;
  slippage: number | null;
}

interface StrategyMonitorPnL {
  realized_pnl: number;
  entry_fill_id: string;
  entry_price: number;
  entry_date: string;
  exit_fill_id: string | null;
  exit_price: number | null;
  exit_date: string | null;
  symbol: string;
  direction: string;
  quantity: number;
  status: "open" | "closed";
}

interface StrategyMonitorData {
  strategy_id: string;
  recent_fills: StrategyMonitorFill[];
  pnl_records: StrategyMonitorPnL[];
  total_realized_pnl: number;
}

export interface StrategyMonitorPanelProps {
  strategy: Strategy | null;
}

export function StrategyMonitorPanel({ strategy }: StrategyMonitorPanelProps) {
  const [data, setData] = useState<StrategyMonitorData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!strategy) {
      setData(null);
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`/api/strategies/${encodeURIComponent(strategy.id)}/monitor`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json() as Promise<StrategyMonitorData>;
      })
      .then((result) => {
        setData(result);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [strategy?.id]);

  if (!strategy) {
    return (
      <Panel title="Monitor">
        <div className="dim" style={{ padding: 16, fontSize: 12 }}>
          Pick a strategy on the left.
        </div>
      </Panel>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 8,
        height: "100%",
        overflow: "auto",
      }}
    >
      <Panel
        title="Monitor"
        headerExtra={
          <span className="dim" style={{ fontSize: 11 }}>
            {strategy.id}
          </span>
        }
      >
        {loading ? (
          <div className="dim" style={{ padding: 16, fontSize: 12 }}>
            Loading…
          </div>
        ) : error ? (
          <div className="neg" style={{ padding: 16, fontSize: 12 }}>
            Error: {error}
          </div>
        ) : !data ? (
          <div className="dim" style={{ padding: 16, fontSize: 12 }}>
            No data.
          </div>
        ) : (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 16 }}>
            <PnLSummary data={data} />
            <RecentFillsSection fills={data.recent_fills} />
            <PnLRecordsSection records={data.pnl_records} />
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── P&L Summary ────────────────────────────────────────────────────────

function PnLSummary({ data }: { data: StrategyMonitorData }) {
  return (
    <div>
      <SectionLabel>Realized P&L</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 8,
          alignItems: "center",
          padding: 8,
          background: "var(--bg-app)",
          borderRadius: "var(--r-2)",
        }}
      >
        <span className="dim2" style={{ fontSize: 11 }}>
          Total closed trades:
        </span>
        <span className={`mono ${pnlClass(data.total_realized_pnl)}`} style={{ fontWeight: 600 }}>
          {signed(data.total_realized_pnl, 2)}
        </span>
      </div>
    </div>
  );
}

// ── Recent Fills ───────────────────────────────────────────────────────

function RecentFillsSection({ fills }: { fills: StrategyMonitorFill[] }) {
  if (fills.length === 0) {
    return (
      <div>
        <SectionLabel>Recent Fills</SectionLabel>
        <div className="dim2" style={{ fontSize: 11, padding: 8 }}>
          No fills.
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionLabel>Recent Fills (50 most recent)</SectionLabel>
      <table className="tbl" style={{ fontSize: 10, width: "100%" }}>
        <thead>
          <tr>
            <th className="l">Time</th>
            <th className="l">Symbol</th>
            <th className="l">Side</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Slip</th>
            <th>Fees</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f) => {
            const buy = /buy|long/i.test(f.direction);
            const slip = f.slippage ?? 0;
            return (
              <tr key={f.fill_id}>
                <td className="l mono dim" style={{ fontSize: 10 }}>
                  {clock(f.filled_at)}
                </td>
                <td className="l">
                  <span className="sym" style={{ fontSize: 10 }}>
                    {f.symbol}
                  </span>
                </td>
                <td className={`l ${buy ? "pos" : "neg"}`} style={{ fontSize: 10 }}>
                  {f.direction.toUpperCase()}
                </td>
                <td style={{ fontSize: 10 }}>{num(f.quantity, 0)}</td>
                <td style={{ fontSize: 10 }}>{num(f.price)}</td>
                <td className={pnlClass(slip)} style={{ fontSize: 10 }}>
                  {signed(slip, 2)}
                </td>
                <td style={{ fontSize: 10, textAlign: "right" }}>
                  {f.fees !== null ? num(f.fees, 2) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── P&L Records ────────────────────────────────────────────────────────

function PnLRecordsSection({ records }: { records: StrategyMonitorPnL[] }) {
  if (records.length === 0) {
    return (
      <div>
        <SectionLabel>Trades</SectionLabel>
        <div className="dim2" style={{ fontSize: 11, padding: 8 }}>
          No trade records.
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionLabel>Trades (100 most recent)</SectionLabel>
      <table className="tbl" style={{ fontSize: 10, width: "100%" }}>
        <thead>
          <tr>
            <th className="l">Symbol</th>
            <th className="l">Side</th>
            <th>Qty</th>
            <th>Entry</th>
            <th>Entry Time</th>
            <th>Exit</th>
            <th>Exit Time</th>
            <th>P&L</th>
            <th className="l">Status</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r, idx) => {
            const buy = /buy|long/i.test(r.direction);
            return (
              <tr key={`${r.entry_fill_id}-${idx}`}>
                <td className="l">
                  <span className="sym" style={{ fontSize: 10 }}>
                    {r.symbol}
                  </span>
                </td>
                <td className={`l ${buy ? "pos" : "neg"}`} style={{ fontSize: 10 }}>
                  {r.direction.toUpperCase()}
                </td>
                <td style={{ fontSize: 10 }}>{num(r.quantity, 0)}</td>
                <td style={{ fontSize: 10 }}>{num(r.entry_price)}</td>
                <td className="l mono dim" style={{ fontSize: 9 }}>
                  {clock(r.entry_date)}
                </td>
                <td style={{ fontSize: 10 }}>
                  {r.exit_price !== null ? num(r.exit_price) : "—"}
                </td>
                <td className="l mono dim" style={{ fontSize: 9 }}>
                  {r.exit_date ? clock(r.exit_date) : "—"}
                </td>
                <td className={pnlClass(r.realized_pnl)} style={{ fontSize: 10, fontWeight: 600 }}>
                  {signed(r.realized_pnl, 2)}
                </td>
                <td
                  className={`l dim2 ${r.status === "open" ? "warn" : ""}`}
                  style={{ fontSize: 10 }}
                >
                  {r.status.toUpperCase()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dim"
      style={{
        fontSize: 9,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}
