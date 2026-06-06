import { useCallback, useEffect, useMemo, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import {
  applyRiskPolicy,
  deleteRiskPolicy,
  getRiskPolicies,
  upsertRiskPolicy,
} from "../lib/api.js";
import { useRiskLimits } from "../state/StateProvider.js";
import type { RiskLimits } from "../types/portfolio.js";
import type { RiskPoliciesConfig, RiskPolicy } from "../types/risk-policies.js";

// Settings · Risk · Policies (QF-57)
//
// Named bundles of RiskLimits ("Standard", "Tight overnight",
// "Earnings week") that an operator applies to a portfolio in one
// click. Stored in config/risk_policies.yaml; applying copies a
// policy's `limits` into risk_limits.yaml via the existing
// RiskLimitsStore. Read-only consumer for now — kill-switch
// sensitivity and execution_mode bundling are deferred (portfolios.json
// has no mutation API today).

const LIMIT_FIELDS: { key: keyof RiskLimits; label: string; hint: string }[] = [
  { key: "max_net_delta", label: "Max net Δ", hint: "absolute Δ cap" },
  { key: "max_net_vega", label: "Max net Vega", hint: "absolute ν cap" },
  { key: "max_daily_loss", label: "Max daily loss", hint: "negative-USD cap" },
  { key: "max_symbol_concentration", label: "Max symbol %", hint: "% of NAV" },
  { key: "max_drawdown", label: "Max drawdown", hint: "USD" },
  { key: "max_order_size", label: "Max order size", hint: "qty per intent" },
  { key: "max_open_orders", label: "Max open orders", hint: "concurrent" },
];

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function RiskPoliciesScreen() {
  const [config, setConfig] = useState<RiskPoliciesConfig | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await getRiskPolicies();
      setConfig(cfg);
      setSelected((prev) => {
        if (prev && cfg.policies[prev]) return prev;
        return Object.keys(cfg.policies)[0] ?? null;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function startNewPolicy() {
    // Insert a draft policy with a unique placeholder id. Saving will
    // collapse into the real id the user typed; until then it lives
    // only in the local draft state of <PolicyEditor>.
    let candidate = "new-policy";
    let i = 1;
    while (config?.policies[candidate]) {
      i += 1;
      candidate = `new-policy-${i}`;
    }
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            policies: {
              ...prev.policies,
              [candidate]: { name: "New policy", limits: blankLimits() },
            },
          }
        : prev,
    );
    setSelected(candidate);
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · Risk · Policies"
        title="Risk policies"
        right={
          <span className="badge accent" style={{ marginLeft: 12 }}>
            CONFIG/RISK_POLICIES.YAML · GIT-TRACKED
          </span>
        }
        body="Named bundles of risk limits. Apply a policy to a portfolio in one click; values are copied into config/risk_limits.yaml. Execution-mode and kill-switch bundling are deferred (require portfolios.json mutation API)."
      />
      {loading && !config ? (
        <div className="dim" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : error ? (
        <div className="neg" style={{ fontSize: 12 }}>
          Failed to load: {error}
        </div>
      ) : config ? (
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 12 }}>
          <PolicyList
            config={config}
            selected={selected}
            onSelect={setSelected}
            onNew={startNewPolicy}
          />
          {selected && config.policies[selected] ? (
            <PolicyEditor
              key={selected /* reset draft on switch */}
              id={selected}
              policy={config.policies[selected]}
              onSaved={(cfg, savedId) => {
                setConfig(cfg);
                setSelected(savedId);
              }}
              onDeleted={(cfg) => {
                setConfig(cfg);
                setSelected(Object.keys(cfg.policies)[0] ?? null);
              }}
            />
          ) : (
            <div
              className="dim"
              style={{ padding: 24, fontSize: 12, border: "1px dashed var(--border-1)" }}
            >
              No policy selected. Use “+ New policy” to create one.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PolicyList({
  config,
  selected,
  onSelect,
  onNew,
}: {
  config: RiskPoliciesConfig;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const ids = Object.keys(config.policies).sort();
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 8,
        height: "fit-content",
      }}
    >
      <div className="dim" style={{ fontSize: 11, padding: "4px 6px 8px" }}>
        Policies
      </div>
      {ids.length === 0 && (
        <div className="dim2" style={{ fontSize: 11, padding: "4px 6px" }}>
          No policies defined.
        </div>
      )}
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          style={{
            width: "100%",
            textAlign: "left",
            padding: "6px 8px",
            border: "none",
            background: selected === id ? "var(--bg-elev)" : "transparent",
            borderLeft: selected === id ? "2px solid var(--accent)" : "2px solid transparent",
            cursor: "pointer",
            fontFamily: "var(--font-ui)",
            fontSize: 12,
            color: selected === id ? "var(--text-1)" : "var(--text-2)",
          }}
        >
          <div className="mono" style={{ fontSize: 11 }}>
            {id}
          </div>
          <div className="dim2" style={{ fontSize: 10 }}>
            {config.policies[id]?.name ?? ""}
          </div>
        </button>
      ))}
      <button
        type="button"
        onClick={onNew}
        style={{
          marginTop: 8,
          width: "100%",
          padding: "6px 8px",
          border: "1px dashed var(--border-1)",
          background: "transparent",
          color: "var(--text-3)",
          fontSize: 11,
          cursor: "pointer",
          borderRadius: "var(--r-2)",
          fontFamily: "var(--font-ui)",
        }}
      >
        + New policy
      </button>
    </div>
  );
}

// ── Editor ─────────────────────────────────────────────────────────

function PolicyEditor({
  id,
  policy,
  onSaved,
  onDeleted,
}: {
  id: string;
  policy: RiskPolicy;
  onSaved: (cfg: RiskPoliciesConfig, savedId: string) => void;
  onDeleted: (cfg: RiskPoliciesConfig) => void;
}) {
  const [draftId, setDraftId] = useState(id);
  const [name, setName] = useState(policy.name);
  const [description, setDescription] = useState(policy.description ?? "");
  const [limits, setLimits] = useState<RiskLimits>(policy.limits);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const limitsCfg = useRiskLimits();
  const portfolioIds = useMemo(
    () => (limitsCfg ? Object.keys(limitsCfg.portfolios).sort() : []),
    [limitsCfg],
  );
  const [applyTarget, setApplyTarget] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [appliedAt, setAppliedAt] = useState<{ portfolio: string; at: number } | null>(null);

  useEffect(() => {
    setApplyTarget((prev) => prev || portfolioIds[0] || "");
  }, [portfolioIds]);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const trimmedId = draftId.trim();
      if (!ID_PATTERN.test(trimmedId)) {
        throw new Error("Policy id must match [A-Za-z0-9_-]+");
      }
      if (!name.trim()) {
        throw new Error("Name is required");
      }
      const payload: RiskPolicy = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        limits,
      };
      // If the user renamed the id, delete the old entry first so the
      // yaml ends up clean. We swallow ENOENT-like errors because a
      // brand-new draft has no persisted old entry yet.
      if (trimmedId !== id) {
        try {
          await deleteRiskPolicy(id);
        } catch {
          /* swallow — the draft id may not exist on disk */
        }
      }
      const cfg = await upsertRiskPolicy(trimmedId, payload);
      onSaved(cfg, trimmedId);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!confirm(`Delete policy “${name}”?`)) return;
    try {
      const cfg = await deleteRiskPolicy(id);
      onDeleted(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onApply() {
    if (!applyTarget) return;
    if (
      !confirm(
        `Apply “${name}” to portfolio ${applyTarget}? This overwrites the portfolio's current risk limits in config/risk_limits.yaml.`,
      )
    ) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await applyRiskPolicy(id, applyTarget);
      setAppliedAt({ portfolio: applyTarget, at: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  function updateLimit(key: keyof RiskLimits, raw: string) {
    setLimits((prev) => {
      if (raw.trim() === "") return { ...prev, [key]: null };
      const n = Number(raw);
      if (Number.isNaN(n)) return prev;
      return { ...prev, [key]: n };
    });
  }

  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header: id + name */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "120px 1fr",
          gap: 8,
          alignItems: "center",
          fontSize: 12,
        }}
      >
        <label className="dim">Policy id</label>
        <input
          type="text"
          value={draftId}
          onChange={(e) => setDraftId(e.target.value)}
          style={textInputStyle}
        />
        <label className="dim">Display name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={textInputStyle}
        />
        <label className="dim">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="optional"
          style={textInputStyle}
        />
      </div>

      {/* Limits grid */}
      <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
        Limits
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {LIMIT_FIELDS.map((f) => (
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
              type="text"
              inputMode="decimal"
              value={limits[f.key] == null ? "" : String(limits[f.key])}
              onChange={(e) => updateLimit(f.key, e.target.value)}
              placeholder="—"
              style={textInputStyle}
            />
            <span className="dim2" style={{ fontSize: 10 }}>
              {f.hint}
            </span>
          </div>
        ))}
      </div>

      {/* Save + delete row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={saving}
          style={btnStyle(true)}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => void onDelete()} style={btnStyle(false)}>
          Delete
        </button>
        {savedAt && !error && (
          <span className="pos" style={{ fontSize: 11 }}>
            Saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Apply row */}
      <div
        style={{
          borderTop: "1px solid var(--border-1)",
          paddingTop: 10,
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 12,
        }}
      >
        <span className="dim">Apply to</span>
        <select
          value={applyTarget}
          onChange={(e) => setApplyTarget(e.target.value)}
          disabled={portfolioIds.length === 0}
          style={{ ...textInputStyle, width: 200, fontFamily: "var(--font-mono)" }}
        >
          {portfolioIds.length === 0 ? (
            <option value="">(no portfolios loaded)</option>
          ) : (
            portfolioIds.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          onClick={() => void onApply()}
          disabled={applying || !applyTarget}
          style={btnStyle(true)}
        >
          {applying ? "Applying…" : "Apply"}
        </button>
        {appliedAt && !error && (
          <span className="pos" style={{ fontSize: 11 }}>
            Applied to {appliedAt.portfolio} at {new Date(appliedAt.at).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div className="neg" style={{ fontSize: 11 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function blankLimits(): RiskLimits {
  return {
    max_net_delta: null,
    max_net_vega: null,
    max_daily_loss: null,
    max_symbol_concentration: null,
    max_drawdown: null,
    max_order_size: null,
    max_open_orders: null,
  };
}

const textInputStyle: React.CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border-1)",
  borderRadius: "var(--r-2)",
  padding: "4px 8px",
  fontSize: 12,
  color: "var(--text-1)",
  fontFamily: "var(--font-mono)",
};

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    background: primary ? "var(--accent)" : "var(--bg-elev)",
    color: primary ? "var(--text-1)" : "var(--text-2)",
    border: "1px solid var(--border-1)",
    borderRadius: "var(--r-2)",
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "var(--font-ui)",
  };
}
