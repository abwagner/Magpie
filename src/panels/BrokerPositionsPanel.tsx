import { useEffect, useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import { useUI } from "../state/ui-store.js";
import { useConnectionStatus } from "../state/StateProvider.js";
import { getPositions } from "../lib/api.js";
import { num, signed, pnlClass } from "../lib/numbers.js";
import type {
  BrokerPositions,
  BrokerOptionPosition,
  BrokerEquityPosition,
  BrokerFuturesPosition,
} from "../types/broker.js";

// Live broker positions from /api/positions (Schwab today). Reads
// the selected account from ui-store; the Header AccountSelector
// drives the picker. Refresh-on-mount + a manual refresh button —
// this isn't streamed via /ws/state, so changes since the last
// fetch (a fill that just happened) won't appear until refresh.
//
// Engine-driven positions (the system's internal view, synthesized
// from the fill log) live in PositionsPanel and are wired to
// /ws/state. The two are intentionally separate panels: this one is
// "what the broker says I own", the other is "what my system thinks
// I own". They diverge during reconciliation drift.

export function BrokerPositionsPanel() {
  const account = useUI((s) => s.selectedAccount);
  const { connected } = useConnectionStatus();
  const [data, setData] = useState<BrokerPositions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await getPositions(account || undefined);
      setData(res);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const options = data?.options ?? [];
  const equities = data?.equities ?? [];
  const futures = data?.futures ?? [];
  const total = options.length + equities.length + futures.length;

  return (
    <Panel
      title="Broker Positions"
      count={total}
      headerExtra={
        <button
          type="button"
          className="btn btn-ghost"
          style={{ height: 22, padding: "0 8px", fontSize: 11 }}
          disabled={loading || !connected}
          onClick={load}
          aria-label="refresh broker positions"
        >
          {loading ? "…" : "Refresh"}
        </button>
      }
      actions={["filter", "kebab"]}
    >
      {error && (
        <div className="neg" style={{ padding: 12, fontSize: 11 }}>
          {error}
        </div>
      )}
      {!error && data == null && !loading && (
        <Empty hint="Pick an account in the header dropdown, or click Refresh." />
      )}
      {!error && data != null && total === 0 && (
        <Empty hint={account ? "Account is empty." : "No positions in any account."} />
      )}
      {!error && total > 0 && (
        <>
          {options.length > 0 && <OptionsTable rows={options} />}
          {futures.length > 0 && <FuturesTable rows={futures} />}
          {equities.length > 0 && <EquitiesTable rows={equities} />}
        </>
      )}
    </Panel>
  );
}

function Empty({ hint }: { hint: string }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        color: "var(--text-3)",
        fontSize: 12,
      }}
    >
      <div style={{ marginBottom: 4, color: "var(--text-2)" }}>No broker positions.</div>
      <div className="dim2" style={{ fontSize: 11 }}>
        {hint}
      </div>
    </div>
  );
}

function OptionsTable({ rows }: { rows: BrokerOptionPosition[] }) {
  return (
    <table className="tbl" style={{ fontSize: 11 }}>
      <thead>
        <tr>
          <th
            className="l"
            colSpan={9}
            style={{ background: "var(--bg-app)", fontSize: 10, color: "var(--text-3)" }}
          >
            OPTIONS · {rows.length}
          </th>
        </tr>
        <tr>
          <th className="l">Symbol</th>
          <th>Qty</th>
          <th>Avg</th>
          <th>Mkt Val</th>
          <th>Day P&L</th>
          <th>Unreal P&L</th>
          <th>Δ</th>
          <th>Γ</th>
          <th>ν</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.symbol}>
            <td className="l">
              <span className="sym">{p.underlying}</span>{" "}
              <span className="dim2">
                {p.strike} {p.side === "call" ? "C" : "P"} {p.expiration}
              </span>
            </td>
            <td className={p.quantity < 0 ? "neg" : ""}>{num(p.quantity, 0)}</td>
            <td>{num(p.averageCost)}</td>
            <td>{num(p.marketValue, 0)}</td>
            <td className={pnlClass(p.dayPnl)}>{signed(p.dayPnl, 0)}</td>
            <td className={pnlClass(p.unrealizedPnl)}>{signed(p.unrealizedPnl, 0)}</td>
            <td>{p.delta != null ? p.delta.toFixed(2) : "—"}</td>
            <td>{p.gamma != null ? p.gamma.toFixed(3) : "—"}</td>
            <td>{p.vega != null ? p.vega.toFixed(2) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FuturesTable({ rows }: { rows: BrokerFuturesPosition[] }) {
  return (
    <table className="tbl" style={{ fontSize: 11 }}>
      <thead>
        <tr>
          <th
            className="l"
            colSpan={6}
            style={{ background: "var(--bg-app)", fontSize: 10, color: "var(--text-3)" }}
          >
            FUTURES · {rows.length}
          </th>
        </tr>
        <tr>
          <th className="l">Contract</th>
          <th>Qty</th>
          <th>Avg</th>
          <th>Mkt Val</th>
          <th>Day P&L</th>
          <th>Unreal P&L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.symbol}>
            <td className="l">
              <span className="sym">{p.symbol}</span> <span className="dim2">{p.root}</span>
            </td>
            <td className={p.quantity < 0 ? "neg" : ""}>{num(p.quantity, 0)}</td>
            <td>{num(p.averageCost)}</td>
            <td>{num(p.marketValue, 0)}</td>
            <td className={pnlClass(p.dayPnl)}>{signed(p.dayPnl, 0)}</td>
            <td className={pnlClass(p.unrealizedPnl)}>{signed(p.unrealizedPnl, 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EquitiesTable({ rows }: { rows: BrokerEquityPosition[] }) {
  return (
    <table className="tbl" style={{ fontSize: 11 }}>
      <thead>
        <tr>
          <th
            className="l"
            colSpan={6}
            style={{ background: "var(--bg-app)", fontSize: 10, color: "var(--text-3)" }}
          >
            EQUITIES · {rows.length}
          </th>
        </tr>
        <tr>
          <th className="l">Symbol</th>
          <th>Qty</th>
          <th>Avg</th>
          <th>Mkt Val</th>
          <th>Day P&L</th>
          <th>Unreal P&L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.symbol}>
            <td className="l">
              <span className="sym">{p.symbol}</span>
            </td>
            <td className={p.quantity < 0 ? "neg" : ""}>{num(p.quantity, 0)}</td>
            <td>{num(p.averageCost)}</td>
            <td>{num(p.marketValue, 0)}</td>
            <td className={pnlClass(p.dayPnl)}>{signed(p.dayPnl, 0)}</td>
            <td className={pnlClass(p.unrealizedPnl)}>{signed(p.unrealizedPnl, 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
