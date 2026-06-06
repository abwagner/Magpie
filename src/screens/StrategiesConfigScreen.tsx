// ── Strategies Config Screen ──────────────────────────────────────
// Settings → Models → Strategies. Lists every (portfolio, strategy)
// pair from config/portfolios.json and lets the operator edit the
// strategy-level `config` knobs (cooldown timers, signal-staleness,
// per-strategy params) + `signal_interests` + `signal_staleness_seconds`.
//
// QF-59. v1 caveat: the strategy runner reads portfolios.json at boot,
// so saves take effect on next restart. Banner makes this explicit.

import { useCallback, useEffect, useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import {
  getStrategyConfig,
  listStrategyConfigs,
  setStrategyConfig,
  type StrategyConfigEntry,
  type StrategyConfigSummary,
} from "../lib/api.js";

interface DraftState {
  configJson: string;
  signalInterestsCsv: string;
  signalStalenessSec: string;
}

function entryToDraft(entry: StrategyConfigEntry): DraftState {
  return {
    configJson: JSON.stringify(entry.config, null, 2),
    signalInterestsCsv: entry.signal_interests.join(", "),
    signalStalenessSec: String(entry.signal_staleness_seconds),
  };
}

export function StrategiesConfigScreen() {
  const [summaries, setSummaries] = useState<StrategyConfigSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StrategyConfigSummary | null>(null);

  useEffect(() => {
    let mounted = true;
    listStrategyConfigs()
      .then((r) => {
        if (!mounted) return;
        setSummaries(r.strategies);
        if (r.strategies.length > 0 && !selected) setSelected(r.strategies[0] ?? null);
      })
      .catch((e: unknown) => {
        if (mounted) setListError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <ScreenHeader />
      {listError ? (
        <Panel title="Strategies">
          <div style={{ padding: 16 }} className="dim">
            Failed to load: <code>{listError}</code>
          </div>
        </Panel>
      ) : !summaries ? (
        <Panel title="Strategies">
          <div style={{ padding: 16 }} className="dim">
            Loading…
          </div>
        </Panel>
      ) : summaries.length === 0 ? (
        <Panel title="Strategies">
          <div style={{ padding: 16 }} className="dim">
            No strategies declared in <code>config/portfolios.json</code>.
          </div>
        </Panel>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 12 }}>
          <StrategyPicker
            summaries={summaries}
            selected={selected}
            onSelect={(s) => setSelected(s)}
          />
          {selected ? <StrategyEditor key={pickerKey(selected)} summary={selected} /> : null}
        </div>
      )}
    </div>
  );
}

function pickerKey(s: StrategyConfigSummary): string {
  return `${s.portfolio}::${s.id}`;
}

function ScreenHeader() {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="dim" style={{ fontSize: 11, letterSpacing: "0.06em" }}>
          Settings · Models · Strategies
        </span>
        <span className="badge accent">CONFIG/PORTFOLIOS.JSON · GIT-TRACKED</span>
      </div>
      <h2 style={{ margin: "6px 0 4px 0", fontSize: 16 }}>Strategies Config</h2>
      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5 }} className="dim">
        Strategy-level knobs the runner reads at boot.{" "}
        <strong>Saves take effect on next restart</strong> — the live runner caches its config at
        construction time. The <code>module</code> path is not editable here; change it in{" "}
        <code>config/portfolios.json</code> directly.
      </p>
    </div>
  );
}

