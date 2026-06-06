import { useCallback, useEffect, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { fireTestAlert, getAlertRules, getRecentAlerts, setAlertRules } from "../lib/api.js";
import type {
  AlertChannel,
  AlertEvent,
  AlertLevel,
  AlertRule,
  AlertsConfig,
} from "../types/alerts.js";

// Settings · Activity · Alerts (QF-61)
//
// Edit alert-routing rules, view the recent-alerts ring, and fire a
// test alert to validate channel wiring. Backed by
// config/alerts.yaml + an in-memory recent ring; producers call
// `alertRouter.record(event)` server-side (most producer call sites
// are still on the migration path — the test-fire button is the
// end-to-end validation today).

const REFRESH_MS = 5000;

const LEVELS: AlertLevel[] = ["info", "warning", "critical"];
const CHANNELS: AlertChannel[] = ["log", "internal", "slack"];

export function AlertsScreen() {
  const [cfg, setCfg] = useState<AlertsConfig | null>(null);
  const [draft, setDraft] = useState<AlertRule[]>([]);
  const [recent, setRecent] = useState<AlertEvent[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [rules, rec] = await Promise.all([getAlertRules(), getRecentAlerts(100)]);
      setCfg(rules);
      setDraft(rules.rules);
      setRecent(rec.events);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => {
      // Refresh recent on a timer without touching the draft rules
      // (so an in-flight edit doesn't get clobbered mid-typing).
      getRecentAlerts(100)
        .then((rec) => setRecent(rec.events))
        .catch(() => {
          /* swallow — recent-poll errors shouldn't disrupt editing */
        });
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const next = await setAlertRules(draft);
      setCfg(next);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function addRule() {
    setDraft((d) => [
      ...d,
      {
        id: `rule-${d.length + 1}`,
        match: {},
        channels: ["log"],
      },
    ]);
  }
  function updateRule(idx: number, patch: Partial<AlertRule>) {
    setDraft((d) => d.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeRule(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx));
  }

  const dirty = cfg ? JSON.stringify(cfg.rules) !== JSON.stringify(draft) : false;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · Activity · Alerts"
        title="Alerts"
        right={
          <span className="badge accent" style={{ marginLeft: 12 }}>
            CONFIG/ALERTS.YAML · GIT-TRACKED
          </span>
        }
        body="Rules decide which channels each alert fans out to. Log → server log. Internal → /ws/state push to connected UIs. Slack → SLACK_WEBHOOK_URL webhook. Recent stream below shows the last 100 alerts the router has seen."
      />

      {loading && !cfg ? (
        <div className="dim" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : (
        <>
          <RulesPanel
            rules={draft}
            onAdd={addRule}
            onChange={updateRule}
            onRemove={removeRule}
            onSave={() => void onSave()}
            saving={saving}
            dirty={dirty}
            savedAt={savedAt}
          />
          <TestFirePanel onFired={() => void reload()} />
          <RecentStreamPanel events={recent} />
          {error && (
            <div className="neg" style={{ fontSize: 11 }}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Rules editor ───────────────────────────────────────────────────

function RulesPanel({
  rules,
  onAdd,
  onChange,
  onRemove,
  onSave,
  saving,
  dirty,
  savedAt,
}: {
  rules: AlertRule[];
  onAdd: () => void;
  onChange: (idx: number, patch: Partial<AlertRule>) => void;
  onRemove: (idx: number) => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  savedAt: number | null;
}) {
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div className="dim" style={{ fontSize: 11 }}>
        Rules ({rules.length})
      </div>
      {rules.length === 0 && (
        <div className="dim2" style={{ fontSize: 11 }}>
          No rules. An event with no matching rule still logs to the server log; explicit rules add
          fan-out to <span className="mono">internal</span> + <span className="mono">slack</span>.
        </div>
      )}
      {rules.map((rule, idx) => (
        <RuleRow
          key={`${idx}-${rule.id}`}
          rule={rule}
          onChange={(patch) => onChange(idx, patch)}
          onRemove={() => onRemove(idx)}
        />
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <button type="button" onClick={onAdd} style={btnStyle(false)}>
          + Add rule
        </button>
        <button type="button" onClick={onSave} disabled={!dirty || saving} style={btnStyle(true)}>
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && !dirty && (
          <span className="pos" style={{ fontSize: 11 }}>
            Saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: AlertRule;
  onChange: (patch: Partial<AlertRule>) => void;
  onRemove: () => void;
}) {
  function toggleLevel(level: AlertLevel) {
    const current = rule.match.levels ?? [];
    const next = current.includes(level) ? current.filter((l) => l !== level) : [...current, level];
    onChange({ match: { ...rule.match, levels: next.length === 0 ? undefined : next } });
  }
  function toggleChannel(channel: AlertChannel) {
    const current = rule.channels;
    const next = current.includes(channel)
      ? current.filter((c) => c !== channel)
      : [...current, channel];
    onChange({ channels: next });
  }

  return (
    <div
      style={{
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 10,
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr auto",
        gap: 10,
        alignItems: "start",
      }}
    >
      <div>
        <div className="dim" style={{ fontSize: 10, marginBottom: 2 }}>
          ID
        </div>
        <input
          type="text"
          value={rule.id}
          onChange={(e) => onChange({ id: e.target.value })}
          style={inputStyle()}
        />
        <div className="dim" style={{ fontSize: 10, marginTop: 6, marginBottom: 2 }}>
          Description (optional)
        </div>
        <input
          type="text"
          value={rule.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value || undefined })}
          style={inputStyle()}
        />
      </div>
      <div>
        <div className="dim" style={{ fontSize: 10, marginBottom: 2 }}>
          Match: type prefix (empty = any)
        </div>
        <input
          type="text"
          value={rule.match.type_prefix ?? ""}
          placeholder="e.g. risk."
          onChange={(e) =>
            onChange({
              match: { ...rule.match, type_prefix: e.target.value || undefined },
            })
          }
          style={inputStyle()}
        />
        <div className="dim" style={{ fontSize: 10, marginTop: 6, marginBottom: 2 }}>
          Match: levels (empty = any)
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {LEVELS.map((lvl) => (
            <label
              key={lvl}
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}
            >
              <input
                type="checkbox"
                checked={(rule.match.levels ?? []).includes(lvl)}
                onChange={() => toggleLevel(lvl)}
              />
              <span className="mono">{lvl}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="dim" style={{ fontSize: 10, marginBottom: 2 }}>
          Channels (≥1)
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {CHANNELS.map((c) => (
            <label key={c} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={rule.channels.includes(c)}
                onChange={() => toggleChannel(c)}
              />
              <span className="mono">{c}</span>
            </label>
          ))}
        </div>
      </div>
      <button type="button" onClick={onRemove} style={btnStyle(false)}>
        Remove
      </button>
    </div>
  );
}

// ── Test-fire panel ────────────────────────────────────────────────

function TestFirePanel({ onFired }: { onFired: () => void }) {
  const [type, setType] = useState("test.synthetic");
  const [level, setLevel] = useState<AlertLevel>("info");
  const [message, setMessage] = useState("Synthetic alert from Settings UI");
  const [busy, setBusy] = useState(false);
  const [lastFired, setLastFired] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fire() {
    setBusy(true);
    setError(null);
    try {
      const res = await fireTestAlert({ type, level, message });
      setLastFired(res.event.ts);
      onFired();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
        gap: 10,
      }}
    >
      <div className="dim" style={{ fontSize: 11 }}>
        Fire a test alert
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <div className="dim" style={{ fontSize: 10, marginBottom: 2 }}>
            Type
          </div>
          <input
            type="text"
            value={type}
            onChange={(e) => setType(e.target.value)}
            style={inputStyle()}
          />
        </div>
        <div>
          <div className="dim" style={{ fontSize: 10, marginBottom: 2 }}>
            Level
          </div>
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as AlertLevel)}
            style={inputStyle()}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <div className="dim" style={{ fontSize: 10, marginBottom: 2 }}>
          Message
        </div>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={inputStyle()}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" onClick={() => void fire()} disabled={busy} style={btnStyle(true)}>
          {busy ? "Firing…" : "Fire test alert"}
        </button>
        {lastFired && !error && (
          <span className="pos" style={{ fontSize: 11 }}>
            Last fired {new Date(lastFired).toLocaleTimeString()}
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

// ── Recent stream ──────────────────────────────────────────────────

function RecentStreamPanel({ events }: { events: AlertEvent[] }) {
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        Recent ({events.length}) — newest first
      </div>
      {events.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No alerts seen since router start.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-4)", fontSize: 11 }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500 }}>When</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Level</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Type</th>
              <th style={{ textAlign: "left", padding: "4px 0 4px 8px", fontWeight: 500 }}>
                Message
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr
                key={`${e.ts}-${i}`}
                style={{ borderTop: "1px solid var(--border-1)", verticalAlign: "top" }}
              >
                <td className="mono dim" style={{ padding: "6px 8px 6px 0", fontSize: 11 }}>
                  {new Date(e.ts).toLocaleTimeString()}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  <span className={`badge ${levelTone(e.level)}`}>{e.level.toUpperCase()}</span>
                </td>
                <td className="mono" style={{ padding: "6px 8px", color: "var(--text-2)" }}>
                  {e.type}
                </td>
                <td style={{ padding: "6px 0 6px 8px", color: "var(--text-2)" }}>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function levelTone(level: AlertLevel): string {
  if (level === "critical") return "neg";
  if (level === "warning") return "warn";
  return "";
}

function inputStyle(): React.CSSProperties {
  return {
    background: "var(--bg-elev)",
    border: "1px solid var(--border-1)",
    borderRadius: "var(--r-2)",
    padding: "4px 8px",
    fontSize: 12,
    color: "var(--text-1)",
    fontFamily: "var(--font-mono)",
    width: "100%",
  };
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
