import { useEffect, useState } from "react";
import {
  useConnectionStatus,
  useExitRuleTrips,
  useOutstandingQuoteAlerts,
  useSystemState,
} from "../state/StateProvider.js";
import { useUI, type Theme, type WorkspaceId } from "../state/ui-store.js";
import { CommandPalette, type CommandItem } from "../components/ui/CommandPalette.js";
import { Modal } from "../components/ui/Modal.js";
import { Drawer } from "../components/ui/Drawer.js";
import { TypedConfirmation } from "../components/ui/TypedConfirmation.js";
import { EnvPill } from "../components/ui/EnvPill.js";
import { NotificationBanner, bannerLead, moreSuffix } from "../components/ui/NotificationBanner.js";
import { Icon } from "../components/ui/Icon.js";
import { Kbd } from "../components/ui/Kbd.js";
import { systemKill, systemReset, getAccounts, type SchwabAccount } from "../lib/api.js";
import { exitRuleLabel } from "../lib/exit-rule-format.js";
import { WORKSPACES, getWorkspace } from "../workspaces/index.js";
import { WorkspaceGrid } from "./WorkspaceGrid.js";
import { OrderTicket } from "../flows/OrderTicket.js";
import { StrategiesScreen } from "../screens/StrategiesScreen.js";
import { SettingsShell } from "../screens/SettingsShell.js";

export function Shell() {
  const { connected, reconnecting } = useConnectionStatus();
  const system = useSystemState();
  const {
    workspace,
    setWorkspace,
    theme,
    setTheme,
    paletteOpen,
    openPalette,
    closePalette,
    togglePalette,
  } = useUI();

  // ── Keyboard shortcuts ──────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      // ⌘K — command palette
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
        return;
      }
      // [ / ] — prev / next workspace
      if (!meta && (e.key === "[" || e.key === "]")) {
        const target = e.target as HTMLElement | null;
        if (target?.matches("input, textarea, [contenteditable]")) return;
        const idx = WORKSPACES.findIndex((w) => w.id === workspace);
        if (idx < 0) return;
        const delta = e.key === "]" ? 1 : -1;
        const next = WORKSPACES[(idx + delta + WORKSPACES.length) % WORKSPACES.length];
        if (next) setWorkspace(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspace, setWorkspace, togglePalette]);

  const halted = system?.halted ?? false;
  const haltReason = system?.halt_reason ?? "unknown";

  const cmdItems: CommandItem[] = WORKSPACES.flatMap<CommandItem>((w) => [
    {
      id: `ws:${w.id}`,
      label: w.label,
      kind: "Workspace",
      onRun: () => setWorkspace(w.id),
    },
  ]).concat([
    {
      id: "theme:dark",
      label: "Theme: Engineered Dark",
      kind: "Action",
      onRun: () => setTheme("dark"),
    },
    {
      id: "theme:dark-hc",
      label: "Theme: Higher-Contrast Dark",
      kind: "Action",
      onRun: () => setTheme("dark-hc"),
    },
    {
      id: "theme:light",
      label: "Theme: Engineered Light",
      kind: "Action",
      onRun: () => setTheme("light"),
    },
    {
      id: "kill",
      label: "Halt all trading…",
      kind: "Action",
      shortcut: "type HALT",
      onRun: () => useUI.getState().setKillArmed(true),
    },
    {
      id: "ticket-preview",
      label: "Preview Order Ticket (sample draft)",
      kind: "Action",
      onRun: () =>
        useUI.getState().openOrderTicket({
          symbol: "SPY",
          direction: "Short",
          quantity: 1,
          strategy: "manual",
          reason: "preview",
        }),
    },
  ]);

  return (
    <div className={`ws-shell${reconnecting ? " stale" : ""}`}>
      <Header
        halted={halted}
        haltReason={haltReason}
        appEnv={normalizeEnv(system?.app_env)}
        tradingMode={system?.trading_mode}
        theme={theme}
        onThemeChange={setTheme}
        onOpenPalette={openPalette}
        onKill={() => useUI.getState().setKillArmed(true)}
        connected={connected}
      />
      <Tabs current={workspace} onChange={setWorkspace} disabled={halted} />
      {reconnecting && <ReconBanner />}
      <QuoteUnavailableBanner />
      <ExitRuleClosingBanner />
      <Body workspace={workspace} />
      <StatusBar connected={connected} reconnecting={reconnecting} />
      <CommandPalette open={paletteOpen} onClose={closePalette} items={cmdItems} />
      <KillSwitchOverlay />
      <OrderTicket />
    </div>
  );
}

