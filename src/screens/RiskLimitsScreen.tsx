import { useEffect, useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import { useRiskLimits } from "../state/StateProvider.js";
import { setRiskLimits } from "../lib/api.js";
import type { RiskLimits } from "../types/portfolio.js";

const FIELDS: { key: keyof RiskLimits; label: string; hint: string }[] = [
  { key: "max_net_delta", label: "Max net Δ", hint: "absolute Δ cap" },
  { key: "max_net_vega", label: "Max net Vega", hint: "absolute ν cap" },
  { key: "max_daily_loss", label: "Max daily loss", hint: "negative-USD cap" },
  { key: "max_symbol_concentration", label: "Max symbol %", hint: "% of NAV" },
  { key: "max_drawdown", label: "Max drawdown", hint: "USD" },
  { key: "max_order_size", label: "Max order size", hint: "qty per intent" },
  { key: "max_open_orders", label: "Max open orders", hint: "concurrent" },
];

export function RiskLimitsScreen() {
  const cfg = useRiskLimits();
  const portfolios = Object.keys(cfg?.portfolios ?? {});
  const [selected, setSelected] = useState<string>(portfolios[0] ?? "main");

  useEffect(() => {
    if (!portfolios.includes(selected) && portfolios[0]) setSelected(portfolios[0]);
  }, [portfolios, selected]);

  const current = cfg?.portfolios[selected] ?? null;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <ScreenHeader
        crumb="Settings · Risk · Limits"
        title="Risk Limits"
        right={
          <span className="badge accent" style={{ marginLeft: 12 }}>
            CONFIG/RISK_LIMITS.YAML · GIT-TRACKED
          </span>
        }
        body="Per-portfolio caps that the order plane enforces before submit. Saving writes to config/risk_limits.yaml; the engine reloads the YAML at next boot."
      />
      <PortfolioPicker portfolios={portfolios} selected={selected} onSelect={setSelected} />
      {current ? (
        <LimitsForm
          portfolio={selected}
          limits={current}
          key={selected /* reset draft on switch */}
        />
      ) : (
        <Panel title="—">
          <div style={{ padding: 24, textAlign: "center", fontSize: 12 }} className="dim">
            No limits configured for portfolio <code>{selected}</code>.
          </div>
        </Panel>
      )}
    </div>
  );
}

function PortfolioPicker({
  portfolios,
  selected,
  onSelect,
}: {
  portfolios: string[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  if (portfolios.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
      <span className="dim" style={{ letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Portfolio
      </span>
      {portfolios.map((id) => (
        <button
          key={id}
          type="button"
          className={`btn ${id === selected ? "btn-primary" : "btn-ghost"}`}
          style={{ height: 22, padding: "0 10px", fontSize: 11 }}
          onClick={() => onSelect(id)}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

function LimitsForm({ portfolio, limits }: { portfolio: string; limits: RiskLimits }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => formatDraft(limits));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  function update(key: string, raw: string) {
    setDraft((d) => ({ ...d, [key]: raw }));
  }

  function reset() {
    setDraft(formatDraft(limits));
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next: Record<string, number | null> = {};
      for (const f of FIELDS) {
        const raw = draft[f.key]?.trim() ?? "";
        if (raw === "" || raw === "—") {
          next[f.key] = null;
          continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new Error(`${f.label}: must be a number or empty`);
        }
        next[f.key] = n;
      }
      await setRiskLimits(portfolio, next as unknown as RiskLimits);
      setSavedAt(new Date().toLocaleTimeString("en-US", { hour12: false }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const dirty = FIELDS.some(
    (f) => draft[f.key] !== (limits[f.key] == null ? "" : String(limits[f.key])),
  );

  return (
    <Panel title={`Limits · ${portfolio}`} actions={["kebab"]}>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {FIELDS.map((f) => (
          <div
            key={f.key}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 160px 1fr",
              alignItems: "center",
              gap: 10,
              fontSize: 12,
            }}
          >
            <label style={{ color: "var(--text-2)" }}>{f.label}</label>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={draft[f.key] ?? ""}
              onChange={(e) => update(f.key, e.target.value)}
              placeholder="—"
            />
            <span className="dim2" style={{ fontSize: 10 }}>
              {f.hint}
            </span>
          </div>
        ))}
        {error && (
          <div className="neg" style={{ fontSize: 11 }}>
            {error}
          </div>
        )}
        {savedAt && !dirty && (
          <div className="dim" style={{ fontSize: 10 }}>
            Saved at {savedAt}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={reset}
            disabled={!dirty || saving}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function formatDraft(limits: RiskLimits): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = limits[f.key];
    out[f.key] = v == null ? "" : String(v);
  }
  return out;
}

export function ScreenHeader({
  crumb,
  title,
  right,
  body,
}: {
  crumb: string;
  title: string;
  right?: React.ReactNode;
  body?: string;
}) {
  return (
    <div>
      <div className="dim mono" style={{ fontSize: 11 }}>
        {crumb}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2
          style={{
            margin: "2px 0 6px",
            fontSize: 16,
            fontWeight: 600,
            color: "var(--text-1)",
            fontFamily: "var(--font-display)",
          }}
        >
          {title}
        </h2>
        {right}
      </div>
      {body && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
          {body}
        </div>
      )}
    </div>
  );
}
