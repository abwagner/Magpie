import { useEffect, useMemo, useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import CurveChart from "../components/CurveChart.js";
import { num, usd, signed, pnlClass } from "../lib/numbers.js";
import { expirations as fetchExpirations, chain as fetchChain } from "../lib/api.js";
import { STRATEGY_TEMPLATES, STRATEGY_KINDS } from "../lib/strategies/option-strategy-templates.js";
import { buildStrategy } from "../lib/strategies/build-strategy.js";
import type { Contract } from "../types/market-data.js";
import type {
  BuiltStrategy,
  ChainsByExpiration,
  OptionStrategyKind,
} from "../types/option-strategy.js";

// ── StrategyBuilderPanel (QF-361) ────────────────────────────────────
// Operator-built named option structures (verticals, calendars/diagonals,
// straddles/strangles, condors/butterflies). Pick a symbol + structure +
// expiration(s); the panel fetches the chain(s), resolves the template's
// legs via the Stage-1 builder, and renders the resolved legs, combined
// greeks / P&L, and the expiration payoff. Pure analysis — no orders yet
// (the "Stage to order" action lands in a later stage).

interface BuildState {
  built: BuiltStrategy | null;
  error: string | null;
  loading: boolean;
}

export function StrategyBuilderPanel() {
  const [symbol, setSymbol] = useState("SPY");
  const [kind, setKind] = useState<OptionStrategyKind>("vertical-call-debit");
  const [expiries, setExpiries] = useState<string[]>([]);
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [multiplier, setMultiplier] = useState(100);
  const [state, setState] = useState<BuildState>({ built: null, error: null, loading: false });

  const template = STRATEGY_TEMPLATES[kind];
  const needsTwo = template.expirationsRequired === 2;

  // Load the expiration list whenever the symbol changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const exps = await fetchExpirations(symbol);
        if (cancelled) return;
        setExpiries(exps);
        setFront((f) => (exps.includes(f) ? f : (exps[0] ?? "")));
        setBack((b) => (exps.includes(b) ? b : (exps[1] ?? exps[0] ?? "")));
      } catch {
        if (!cancelled) setExpiries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  async function build() {
    if (!front) return;
    setState({ built: null, error: null, loading: true });
    try {
      const exps = needsTwo ? [front, back] : [front];
      const chains: ChainsByExpiration = new Map();
      for (const exp of [...new Set(exps)]) {
        const contracts: Contract[] = await fetchChain(symbol, exp, 60);
        chains.set(exp, contracts);
      }
      const built = buildStrategy(template, chains, { expirations: exps, multiplier });
      setState({ built, error: null, loading: false });
    } catch (e) {
      setState({ built: null, error: (e as Error).message, loading: false });
    }
  }

  const payoffData = useMemo(
    () =>
      state.built?.analytics.payoff.map((p) => ({ underlying: p.underlying, pnl: p.pnl })) ?? [],
    [state.built],
  );

  return (
    <Panel title="Strategy Builder" className="strategy-builder">
      <div className="strategy-builder__controls">
        <label>
          Symbol
          <input
            className="input"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())}
            style={{ width: 70 }}
          />
        </label>
        <label>
          Structure
          <select
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as OptionStrategyKind)}
          >
            {STRATEGY_KINDS.map((k) => (
              <option key={k} value={k}>
                {STRATEGY_TEMPLATES[k].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {needsTwo ? "Front" : "Expiry"}
          <select className="input" value={front} onChange={(e) => setFront(e.target.value)}>
            {expiries.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        {needsTwo && (
          <label>
            Back
            <select className="input" value={back} onChange={(e) => setBack(e.target.value)}>
              {expiries.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Mult
          <input
            className="input"
            type="number"
            value={multiplier}
            onChange={(e) => setMultiplier(Number(e.target.value) || 100)}
            style={{ width: 56 }}
          />
        </label>
        <button
          className="btn btn-primary"
          onClick={() => void build()}
          disabled={state.loading || !front}
        >
          {state.loading ? "Building…" : "Build"}
        </button>
      </div>

      {state.error && <div className="strategy-builder__error">{state.error}</div>}

      {state.built && <BuiltView built={state.built} payoffData={payoffData} />}
    </Panel>
  );
}

function BuiltView({
  built,
  payoffData,
}: {
  built: BuiltStrategy;
  payoffData: Record<string, number>[];
}) {
  const a = built.analytics;
  const spot = built.legs[0]?.contract.underlyingPrice;
  return (
    <div className="strategy-builder__result">
      <table className="strategy-builder__legs">
        <thead>
          <tr>
            <th>Side</th>
            <th>Type</th>
            <th>Strike</th>
            <th>Expiry</th>
            <th>×</th>
            <th>Mid</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {built.legs.map((leg, i) => (
            <tr key={i}>
              <td className={leg.side === "buy" ? "pos" : "neg"}>
                {leg.side === "buy" ? "+" : "−"}
              </td>
              <td>{leg.right === "call" ? "C" : "P"}</td>
              <td>{num(leg.contract.strike)}</td>
              <td>{leg.contract.expiration}</td>
              <td>{leg.ratio}</td>
              <td>{num(leg.contract.mid)}</td>
              <td>{num(leg.contract.delta, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="strategy-builder__stats">
        <Stat
          label={a.netDebit >= 0 ? "Net debit" : "Net credit"}
          value={usd(Math.abs(a.netDebit))}
          cls={a.netDebit >= 0 ? "neg" : "pos"}
        />
        <Stat
          label="Max profit"
          value={a.maxProfit === null ? "Unbounded" : usd(a.maxProfit)}
          cls="pos"
        />
        <Stat
          label="Max loss"
          value={a.maxLoss === null ? "Unbounded" : usd(a.maxLoss)}
          cls="neg"
        />
        <Stat
          label="Breakevens"
          value={a.breakevens.length ? a.breakevens.map((b) => num(b)).join(", ") : "—"}
        />
        <Stat label="Δ" value={signed(a.netDelta, 2)} cls={pnlClass(a.netDelta)} />
        <Stat label="Γ" value={signed(a.netGamma, 3)} />
        <Stat label="Θ" value={signed(a.netTheta, 2)} cls={pnlClass(a.netTheta)} />
        <Stat label="Vega" value={signed(a.netVega, 2)} />
      </div>

      <CurveChart
        data={payoffData}
        xKey="underlying"
        lines={[{ key: "pnl", label: "P/L at expiry" }]}
        xlabel="Underlying"
        ylabel="P/L ($)"
        zeroline
        spotLine={spot}
        height={220}
      />
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="strategy-builder__stat">
      <span className="strategy-builder__stat-label">{label}</span>
      <span className={`strategy-builder__stat-value${cls ? " " + cls : ""}`}>{value}</span>
    </div>
  );
}
