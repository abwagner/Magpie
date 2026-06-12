import { useEffect, useMemo, useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import { Modal } from "../components/ui/Modal.js";
import { TypedConfirmation } from "../components/ui/TypedConfirmation.js";
import { useExitRuleTrips, useStrategies } from "../state/StateProvider.js";
import {
  exitRuleLabel,
  formatExitRuleValues,
  formatHeadroom,
  isTripped,
} from "../lib/exit-rule-format.js";
import {
  registerStrategy as apiRegister,
  transitionStrategy as apiTransition,
  setStrategyNotes as apiSetNotes,
  pinDriftBaseline as apiPinDriftBaseline,
} from "../lib/api.js";
import { StrategyMonitorPanel } from "../panels/StrategyMonitorPanel.js";
import type {
  LifecycleAction,
  LifecycleState,
  ParamsProvenance,
  Strategy,
} from "../types/strategy.js";

// Strategies workspace: registry table on the left, detail rail on
// the right. Both panels read from useStrategies() (snapshot +
// strategy_update reducer wired in StateProvider). Action buttons
// dispatch via /api/strategies/:id/transition; the server is the
// source of truth and the resulting strategy_update message
// patches the store.

const STATES: { id: LifecycleState; label: string; color: string; desc: string }[] = [
  {
    id: "registered",
    label: "Registered",
    color: "var(--text-3)",
    desc: "Manifest loaded, not yet enabled.",
  },
  { id: "enabled", label: "Enabled", color: "var(--text-2)", desc: "Enabled but not running." },
  {
    id: "running",
    label: "Running",
    color: "var(--pos)",
    desc: "Generating intents on signal updates.",
  },
  {
    id: "paused",
    label: "Paused",
    color: "var(--warn)",
    desc: "Stops new intents. Existing positions held.",
  },
  {
    id: "halted",
    label: "Halted",
    color: "var(--neg)",
    desc: "Hard stop. Intents blocked. Audit required.",
  },
  {
    id: "retired",
    label: "Retired",
    color: "var(--text-4)",
    desc: "No longer in rotation. Read-only.",
  },
];

const STATE_META = Object.fromEntries(STATES.map((s) => [s.id, s])) as Record<
  LifecycleState,
  (typeof STATES)[number]
>;

// Per-state action set for the detail rail. Order matters for
// rendering. Each action gets a label and a button kind.
const ACTIONS_BY_STATE: Record<
  LifecycleState,
  { action: LifecycleAction; label: string; kind: "primary" | "ghost" | "danger" }[]
> = {
  registered: [{ action: "enable", label: "Enable", kind: "primary" }],
  enabled: [
    { action: "start", label: "Start", kind: "primary" },
    { action: "disable", label: "Disable", kind: "ghost" },
  ],
  running: [
    { action: "pause", label: "Pause", kind: "ghost" },
    { action: "halt", label: "Halt", kind: "danger" },
  ],
  paused: [
    { action: "resume", label: "Resume", kind: "primary" },
    { action: "halt", label: "Halt", kind: "danger" },
  ],
  halted: [
    { action: "reenable", label: "Re-enable", kind: "primary" },
    { action: "retire", label: "Mark retired", kind: "ghost" },
  ],
  retired: [{ action: "reregister", label: "Re-register", kind: "ghost" }],
};

export function StrategiesScreen() {
  const strategies = useStrategies();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const selected = useMemo(
    () => strategies.find((s) => s.id === selectedId) ?? strategies[0] ?? null,
    [strategies, selectedId],
  );

  // Auto-select first strategy when the list arrives.
  useEffect(() => {
    if (selectedId == null && strategies[0]) setSelectedId(strategies[0].id);
  }, [strategies, selectedId]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 380px 380px",
        gap: 8,
        padding: 8,
        height: "100%",
        minHeight: 0,
      }}
    >
      <RegistryPanel
        strategies={strategies}
        selectedId={selected?.id}
        onSelect={setSelectedId}
        onRegisterClick={() => setRegisterOpen(true)}
      />
      <DetailPanel strategy={selected} />
      <StrategyMonitorPanel strategy={selected} />
      <RegisterModal open={registerOpen} onClose={() => setRegisterOpen(false)} />
    </div>
  );
}

