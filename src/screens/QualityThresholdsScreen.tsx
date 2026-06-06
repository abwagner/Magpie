import { useCallback, useEffect, useMemo, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { getQualityThresholds, setModelQualityThresholds } from "../lib/api.js";
import type {
  MetricThresholds,
  ModelThresholds,
  QualityThresholdsConfig,
} from "../types/quality-thresholds.js";

// Settings · Models · Quality thresholds (QF-54)
//
// Edit per-model thresholds that flip a model's status badge from
// healthy → degraded → failed. Stored in config/quality_thresholds.yaml;
// the server's `classifyModel(metrics, thresholds)` is the single
// pure consumer (Signals workspace's Quality chart will call into it
// when wired up).
//
// Each metric has four optional cutoffs:
//   - degraded_above / failed_above (higher = worse, e.g. rmse)
//   - degraded_below / failed_below (lower = worse, e.g. accuracy)
// At least one side of a pair must be set; both can be set together.

// ── Field metadata ─────────────────────────────────────────────────

const FIELD_LABELS: Record<keyof MetricThresholds, string> = {
  degraded_above: "Degraded above",
  failed_above: "Failed above",
  degraded_below: "Degraded below",
  failed_below: "Failed below",
};

const FIELD_HINTS: Record<keyof MetricThresholds, string> = {
  degraded_above: "Value above this → degraded (higher is worse)",
  failed_above: "Value above this → failed",
  degraded_below: "Value below this → degraded (lower is worse)",
  failed_below: "Value below this → failed",
};

// ── Screen ─────────────────────────────────────────────────────────

export function QualityThresholdsScreen() {
  const [config, setConfig] = useState<QualityThresholdsConfig | null>(null);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await getQualityThresholds();
      setConfig(cfg);
      // Model IDs come from the thresholds config (signal subsystem retired
      // in QF-261 — /api/models no longer exists).
      const ids = new Set<string>(Object.keys(cfg.models));
      const sorted = [...ids].sort();
      setModelIds(sorted);
      setSelected((prev) => prev ?? sorted[0] ?? null);
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

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · Models · Quality thresholds"
        title="Quality thresholds"
        right={
          <span className="badge accent" style={{ marginLeft: 12 }}>
            CONFIG/QUALITY_THRESHOLDS.YAML · GIT-TRACKED
          </span>
        }
        body="Per-model cutoffs that flip the model's health badge (healthy → degraded → failed). Saving writes to config/quality_thresholds.yaml; server's classifyModel() is the single consumer."
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
        <>
          <ModelPicker modelIds={modelIds} selected={selected} onSelect={setSelected} />
          {selected ? (
            <ModelForm
              key={selected /* reset draft on switch */}
              modelId={selected}
              initial={config.models[selected] ?? { metrics: {} }}
              defaults={config.defaults}
              onSaved={(updated) => setConfig(updated)}
            />
          ) : (
            <div className="dim" style={{ fontSize: 12, padding: 12 }}>
              No models registered.
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function ModelPicker({
  modelIds,
  selected,
  onSelect,
}: {
  modelIds: string[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <label className="dim" style={{ fontSize: 12 }}>
        Model
      </label>
      <select
        value={selected ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          background: "var(--bg-pane)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--r-2)",
          padding: "4px 8px",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "var(--text-1)",
        }}
      >
        {modelIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Per-model form ─────────────────────────────────────────────────

function ModelForm({
  modelId,
  initial,
  defaults,
  onSaved,
}: {
  modelId: string;
  initial: ModelThresholds;
  defaults: ModelThresholds;
  onSaved: (cfg: QualityThresholdsConfig) => void;
}) {
  // Merge defaults with the model's overrides so a fresh model shows
  // the inherited defaults pre-filled. Persisted PUT only sends
  // non-empty entries (no point overriding a default with itself).
  const [draft, setDraft] = useState<ModelThresholds>(() => initial);
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const metricNames = useMemo(() => {
    const names = new Set<string>([
      ...Object.keys(defaults.metrics),
      ...Object.keys(draft.metrics),
    ]);
    return [...names].sort();
  }, [defaults.metrics, draft.metrics]);

  const updateMetric = useCallback((metric: string, patch: Partial<MetricThresholds>) => {
    setDraft((prev) => {
      const current = prev.metrics[metric] ?? {};
      const next = { ...current, ...patch };
      // Strip undefined keys so the persisted yaml stays tidy.
      const cleaned: MetricThresholds = {};
      for (const k of Object.keys(next) as (keyof MetricThresholds)[]) {
        const v = next[k];
        if (v !== undefined && !Number.isNaN(v)) cleaned[k] = v;
      }
      return {
        metrics: { ...prev.metrics, [metric]: cleaned },
      };
    });
  }, []);

  const removeMetric = useCallback((metric: string) => {
    setDraft((prev) => {
      const next = { ...prev.metrics };
      delete next[metric];
      return { metrics: next };
    });
  }, []);

  const addMetric = useCallback(() => {
    const name = adding.trim();
    if (!name) return;
    setDraft((prev) => ({
      metrics: { ...prev.metrics, [name]: prev.metrics[name] ?? {} },
    }));
    setAdding("");
  }, [adding]);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      // Drop metrics that have no thresholds set (all four undefined) —
      // they're noise in the yaml and the server treats them as no-op
      // anyway. Anything intentionally empty shows up as inherited from
      // defaults on the next load.
      const trimmed: ModelThresholds = { metrics: {} };
      for (const [name, m] of Object.entries(draft.metrics)) {
        if (Object.keys(m).length > 0) trimmed.metrics[name] = m;
      }
      const updated = await setModelQualityThresholds(modelId, trimmed);
      onSaved(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="dim" style={{ fontSize: 11 }}>
          Thresholds for
        </span>
        <span className="mono" style={{ color: "var(--text-2)", fontSize: 13 }}>
          {modelId}
        </span>
      </div>

      {metricNames.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No metrics defined. Add one below — common metrics: <span className="mono">rmse</span>,{" "}
          <span className="mono">accuracy</span>, <span className="mono">sample_count</span>.
        </div>
      ) : (
        metricNames.map((metric) => (
          <MetricBlock
            key={metric}
            metric={metric}
            values={draft.metrics[metric] ?? {}}
            inheritedFromDefault={!(metric in draft.metrics) && metric in defaults.metrics}
            onChange={(patch) => updateMetric(metric, patch)}
            onRemove={() => removeMetric(metric)}
          />
        ))
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <input
          type="text"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="new metric name"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addMetric();
            }
          }}
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--r-2)",
            padding: "4px 8px",
            fontSize: 12,
            color: "var(--text-1)",
            fontFamily: "var(--font-mono)",
            width: 200,
          }}
        />
        <button type="button" onClick={addMetric} disabled={!adding.trim()} style={btnStyle(false)}>
          Add metric
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={saving}
          style={btnStyle(true)}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && !error && (
          <span className="pos" style={{ fontSize: 11 }}>
            Saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        {error && (
          <span className="neg" style={{ fontSize: 11 }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Per-metric editor ──────────────────────────────────────────────

function MetricBlock({
  metric,
  values,
  inheritedFromDefault,
  onChange,
  onRemove,
}: {
  metric: string;
  values: MetricThresholds;
  inheritedFromDefault: boolean;
  onChange: (patch: Partial<MetricThresholds>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="mono" style={{ color: "var(--text-2)", fontSize: 12 }}>
            {metric}
          </span>
          {inheritedFromDefault && (
            <span className="dim2" style={{ fontSize: 10 }}>
              inherited from defaults
            </span>
          )}
        </div>
        <button type="button" onClick={onRemove} style={btnStyle(false)}>
          Remove
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 8,
        }}
      >
        {(["degraded_above", "failed_above", "degraded_below", "failed_below"] as const).map(
          (key) => (
            <ThresholdInput
              key={key}
              label={FIELD_LABELS[key]}
              hint={FIELD_HINTS[key]}
              value={values[key]}
              onChange={(v) => onChange({ [key]: v })}
            />
          ),
        )}
      </div>
    </div>
  );
}

function ThresholdInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const [text, setText] = useState<string>(value !== undefined ? String(value) : "");

  // Keep local text in sync if parent resets values (e.g., model switch).
  useEffect(() => {
    setText(value !== undefined ? String(value) : "");
  }, [value]);

  return (
    <div>
      <div className="dim" style={{ fontSize: 11, marginBottom: 2 }}>
        {label}
      </div>
      <input
        type="number"
        value={text}
        step="any"
        placeholder="—"
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (v === "") {
            onChange(undefined);
          } else {
            const parsed = Number(v);
            if (!Number.isNaN(parsed)) onChange(parsed);
          }
        }}
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--r-2)",
          padding: "4px 8px",
          fontSize: 12,
          width: "100%",
          color: "var(--text-1)",
          fontFamily: "var(--font-mono)",
        }}
      />
      <div className="dim2" style={{ fontSize: 10, marginTop: 2 }}>
        {hint}
      </div>
    </div>
  );
}

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
