import { ScreenHeader } from "./RiskLimitsScreen.js";
import { useSystemState } from "../state/StateProvider.js";
import type {
  AppEnvValue,
  ExecutionModeValue,
  SystemBlock,
  TradingModeValue,
} from "../types/ws.js";

// Settings · System · Environments
//
// Read-only view of the fully-resolved app_env / trading_mode /
// per-portfolio execution_mode lattice, plus the source (env var or
// config file path) for each value. Pure presentation — every value
// comes from the snapshot the State WS already publishes, no new
// endpoints. Spec: docs/archive/SETTINGS-STUBS.md →
// "System → Environments".

// Per-mode hint copy. The badge color is set by `tone` (semantic
// `pos`/`neg`/`warn` classes already used by RiskDashboard / Brokers).
type Tone = "pos" | "warn" | "neg" | "neutral";

const APP_ENV_TONES: Record<AppEnvValue, Tone> = {
  dev: "warn",
  staging: "warn",
  prod: "pos",
};

const TRADING_MODE_TONES: Record<TradingModeValue, Tone> = {
  paper: "warn",
  live: "neg",
};

const EXECUTION_MODE_TONES: Record<ExecutionModeValue, Tone> = {
  paper_local: "warn",
  paper_broker: "warn",
  manual: "neutral",
  "semi-auto": "neutral",
  auto: "pos",
};

const EXECUTION_MODE_DESCRIPTIONS: Record<ExecutionModeValue, string> = {
  paper_local: "fills synthesised in-process; no broker contact",
  paper_broker: "broker paper-trading account, real round-trip",
  manual: "operator approves every intent before submit",
  "semi-auto": "auto-submit within whitelist; otherwise approval",
  auto: "auto-submit every intent the strategy emits",
};

export function EnvironmentsScreen() {
  const system = useSystemState();

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · System · Environments"
        title="Environments"
        body="Resolved environment for this server: app_env, trading_mode, execution_mode. All values come from the live snapshot; this screen is read-only. A per-portfolio mode breakdown lands with the multi-account work (QF-62)."
      />
      <Lattice system={system} />
      <SystemStatus system={system} />
    </div>
  );
}

function Lattice({ system }: { system: SystemBlock | null }) {
  // Three top-level resolved values. Source paths in fixed-width below
  // each value so an operator can grep the right file in one glance.
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 10,
      }}
    >
      <LatticeCard
        label="App env"
        value={system?.app_env}
        tone={system?.app_env ? APP_ENV_TONES[system.app_env] : "neutral"}
        source="env var · APP_ENV (.env)"
      />
      <LatticeCard
        label="Trading mode"
        value={system?.trading_mode}
        tone={system?.trading_mode ? TRADING_MODE_TONES[system.trading_mode] : "neutral"}
        source="env var · TRADING_MODE (.env)"
        // The server downgrades TRADING_MODE=live -> paper whenever
        // APP_ENV is dev (server/index.js boot guard). Worth surfacing
        // here so an operator who set live but sees paper knows why.
        footnote={
          system?.app_env === "dev" && system?.trading_mode === "paper"
            ? "TRADING_MODE=live would be downgraded in dev"
            : undefined
        }
      />
      <LatticeCard
        label="Execution mode"
        value={system?.execution_mode}
        tone={system?.execution_mode ? EXECUTION_MODE_TONES[system.execution_mode] : "neutral"}
        source="config/portfolios.json · portfolios.main.mode"
        footnote={
          system?.execution_mode ? EXECUTION_MODE_DESCRIPTIONS[system.execution_mode] : undefined
        }
      />
    </div>
  );
}

function LatticeCard({
  label,
  value,
  tone,
  source,
  footnote,
}: {
  label: string;
  value: string | undefined;
  tone: Tone;
  source: string;
  footnote?: string;
}) {
  const toneClass = tone === "neutral" ? "" : tone;
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
        {label}
      </div>
      <div
        className={toneClass}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 20,
          fontWeight: 600,
          letterSpacing: "0.02em",
          marginBottom: 8,
        }}
      >
        {value?.toUpperCase() ?? "—"}
      </div>
      <div className="mono dim2" style={{ fontSize: 10, lineHeight: 1.4 }}>
        {source}
      </div>
      {footnote && (
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
          {footnote}
        </div>
      )}
    </div>
  );
}

function SystemStatus({ system }: { system: SystemBlock | null }) {
  const halted = system?.halted ?? false;
  const natsConnected = system?.nats_connected ?? false;
  const sources = system?.sources_available ?? [];
  const schwabAvailable = system?.schwab_token?.available ?? false;
  const schwabExpiresIn = system?.schwab_token?.refresh_token_expires_in_s;

  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
        System status
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 6,
          columnGap: 14,
          fontSize: 12,
        }}
      >
        <span className="dim">Halt</span>
        <span className={halted ? "neg" : "pos"}>
          {halted ? `HALTED${system?.halt_reason ? ` · ${system.halt_reason}` : ""}` : "ok"}
        </span>
        <span className="dim">NATS</span>
        <span className={natsConnected ? "pos" : "warn"}>
          {natsConnected ? "connected" : "not available"}
        </span>
        <span className="dim">Data sources</span>
        <span className="mono" style={{ color: "var(--text-2)" }}>
          {sources.length ? sources.join(", ") : "none"}
        </span>
        <span className="dim">Schwab token</span>
        <span className={schwabAvailable ? "pos" : "warn"}>
          {schwabAvailable
            ? expiresHint(schwabExpiresIn)
            : "not available — run npm run schwab-auth"}
        </span>
      </div>
    </div>
  );
}

function expiresHint(s: number | null | undefined): string {
  if (s == null) return "available";
  if (s <= 0) return "expired";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  if (days > 0) return `expires in ${days}d ${hours}h`;
  return `expires in ${hours}h`;
}