// ── Registry table ────────────────────────────────────────────────

function RegistryPanel({
  strategies,
  selectedId,
  onSelect,
  onRegisterClick,
}: {
  strategies: Strategy[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onRegisterClick: () => void;
}) {
  return (
    <Panel
      title="Strategies"
      count={strategies.length}
      headerExtra={
        <button
          type="button"
          className="btn btn-primary"
          style={{ height: 22, padding: "0 8px", fontSize: 11 }}
          onClick={onRegisterClick}
        >
          Register
        </button>
      }
      actions={["filter", "kebab"]}
    >
      {strategies.length === 0 ? (
        <Empty onRegisterClick={onRegisterClick} />
      ) : (
        <table className="tbl" style={{ fontSize: 11 }}>
          <thead>
            <tr>
              <th className="l">ID</th>
              <th className="l">Label</th>
              <th className="l">State</th>
              <th className="l">Manifest</th>
              <th className="l">Updated</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => (
              <tr
                key={s.id}
                className={selectedId === s.id ? "sel" : ""}
                onClick={() => onSelect(s.id)}
                style={{ cursor: "pointer" }}
              >
                <td className="l mono">{s.id}</td>
                <td className="l">{s.label}</td>
                <td className="l">
                  <StateDot state={s.state} />
                </td>
                <td className="l mono dim2">{s.manifest_revision ?? "—"}</td>
                <td className="l mono dim">
                  {new Date(s.updated_at).toLocaleString("en-US", { hour12: false })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Empty({ onRegisterClick }: { onRegisterClick: () => void }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        color: "var(--text-3)",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div>No strategies registered yet.</div>
      <div className="dim2" style={{ fontSize: 11 }}>
        A strategy is the recipe that consumes signals and produces intents.
      </div>
      <button type="button" className="btn btn-primary" onClick={onRegisterClick}>
        Register the first strategy
      </button>
    </div>
  );
}

// ── Detail rail ───────────────────────────────────────────────────

function DetailPanel({ strategy }: { strategy: Strategy | null }) {
  if (!strategy) {
    return (
      <Panel title="Detail">
        <div className="dim" style={{ padding: 16, fontSize: 12 }}>
          Pick a strategy on the left.
        </div>
      </Panel>
    );
  }
  return (
    <Panel
      title={strategy.label}
      headerExtra={<StateDot state={strategy.state} />}
      actions={["kebab"]}
    >
      <div
        style={{
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          fontSize: 11,
          height: "100%",
          overflow: "auto",
        }}
      >
        <ActionRow strategy={strategy} />
        <LineageBadge provenance={strategy.params_provenance} />
        <LifecycleDiagram state={strategy.state} />
        <ExitRulesSection strategy={strategy} />
        <ExitRuleTripHistory strategyId={strategy.id} />
        <RepinBaselineSection strategyId={strategy.id} />
        <NotesEditor strategy={strategy} />
        <HistoryList strategy={strategy} />
      </div>
    </Panel>
  );
}

function ActionRow({ strategy }: { strategy: Strategy }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = ACTIONS_BY_STATE[strategy.state];

  async function run(action: LifecycleAction) {
    setBusy(action);
    setError(null);
    try {
      await apiTransition(strategy.id, action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <SectionLabel>Actions</SectionLabel>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            className={`btn btn-${a.kind}`}
            disabled={busy !== null}
            onClick={() => run(a.action)}
          >
            {busy === a.action ? "…" : a.label}
          </button>
        ))}
      </div>
      {error && (
        <div className="neg" style={{ fontSize: 11, marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// Surface the params_provenance block from the lifecycle API. Renders
// nothing when the field is absent (optional during initial rollout).
// Cross-tab navigation to the matching qo-run in the Backtests tab is
// deliberately deferred — the operator copies lineage_id from the
// tooltip until app-level routing exists.
// Exported for unit tests; consumed in DetailPanel above.
export function LineageBadge({ provenance }: { provenance: ParamsProvenance | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (!provenance) {
    // Hidden when absent. Future ticket: surface a "no lineage" warning
    // once params_provenance is required for the enabled→running
    // transition.
    return null;
  }
  const short = provenance.lineage_id.slice(0, 8);
  const tooltip =
    `lineage_id: ${provenance.lineage_id}\n` +
    `selector_rule: ${provenance.selector_rule}\n` +
    `selected_at: ${provenance.selected_at}`;
  return (
    <div>
      <SectionLabel>Lineage</SectionLabel>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          title={tooltip}
          aria-label={`Params provenance lineage ${provenance.lineage_id}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            border: "1px solid var(--accent, #3b82f6)",
            borderRadius: 3,
            color: "var(--accent, #3b82f6)",
            fontFamily: "'JetBrains Mono','Fira Code','SF Mono',monospace",
            fontSize: 10,
            background: "rgba(59,130,246,0.1)",
          }}
        >
          <span aria-hidden="true">⛓</span>
          <span>{short}</span>
        </span>
        <span style={{ color: "var(--text-3, #888)", fontSize: 10 }}>
          via <code style={{ fontFamily: "inherit" }}>{provenance.selector_rule}</code> at{" "}
          {provenance.selected_at}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="lineage-params-json"
          style={{
            marginLeft: "auto",
            padding: "1px 6px",
            background: "transparent",
            border: "1px solid var(--border, #333)",
            color: "var(--text-3, #888)",
            borderRadius: 3,
            cursor: "pointer",
            fontFamily: "'JetBrains Mono','Fira Code','SF Mono',monospace",
            fontSize: 10,
          }}
        >
          {expanded ? "Hide params" : "Show params"}
        </button>
      </div>
      {expanded && (
        <pre
          id="lineage-params-json"
          style={{
            marginTop: 8,
            padding: 10,
            background: "var(--bg, #060a12)",
            borderRadius: 4,
            fontFamily: "'JetBrains Mono','Fira Code','SF Mono',monospace",
            fontSize: 10,
            color: "var(--text, #dfe6f0)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 240,
            overflow: "auto",
          }}
        >
          {JSON.stringify(provenance.selected_params, null, 2)}
        </pre>
      )}
    </div>
  );
}

function LifecycleDiagram({ state }: { state: LifecycleState }) {
  return (
    <div>
      <SectionLabel>Lifecycle</SectionLabel>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: "var(--bg-app)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--r-2)",
          padding: 8,
        }}
      >
        {STATES.map((s) => (
          <div
            key={s.id}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 11,
              padding: "2px 4px",
              background: s.id === state ? "var(--bg-elev)" : "transparent",
            }}
          >
            <span
              className={`state-dot${s.id === "running" && s.id === state ? " running" : ""}`}
              style={{ color: s.color }}
            />
            <span
              className="mono"
              style={{
                color: s.id === state ? "var(--text-1)" : "var(--text-3)",
                fontWeight: s.id === state ? 600 : 400,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                width: 90,
              }}
            >
              {s.id}
            </span>
            <span className="dim2" style={{ fontSize: 10 }}>
              {s.desc}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Exit-rule monitor (QF-322) ────────────────────────────────────

// Per-strategy declared exit rules with their live "closest to trip"
// headroom, streamed on strategy_update.exit_rules[] by the monitor
// (QF-321/QF-351). Renders nothing until the monitor has evaluated the
// strategy at least once — undefined exit_rules means no policy or no
// eval yet, both of which the panel shows as a dormant note.
// Exported for unit tests.
export function ExitRulesSection({ strategy }: { strategy: Strategy }) {
  const rules = strategy.exit_rules;
  return (
    <div>
      <SectionLabel>Exit rules</SectionLabel>
      {!rules || rules.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No framework-enforced exits evaluated yet.
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {rules.map((ev) => (
            <ExitRuleRow key={ev.rule} ev={ev} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExitRuleRow({ ev }: { ev: NonNullable<Strategy["exit_rules"]>[number] }) {
  const tripped = isTripped(ev);
  return (
    <li
      style={{
        display: "flex",
        gap: 8,
        alignItems: "baseline",
        fontSize: 11,
        padding: "3px 6px",
        background: "var(--bg-app)",
        borderLeft: `2px solid ${tripped ? "var(--neg)" : "var(--border-1)"}`,
      }}
    >
      <span
        className="mono"
        style={{ width: 92, color: tripped ? "var(--neg)" : "var(--text-2)", fontWeight: 600 }}
      >
        {exitRuleLabel(ev.rule)}
      </span>
      <span className="mono dim">{formatExitRuleValues(ev)}</span>
      <span style={{ flex: 1 }} />
      <span
        className="mono"
        style={{ color: tripped ? "var(--neg)" : "var(--text-3)", fontSize: 10 }}
      >
        {formatHeadroom(ev)}
      </span>
    </li>
  );
}

// Recent exit-rule trips for this strategy, filtered from the shell-wide
// trip ring (StateProvider) by strategy_id. Surfaces the rule-driven
// closes the monitor has acted on so the operator can audit them
// alongside the strategy's lifecycle history. Exported for unit tests.
export function ExitRuleTripHistory({ strategyId }: { strategyId: string }) {
  const trips = useExitRuleTrips();
  const mine = trips.filter((t) => t.strategy_id === strategyId).slice(0, 10);
  return (
    <div>
      <SectionLabel>Exit-rule trips</SectionLabel>
      {mine.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No trips in this session.
        </div>
      ) : (
        <ol
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {mine.map((t) => (
            <li
              key={`${t.closing_intent_id}-${t.position_id}`}
              style={{
                fontSize: 11,
                padding: "4px 6px",
                borderLeft: "2px solid var(--neg)",
                background: "var(--bg-app)",
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <span className="mono dim" style={{ fontSize: 10 }}>
                  {new Date(t.ts).toLocaleString("en-US", { hour12: false })}
                </span>
                <span style={{ color: "var(--neg)", fontWeight: 600 }}>
                  {exitRuleLabel(t.rule)}
                </span>
                <span style={{ flex: 1 }} />
                <span className="dim2 mono" style={{ fontSize: 10 }}>
                  {t.position_id}
                </span>
              </div>
              <div className="dim2 mono" style={{ fontSize: 10, marginTop: 1 }}>
                intent {t.closing_intent_id}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function NotesEditor({ strategy }: { strategy: Strategy }) {
  const [draft, setDraft] = useState(strategy.operator_notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync local draft when the upstream strategy changes.
  useEffect(() => {
    setDraft(strategy.operator_notes ?? "");
  }, [strategy.id, strategy.operator_notes]);

  const dirty = draft !== (strategy.operator_notes ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiSetNotes(strategy.id, draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionLabel>Operator notes</SectionLabel>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="What does this strategy expect, what to watch?"
        rows={3}
        className="input"
        style={{
          width: "100%",
          height: "auto",
          padding: 8,
          fontFamily: "var(--font-ui)",
          fontSize: 12,
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? "…" : "Save"}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setDraft(strategy.operator_notes ?? "")}
          >
            Reset
          </button>
        )}
      </div>
      {error && (
        <div className="neg" style={{ fontSize: 11, marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── Baseline pin (QF-331) ─────────────────────────────────────────

export interface RepinBaselineSectionProps {
  strategyId: string;
}

/**
 * Operator-only section for re-pinning the drift baseline to a QO
 * run archive. Baseline promotion is a risk decision — requires typing
 * FIRE before the action is enabled (drift-detector.md §4).
 * Exported for unit tests.
 */
export function RepinBaselineSection({ strategyId }: RepinBaselineSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <SectionLabel>Drift baseline</SectionLabel>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ fontSize: 11, padding: "2px 8px" }}
        onClick={() => setOpen(true)}
      >
        Re-pin baseline to QO run…
      </button>
      <RepinBaselineModal strategyId={strategyId} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

// Props for the re-pin modal. Exported for unit tests.
export interface RepinBaselineModalProps {
  strategyId: string;
  open: boolean;
  onClose: () => void;
}

export function RepinBaselineModal({ strategyId, open, onClose }: RepinBaselineModalProps) {
  const [archiveUrl, setArchiveUrl] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Reset state when the modal opens/closes.
  useEffect(() => {
    if (!open) {
      setArchiveUrl("");
      setArmed(false);
      setBusy(false);
      setError(null);
      setSuccess(false);
    }
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiPinDriftBaseline(strategyId, archiveUrl);
      setSuccess(true);
      // Auto-close after a short delay so the operator sees confirmation.
      setTimeout(onClose, 1200);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Re-pin drift baseline"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !armed || !archiveUrl.trim()}
            onClick={submit}
          >
            {busy ? "…" : success ? "Pinned" : "Pin baseline"}
          </button>
        </>
      }
      body={
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="dim2" style={{ fontSize: 11 }}>
            Pinning a QO run archive replaces the drift baseline for all metrics that the archive
            covers. This is a risk decision — it changes what thresholds the drift detector compares
            live performance against.
          </div>
          <Field
            label="QO archive URL (s3:// or file://)"
            value={archiveUrl}
            onChange={setArchiveUrl}
            hint="e.g. s3://qf-archive/runs/wfo_results_my_strategy.json"
          />
          <TypedConfirmation
            safetyWord="FIRE"
            hint={
              <>
                Type <code>FIRE</code> to confirm baseline promotion for <code>{strategyId}</code>
              </>
            }
            autoFocus={false}
            onArmedChange={setArmed}
          />
          {error && (
            <div className="neg" style={{ fontSize: 11 }}>
              {error}
            </div>
          )}
          {success && (
            <div className="pos" style={{ fontSize: 11 }}>
              Baseline pinned successfully.
            </div>
          )}
        </div>
      }
    />
  );
}

function HistoryList({ strategy }: { strategy: Strategy }) {
  const recent = strategy.history.slice(-10).reverse();
  return (
    <div>
      <SectionLabel>Recent transitions</SectionLabel>
      <ol
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {recent.map((e, i) => (
          <li
            key={`${e.ts}-${i}`}
            style={{
              fontSize: 11,
              padding: "4px 6px",
              borderLeft: `2px solid ${STATE_META[e.to].color}`,
              background: "var(--bg-app)",
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <span className="mono dim" style={{ fontSize: 10 }}>
                {new Date(e.ts).toLocaleString("en-US", { hour12: false })}
              </span>
              <span style={{ color: STATE_META[e.to].color, fontWeight: 600 }}>
                {e.action.toUpperCase()}
              </span>
              <span className="dim2">
                {e.from} → {e.to}
              </span>
              <span style={{ flex: 1 }} />
              <span className="dim2 mono" style={{ fontSize: 10 }}>
                {e.actor}
              </span>
            </div>
            {e.reason && (
              <div className="dim" style={{ fontSize: 10, marginTop: 1 }}>
                {e.reason}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StateDot({ state }: { state: LifecycleState }) {
  const meta = STATE_META[state];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: meta.color,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      <span
        className={`state-dot${state === "running" ? " running" : ""}`}
        style={{ color: meta.color }}
      />
      {state}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dim"
      style={{
        fontSize: 9,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

// ── Register modal ────────────────────────────────────────────────

function RegisterModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [manifest, setManifest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setId("");
      setLabel("");
      setManifest("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiRegister({
        id,
        label,
        manifest_revision: manifest || undefined,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register strategy"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !id || !label}
            onClick={submit}
          >
            {busy ? "…" : "Register"}
          </button>
        </>
      }
      body={
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field
            label="Strategy ID"
            value={id}
            onChange={setId}
            hint="lower-kebab-case, e.g. short-straddle-spy"
          />
          <Field label="Label" value={label} onChange={setLabel} />
          <Field
            label="Manifest revision (optional)"
            value={manifest}
            onChange={setManifest}
            hint="git sha or version tag"
          />
          {error && (
            <div className="neg" style={{ fontSize: 11 }}>
              {error}
            </div>
          )}
        </div>
      }
    />
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        className="dim"
        style={{
          fontSize: 9,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && (
        <span className="dim2" style={{ fontSize: 10 }}>
          {hint}
        </span>
      )}
    </label>
  );
}
