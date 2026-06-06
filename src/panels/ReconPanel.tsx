import { Panel } from "../components/ui/Panel.js";
import { usePortfolio } from "../state/StateProvider.js";

// Reconciliation status. The server-side ReconciliationConfig runs
// every `interval_seconds`; results aren't yet streamed through
// /ws/state, so for v1 we infer drift from `data_stale` on the
// portfolio state. Phase 5 (or the Settings work in Phase 4)
// extends the snapshot to include a recon block with last-check
// timestamp + drift records.

export function ReconPanel() {
  const portfolio = usePortfolio("main");
  const drift = portfolio?.data_stale ?? false;
  const internalCount = portfolio?.positions.length ?? 0;

  return (
    <Panel title="Reconciliation" actions={["kebab"]}>
      <div style={{ padding: "10px 12px", fontSize: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span
            className="dot"
            style={{
              background: drift ? "var(--neg)" : "var(--pos)",
              width: 8,
              height: 8,
            }}
            aria-hidden
          />
          <span
            style={{
              color: drift ? "var(--neg)" : "var(--pos)",
              fontWeight: 600,
            }}
          >
            {drift ? "DRIFT DETECTED" : "IN SYNC"}
          </span>
          <span style={{ flex: 1 }} />
          <span className="dim mono" style={{ fontSize: 10 }}>
            auto every 60s
          </span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
            fontSize: 11,
          }}
        >
          <Stat label="BROKER" value="—" />
          <Stat label="INTERNAL" value={`${internalCount} pos`} />
          <Stat label="DRIFT" value={drift ? "stale" : "0"} negative={drift} />
        </div>
        {drift && (
          <div
            style={{
              marginTop: 10,
              padding: 8,
              background: "var(--neg-bg)",
              border: "1px solid var(--neg-dim)",
              fontSize: 11,
            }}
          >
            <span style={{ color: "var(--neg)", fontWeight: 600 }}>Investigate:</span>{" "}
            <span style={{ color: "var(--text-2)" }}>
              Local portfolio data is marked stale — reconnection or restart recommended before
              resuming trading.
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}

function Stat({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div>
      <div className="dim" style={{ fontSize: 10 }}>
        {label}
      </div>
      <div className={`num ${negative ? "neg" : ""}`}>{value}</div>
    </div>
  );
}
