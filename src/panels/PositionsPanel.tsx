import { Panel } from "../components/ui/Panel.js";
import { usePortfolio } from "../state/StateProvider.js";
import { num, signed, pnlClass } from "../lib/numbers.js";

export function PositionsPanel() {
  const portfolio = usePortfolio("main");
  const positions = portfolio?.positions ?? [];

  return (
    <Panel title="Positions" count={positions.length} actions={["filter", "download", "kebab"]}>
      {positions.length === 0 ? (
        <Empty />
      ) : (
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th className="l">Symbol</th>
              <th>Qty</th>
              <th>Last</th>
              <th>Unreal</th>
              <th>Δ</th>
              <th>Γ</th>
              <th>ν</th>
              <th>θ/d</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.position_id}>
                <td className="l">
                  <span className="sym">{p.symbol}</span>{" "}
                  <span className="dim2">{p.direction === "Long" ? "L" : "S"}</span>
                </td>
                <td className={p.direction === "Short" ? "neg" : ""}>{num(p.quantity, 0)}</td>
                <td>{num(p.current_price)}</td>
                <td className={pnlClass(p.unrealized_pnl)}>{signed(p.unrealized_pnl, 0)}</td>
                <td>{p.delta.toFixed(2)}</td>
                <td>{p.gamma.toFixed(3)}</td>
                <td>{p.vega.toFixed(2)}</td>
                <td className={pnlClass(p.theta)}>{signed(p.theta, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Empty() {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        color: "var(--text-3)",
        fontSize: 12,
      }}
    >
      <div style={{ marginBottom: 6 }}>No open positions.</div>
      <div className="dim2">Stage one from the Build workspace.</div>
    </div>
  );
}
