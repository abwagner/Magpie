// Env pills express two facts about the current process:
//
//   app_env       — dev / staging / prod
//   trading_mode  — paper / live
//
// They render as a single grouped pill with two segments. The
// segment colors come from `--text-3` (dev), `--warn` (staging),
// `--neg` (prod), `--accent` (paper), `--pos` (live). Color is
// driven by the segment kind, not free strings.

export type AppEnv = "dev" | "staging" | "prod";
export type TradingMode = "paper" | "live";

export interface EnvPillProps {
  appEnv?: AppEnv;
  tradingMode?: TradingMode;
}

interface Segment {
  label: string;
  value: string;
  kind: AppEnv | TradingMode;
}

export function EnvPill({ appEnv, tradingMode }: EnvPillProps) {
  const segments: Segment[] = [];
  if (appEnv) segments.push({ label: "ENV", value: appEnv, kind: appEnv });
  if (tradingMode) segments.push({ label: "MODE", value: tradingMode, kind: tradingMode });
  if (segments.length === 0) return null;

  return (
    <span className="env-group" role="status" aria-label="environment">
      {segments.map((s) => (
        <span key={s.label} className={`env-pill ${s.kind}`}>
          <span className="env-dot" />
          <span className="env-label">{s.label}</span>
          <span>{s.value}</span>
        </span>
      ))}
    </span>
  );
}
