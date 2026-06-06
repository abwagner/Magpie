import { Panel } from "../components/ui/Panel.js";
import { usePortfolio } from "../state/StateProvider.js";
import PayoffDiag, { type PayoffLeg } from "../components/PayoffDiag.js";
import type { Position } from "../types/portfolio.js";

// PayoffDiag works on intent-shaped legs (strike / DTE / IV / premium).
// PortfolioState.Position is the live position shape, which includes
// strike + iv only when the position is an option. This adapter
// pulls the option fields out (with fallbacks) and skips legs that
// can't be plotted.

function toLeg(p: Position): PayoffLeg | null {
  if (p.direction !== "Long" && p.direction !== "Short") return null;
  const optionType: PayoffLeg["type"] | null =
    p.symbol.includes(" C") || p.symbol.endsWith("C")
      ? "Call"
      : p.symbol.includes(" P") || p.symbol.endsWith("P")
        ? "Put"
        : null;
  // Only options carry strike + iv; everything else is treated as a
  // (synthetic) future for plot purposes.
  if (optionType) {
    const dte = p.expiration
      ? Math.max(0, Math.round((new Date(p.expiration).getTime() - Date.now()) / 86_400_000))
      : 0;
    const strikeMatch = /(\d+(?:\.\d+)?)\s*[CP]$/.exec(p.symbol);
    const strike = strikeMatch && strikeMatch[1] ? parseFloat(strikeMatch[1]) : p.entry_price;
    return {
      type: optionType,
      direction: p.direction,
      qty: Math.abs(p.quantity),
      multiplier: 100,
      strike,
      dte,
      iv: p.iv ?? 0.3,
      premium: p.entry_price,
    };
  }
  return {
    type: "Future",
    direction: p.direction,
    qty: Math.abs(p.quantity),
    multiplier: 1,
    entryPrice: p.entry_price,
  };
}

export function PayoffPanel() {
  const portfolio = usePortfolio("main");
  const positions = portfolio?.positions ?? [];
  const legs = positions.map(toLeg).filter((l): l is PayoffLeg => l !== null);
  const spot = positions.length > 0 ? (positions[0]?.current_price ?? 100) : 100;

  return (
    <Panel title="Payoff" actions={["expand", "kebab"]}>
      {legs.length === 0 ? (
        <Empty />
      ) : (
        <div style={{ padding: 8 }}>
          <PayoffDiag positions={legs} spotPrice={spot} scenarios={[]} />
        </div>
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
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      <div style={{ marginBottom: 4, color: "var(--text-2)" }}>No legs to plot.</div>
      <div className="dim2" style={{ fontSize: 11 }}>
        Stage a position from the Chain panel to see its payoff curve.
      </div>
    </div>
  );
}
