import { Panel } from "../components/ui/Panel.js";
import { useRecentFills } from "../state/StateProvider.js";
import { num, signed, clock, pnlClass } from "../lib/numbers.js";

export function RecentFillsPanel() {
  const fills = useRecentFills();

  return (
    <Panel title="Recent Fills" count={fills.length} actions={["download", "kebab"]}>
      {fills.length === 0 ? (
        <Empty />
      ) : (
        <table className="tbl" style={{ fontSize: 11 }}>
          <thead>
            <tr>
              <th className="l">Time</th>
              <th className="l">Sym</th>
              <th className="l">Side</th>
              <th>Qty</th>
              <th>Px</th>
              <th>Slip</th>
              <th className="l">Broker</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => {
              const slip = (f as { slippage?: number }).slippage ?? 0;
              const buy = /buy|long/i.test(f.direction);
              return (
                <tr key={f.fill_id}>
                  <td className="l mono dim">{clock(f.filled_at)}</td>
                  <td className="l">
                    <span className="sym">{f.symbol}</span>
                  </td>
                  <td className={`l ${buy ? "pos" : "neg"}`}>{f.direction.toUpperCase()}</td>
                  <td>{num(f.quantity, 0)}</td>
                  <td>{num(f.price)}</td>
                  <td className={pnlClass(slip)}>{signed(slip, 2)}</td>
                  <td className="l dim">{f.broker}</td>
                </tr>
              );
            })}
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
      <div>No recent fills.</div>
      <div className="dim2" style={{ fontSize: 11, marginTop: 4 }}>
        Fills stream in via /ws/state as they happen.
      </div>
    </div>
  );
}