function StrategyPicker({
  summaries,
  selected,
  onSelect,
}: {
  summaries: StrategyConfigSummary[];
  selected: StrategyConfigSummary | null;
  onSelect: (s: StrategyConfigSummary) => void;
}) {
  return (
    <Panel title="Strategies">
      <div style={{ display: "flex", flexDirection: "column" }}>
        {summaries.map((s) => {
          const isSel = selected && pickerKey(selected) === pickerKey(s);
          return (
            <button
              key={pickerKey(s)}
              type="button"
              onClick={() => onSelect(s)}
              style={{
                textAlign: "left",
                padding: "8px 10px",
                background: isSel ? "var(--bg-elev)" : "transparent",
                border: 0,
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{s.id}</strong>
                <span className="dim" style={{ fontSize: 10 }}>
                  {s.portfolio}
                </span>
              </div>
              <div className="dim" style={{ fontSize: 10, marginTop: 2 }}>
                {s.config_keys.length} key(s)
              </div>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function StrategyEditor({ summary }: { summary: StrategyConfigSummary }) {
  const [entry, setEntry] = useState<StrategyConfigEntry | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoadError(null);
    setSavedAt(null);
    setSaveError(null);
    getStrategyConfig(summary.id, summary.portfolio)
      .then((e) => {
        if (!mounted) return;
        setEntry(e);
        setDraft(entryToDraft(e));
      })
      .catch((err: unknown) => {
        if (mounted) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      mounted = false;
    };
  }, [summary]);

  const reset = useCallback(() => {
    if (entry) setDraft(entryToDraft(entry));
    setSaveError(null);
  }, [entry]);

  const save = useCallback(async () => {
    if (!draft || !entry) return;
    setSaving(true);
    setSaveError(null);
    try {
      let parsedConfig: Record<string, unknown>;
      try {
        parsedConfig = JSON.parse(draft.configJson);
      } catch (e) {
        throw new Error(`config: invalid JSON (${(e as Error).message})`);
      }
      if (
        typeof parsedConfig !== "object" ||
        parsedConfig === null ||
        Array.isArray(parsedConfig)
      ) {
        throw new Error("config: must be a JSON object");
      }
      const interests = draft.signalInterestsCsv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const staleness = Number(draft.signalStalenessSec);
      if (!Number.isFinite(staleness) || staleness < 0) {
        throw new Error("signal_staleness_seconds must be a non-negative number");
      }
      const updated = await setStrategyConfig(
        summary.id,
        {
          config: parsedConfig,
          signal_interests: interests,
          signal_staleness_seconds: staleness,
        },
        summary.portfolio,
      );
      setEntry(updated);
      setDraft(entryToDraft(updated));
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, entry, summary]);

  if (loadError) {
    return (
      <Panel title={summary.id}>
        <div style={{ padding: 12 }} className="dim">
          Failed to load: <code>{loadError}</code>
        </div>
      </Panel>
    );
  }
  if (!draft || !entry) {
    return (
      <Panel title={summary.id}>
        <div style={{ padding: 12 }} className="dim">
          Loading…
        </div>
      </Panel>
    );
  }

  const dirty =
    draft.configJson.trim() !== JSON.stringify(entry.config, null, 2).trim() ||
    draft.signalInterestsCsv !== entry.signal_interests.join(", ") ||
    draft.signalStalenessSec !== String(entry.signal_staleness_seconds);

  return (
    <Panel title={`${summary.id} · ${summary.portfolio}`}>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Module (read-only)" hint="Edit config/portfolios.json directly to change.">
          <input type="text" value={entry.module} readOnly className="input" disabled />
        </Field>
        <Field
          label="signal_interests"
          hint="NATS subjects, comma-separated. e.g. signals.vol-forecast-spy-1d.EQ.SPY"
        >
          <input
            type="text"
            className="input"
            value={draft.signalInterestsCsv}
            onChange={(e) => setDraft({ ...draft, signalInterestsCsv: e.target.value })}
          />
        </Field>
        <Field label="signal_staleness_seconds" hint="Drop signals older than this.">
          <input
            type="number"
            className="input"
            min={0}
            value={draft.signalStalenessSec}
            onChange={(e) => setDraft({ ...draft, signalStalenessSec: e.target.value })}
          />
        </Field>
        <Field label="config (JSON)" hint="Strategy-specific knobs (cooldown, DTE bounds, etc.)">
          <textarea
            className="input"
            style={{
              minHeight: 200,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              whiteSpace: "pre",
            }}
            value={draft.configJson}
            onChange={(e) => setDraft({ ...draft, configJson: e.target.value })}
          />
        </Field>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!dirty || saving}
            onClick={reset}
          >
            Reset
          </button>
          {savedAt ? (
            <span className="dim" style={{ fontSize: 11 }}>
              saved {savedAt.slice(11, 19)}Z · restart runner to apply
            </span>
          ) : null}
          {saveError ? (
            <span style={{ fontSize: 11, color: "var(--red)" }}>{saveError}</span>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {label}
      </span>
      {children}
      <span className="dim" style={{ fontSize: 10 }}>
        {hint}
      </span>
    </label>
  );
}
