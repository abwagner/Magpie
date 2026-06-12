import { useEffect, useState } from "react";
import { useUI } from "../state/ui-store.js";
import { RiskLimitsScreen } from "./RiskLimitsScreen.js";
import { RiskPoliciesScreen } from "./RiskPoliciesScreen.js";
import { EmergencyScreen } from "./EmergencyScreen.js";
import { AlertsScreen } from "./AlertsScreen.js";
import { BrokersScreen } from "./BrokersScreen.js";
import { EnvironmentsScreen } from "./EnvironmentsScreen.js";
import { SecretsScreen } from "./SecretsScreen.js";
import { MarketDataHealthScreen } from "./MarketDataHealthScreen.js";
import { QualityThresholdsScreen } from "./QualityThresholdsScreen.js";
import { StrategiesConfigScreen } from "./StrategiesConfigScreen.js";
import { AuditLogScreen } from "./AuditLogScreen.js";
import { ExportsScreen } from "./ExportsScreen.js";
import { FundamentalsScreen } from "./FundamentalsScreen.js";
import { JobsScreen } from "./JobsScreen.js";
import { AccountsScreen } from "./AccountsScreen.js";
import DataCatalogTab from "../components/DataCatalogTab.js";
import BacktestsTab from "../components/BacktestsTab.js";

// Settings is a left-rail nav grouped into Risk · Data · Models ·
// System · Activity, matching the design's information
// architecture. Sections with a backend surface render their screen;
// the rest are rendered as "lands later" placeholders so the nav still
// reads as the full IA. (The Signals manifest section was removed with
// the Arch-A signal subsystem — QF-261 / QF-265.)

type SectionId =
  | "limits"
  | "policies"
  | "emergency"
  | "brokers"
  | "marketdata"
  | "mdHealth"
  | "fundamentals"
  | "strategies"
  | "backtests"
  | "quality"
  | "accounts"
  | "environments"
  | "secrets"
  | "jobs"
  | "audit"
  | "alerts"
  | "exports";

interface NavGroup {
  group: string;
  items: { id: SectionId; label: string; ready?: boolean }[];
}

const NAV: NavGroup[] = [
  {
    group: "Risk",
    items: [
      { id: "limits", label: "Limits", ready: true },
      { id: "policies", label: "Policies", ready: true },
      { id: "emergency", label: "Emergency", ready: true },
    ],
  },
  {
    group: "Data",
    items: [
      { id: "brokers", label: "Brokers", ready: true },
      { id: "marketdata", label: "Data catalog", ready: true },
      { id: "mdHealth", label: "Health", ready: true },
      { id: "fundamentals", label: "Fundamentals", ready: true },
    ],
  },
  {
    group: "Models",
    items: [
      { id: "strategies", label: "Strategies", ready: true },
      { id: "backtests", label: "Backtests", ready: true },
      { id: "quality", label: "Quality thresholds", ready: true },
    ],
  },
  {
    group: "System",
    items: [
      { id: "accounts", label: "Accounts", ready: true },
      { id: "environments", label: "Environments", ready: true },
      { id: "secrets", label: "Secrets", ready: true },
      { id: "jobs", label: "Jobs", ready: true },
    ],
  },
  {
    group: "Activity",
    items: [
      { id: "audit", label: "Audit log", ready: true },
      { id: "alerts", label: "Alerts", ready: true },
      { id: "exports", label: "Exports", ready: true },
    ],
  },
];

const VALID_SECTIONS = new Set<SectionId>([
  "limits",
  "policies",
  "emergency",
  "brokers",
  "marketdata",
  "mdHealth",
  "fundamentals",
  "strategies",
  "backtests",
  "quality",
  "accounts",
  "environments",
  "secrets",
  "jobs",
  "audit",
  "alerts",
  "exports",
]);

export function SettingsShell() {
  const [section, setSection] = useState<SectionId>("limits");

  // QF-228 — consume the one-shot deep-link target from useUI when set
  // (the QuoteUnavailableBanner's CTA writes "mdHealth" here). Clear
  // the override after applying so subsequent visits to Settings start
  // wherever the user last left off.
  const deepLink = useUI((s) => s.settingsSection);
  const clearDeepLink = useUI((s) => s.setSettingsSection);
  useEffect(() => {
    if (deepLink && VALID_SECTIONS.has(deepLink as SectionId)) {
      setSection(deepLink as SectionId);
      clearDeepLink("");
    }
  }, [deepLink, clearDeepLink]);

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        minHeight: 0,
      }}
    >
      <aside
        style={{
          background: "var(--bg-pane)",
          borderRight: "1px solid var(--border-1)",
          padding: "12px 0",
          overflow: "auto",
        }}
      >
        {NAV.map((g) => (
          <div key={g.group} style={{ marginBottom: 14 }}>
            <div
              style={{
                padding: "4px 14px",
                fontSize: 10,
                color: "var(--text-4)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {g.group}
            </div>
            {g.items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setSection(it.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 14px",
                  fontSize: 12,
                  color:
                    section === it.id
                      ? "var(--text-1)"
                      : it.ready
                        ? "var(--text-3)"
                        : "var(--text-4)",
                  background: section === it.id ? "var(--bg-elev)" : "transparent",
                  borderLeft:
                    section === it.id ? "2px solid var(--accent)" : "2px solid transparent",
                  cursor: "pointer",
                  border: "none",
                  borderTopWidth: 0,
                  borderRightWidth: 0,
                  borderBottomWidth: 0,
                  fontFamily: "var(--font-ui)",
                }}
              >
                <span>{it.label}</span>
                {!it.ready && (
                  <span className="dim2" style={{ fontSize: 9 }}>
                    soon
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div style={{ overflow: "auto" }}>
        <Content section={section} />
      </div>
    </div>
  );
}

function Content({ section }: { section: SectionId }) {
  switch (section) {
    case "limits":
      return <RiskLimitsScreen />;
    case "policies":
      return <RiskPoliciesScreen />;
    case "emergency":
      return <EmergencyScreen />;
    case "alerts":
      return <AlertsScreen />;
    case "exports":
      return <ExportsScreen />;
    case "brokers":
      return <BrokersScreen />;
    case "marketdata":
      return (
        <div style={{ padding: 16 }}>
          <DataCatalogTab />
        </div>
      );
    case "fundamentals":
      return <FundamentalsScreen />;
    case "jobs":
      return <JobsScreen />;
    case "strategies":
      return <StrategiesConfigScreen />;
    case "backtests":
      return (
        <div style={{ padding: 16 }}>
          <BacktestsTab />
        </div>
      );
    case "audit":
      return <AuditLogScreen />;
    case "accounts":
      return <AccountsScreen />;
    case "environments":
      return <EnvironmentsScreen />;
    case "secrets":
      return <SecretsScreen />;
    case "mdHealth":
      return <MarketDataHealthScreen />;
    case "quality":
      return <QualityThresholdsScreen />;
    default:
      return <Placeholder section={section} />;
  }
}

function Placeholder({ section }: { section: SectionId }) {
  const label = NAV.flatMap((g) => g.items).find((i) => i.id === section)?.label ?? section;
  return (
    <div style={{ padding: 32, color: "var(--text-3)", fontSize: 12 }}>
      <div style={{ fontSize: 14, color: "var(--text-2)", fontWeight: 600, marginBottom: 4 }}>
        {label}
      </div>
      <div className="dim2" style={{ fontSize: 11 }}>
        Backend surface for this section lands in a follow-up. The nav entry is here today so the
        full Settings IA reads correctly.
      </div>
    </div>
  );
}