// ── Workspace body ────────────────────────────────────────────────

function Body({ workspace }: { workspace: WorkspaceId }) {
  const def = getWorkspace(workspace);
  if (!def) {
    return (
      <main className="ws-canvas" style={{ gridTemplateColumns: "1fr" }}>
        <div style={{ padding: 24, color: "var(--text-3)" }}>
          Unknown workspace: <code>{workspace}</code>
        </div>
      </main>
    );
  }
  if (workspace === "strategies") {
    return (
      <main
        className="ws-canvas"
        style={{ gridTemplateColumns: "1fr", padding: 0 }}
        aria-label={`workspace ${def.label}`}
      >
        <StrategiesScreen />
      </main>
    );
  }
  if (workspace === "settings") {
    return (
      <main
        className="ws-canvas"
        style={{ gridTemplateColumns: "1fr", padding: 0, gap: 0 }}
        aria-label={`workspace ${def.label}`}
      >
        <SettingsShell />
      </main>
    );
  }
  if (!def.template) {
    return (
      <main
        className="ws-canvas"
        style={{
          gridTemplateColumns: "1fr",
          alignItems: "center",
          justifyItems: "center",
          padding: 32,
          color: "var(--text-3)",
        }}
        aria-label={`workspace ${def.label}`}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 14,
              color: "var(--text-2)",
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            {def.label}
          </div>
          <div className="dim2" style={{ fontSize: 12 }}>
            {def.subtitle}
          </div>
          <div className="dim2" style={{ fontSize: 11, marginTop: 12 }}>
            Lands in a later phase.
          </div>
        </div>
      </main>
    );
  }
  return <WorkspaceGrid workspace={def} />;
}

// ── Header ────────────────────────────────────────────────────────

interface HeaderProps {
  halted: boolean;
  haltReason: string;
  appEnv: "dev" | "staging" | "prod" | undefined;
  tradingMode: "paper" | "live" | undefined;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onOpenPalette: () => void;
  onKill: () => void;
  connected: boolean;
}

function Header({
  halted,
  haltReason,
  appEnv,
  tradingMode,
  theme,
  onThemeChange,
  onOpenPalette,
  onKill,
  connected,
}: HeaderProps) {
  return (
    <div className="ws-header">
      <div className="ws-header-row">
        <div className="ws-brand">
          <span className="ws-brand-mark" aria-hidden />
          <span>Magpie</span>
          <span className="ws-brand-version" title={__APP_VERSION__}>
            v{__APP_VERSION__} · alpha
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <AccountSelector connected={connected} />
        <EnvPill appEnv={appEnv} tradingMode={tradingMode} />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onOpenPalette}
          style={{ gap: 8 }}
          aria-label="open command palette"
        >
          <Icon name="search" size={11} />
          <Kbd>⌘K</Kbd>
        </button>
        <ThemeMenu theme={theme} onChange={onThemeChange} />
        <button
          type="button"
          className={`kill-switch${halted ? " armed" : ""}`}
          onClick={onKill}
          aria-label={halted ? "system halted" : "halt trading"}
        >
          {halted ? "HALTED" : "Kill"}
        </button>
      </div>
      {halted && <HaltBanner reason={haltReason} />}
    </div>
  );
}

// ── Account selector ─────────────────────────────────────────────
// Header-level Schwab account picker. Selection persists via the
// ui-store; downstream panels (BrokerPositionsPanel, ChainPanel)
// read selectedAccount and key their /api/positions calls on it.
//
// Behavior:
//   - Fetches /api/accounts once on mount. Hidden if the call fails
//     (no Schwab OAuth) or if the account list is empty.
//   - Default option "All accounts" maps to selectedAccount = "".
//   - Disabled while WS is reconnecting (server might be down).

function AccountSelector({ connected }: { connected: boolean }) {
  const selected = useUI((s) => s.selectedAccount);
  const setSelected = useUI((s) => s.setSelectedAccount);
  const [accounts, setAccounts] = useState<SchwabAccount[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAccounts();
        if (cancelled) return;
        setAccounts(res.accounts ?? []);
      } catch {
        if (!cancelled) setAccounts([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded || accounts.length === 0) return null;

  return (
    <select
      className="input"
      style={{ height: 24, fontSize: 11, padding: "0 6px" }}
      value={selected}
      disabled={!connected}
      onChange={(e) => setSelected(e.target.value)}
      aria-label="Schwab account"
      title="Schwab account"
    >
      <option value="">All accounts</option>
      {accounts.map((a) => (
        <option key={a.hashValue} value={a.hashValue}>
          …{a.accountNumber.slice(-4)}
          {a.type ? ` (${a.type})` : ""}
        </option>
      ))}
    </select>
  );
}

function HaltBanner({ reason }: { reason: string }) {
  async function reset() {
    if (!confirm("Reset system halt and resume trading?")) return;
    try {
      await systemReset();
    } catch (e) {
      alert((e as Error).message);
    }
  }
  return (
    <div className="halt-banner" role="alert">
      <span className="halt-pulse" aria-hidden />
      <span>TRADING HALTED</span>
      <span className="halt-detail">{reason}</span>
      <button type="button" className="halt-action" onClick={reset}>
        Reset
      </button>
    </div>
  );
}

function ReconBanner() {
  return (
    <div className="recon-banner" role="status">
      <span>● Reconnecting to server… live values dimmed</span>
    </div>
  );
}

// QF-228 — quote-unavailable banner. Subscribes to outstanding alerts
// from StateProvider; collapses concurrent failures to one banner with
// a count. CTA deep-links into Settings → Health by setting the
// workspace + settingsSection in useUI; SettingsShell consumes the
// section override on mount.
export function QuoteUnavailableBanner() {
  const outstanding = useOutstandingQuoteAlerts();
  // Show the most-recent entry's detail prominently; the count gives
  // the operator a quick view of breadth.
  const entries = Array.from(outstanding.values()).sort((a, b) =>
    a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0,
  );
  const head = bannerLead(entries);
  if (!head) return null;
  const { lead, more } = head;
  const ts = new Date(lead.ts).toLocaleTimeString();
  const detail = lead.detail ?? lead.reason;
  const adapter = lead.adapter ?? "unknown adapter";
  function openHealth() {
    useUI.getState().setWorkspace("settings");
    useUI.getState().setSettingsSection("mdHealth");
  }
  return (
    <NotificationBanner
      variant="warn"
      label="Market data unavailable"
      detail={
        <>
          {detail} for {lead.symbol} via {adapter}. Last attempt: {ts}
          {moreSuffix(more, "symbol", "affected")}
        </>
      }
      actionLabel="View broker connections"
      onAction={openHealth}
    />
  );
}

// QF-322 — in-flight exit-rule closing banner. When the monitor trips a
// rule it submits closing intents and broadcasts position_exit_rule
// events; this banner makes the rule-driven close visible so the
// operator can tell it apart from a manual liquidation. It surfaces the
// most-recent trip plus a count of other affected positions. Distinct
// styling (var(--neg)) separates it from the quote-unavailable warning.
export function ExitRuleClosingBanner() {
  const trips = useExitRuleTrips();
  const head = bannerLead(trips);
  if (!head) return null;
  const { lead, more } = head;
  const ts = new Date(lead.ts).toLocaleTimeString();
  function openStrategies() {
    useUI.getState().setWorkspace("strategies");
  }
  return (
    <NotificationBanner
      variant="neg"
      label="Exit rule closing positions"
      detail={
        <>
          {exitRuleLabel(lead.rule)} tripped for {lead.strategy_id} — closing {lead.position_id}.
          Last trip: {ts}
          {moreSuffix(more, "position", "closing")}
        </>
      }
      actionLabel="View strategies"
      onAction={openStrategies}
    />
  );
}

// ── Theme menu (placeholder — Phase 1 moves this into a user menu) ─

function ThemeMenu({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const next: Record<Theme, Theme> = {
    dark: "dark-hc",
    "dark-hc": "light",
    light: "dark",
  };
  const label: Record<Theme, string> = {
    dark: "Dark",
    "dark-hc": "Dark·HC",
    light: "Light",
  };
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => onChange(next[theme])}
      title="Cycle theme"
    >
      {label[theme]}
    </button>
  );
}

// ── Workspace tabs ────────────────────────────────────────────────

interface TabsProps {
  current: WorkspaceId;
  onChange: (id: WorkspaceId) => void;
  disabled: boolean;
}

function Tabs({ current, onChange, disabled }: TabsProps) {
  if (disabled) return null;
  return (
    <nav className="ws-tabs" aria-label="workspaces">
      {WORKSPACES.map((w, i) => (
        <button
          key={w.id}
          type="button"
          className={`ws-tab${current === w.id ? " active" : ""}`}
          onClick={() => onChange(w.id)}
        >
          <span className="ws-tab-num">{i + 1}</span>
          {w.label}
        </button>
      ))}
    </nav>
  );
}

// ── Status bar ────────────────────────────────────────────────────

function StatusBar({ connected, reconnecting }: { connected: boolean; reconnecting: boolean }) {
  return (
    <div className="ws-statusbar" role="contentinfo">
      <span className={connected ? "live" : "reconnecting"}>
        {connected ? "LIVE" : reconnecting ? "Reconnecting…" : "Disconnected"}
      </span>
      <span className="sep" />
      <span>feed lag — ms</span>
      <span className="sep" />
      <span>approval queue 0</span>
      <div style={{ flex: 1 }} />
      <span>kill switch armed via header</span>
    </div>
  );
}

// ── Kill switch overlay (uses TypedConfirmation) ──────────────────

function KillSwitchOverlay() {
  const armed = useUI((s) => s.killArmed);
  const setKillArmed = useUI((s) => s.setKillArmed);
  return (
    <Modal
      open={armed}
      onClose={() => setKillArmed(false)}
      danger
      title="Halt all trading"
      body={
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p>
            Halts every portfolio. Cancels open orders. Rejects new intents. Does{" "}
            <strong>not</strong> liquidate positions. An audit log entry is created.
          </p>
          <TypedConfirmKill onClose={() => setKillArmed(false)} />
        </div>
      }
    />
  );
}

function TypedConfirmKill({ onClose }: { onClose: () => void }) {
  const [armed, setArmed] = useState(false);
  async function fire() {
    try {
      await systemKill("operator kill switch");
      onClose();
    } catch (e) {
      alert((e as Error).message);
    }
  }
  return (
    <>
      <TypedConfirmation safetyWord="HALT" autoFocus onArmedChange={setArmed} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={fire}>
          HALT TRADING SYSTEM
        </button>
      </div>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function normalizeEnv(raw: string | undefined): "dev" | "staging" | "prod" | undefined {
  if (!raw) return undefined;
  if (raw === "dev" || raw === "staging" || raw === "prod") return raw;
  return undefined;
}

// Re-export drawer so screens that need it don't have to import from ui/.
export { Drawer };
