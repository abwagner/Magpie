import { Icon } from "../components/ui/Icon.js";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { useSystemState } from "../state/StateProvider.js";

// Brokers screen — read-only view of which adapters the server has
// today (sources_available from /ws/state.system) plus a list of
// known adapter implementations for context. Phase 5 / multi-account
// adds Configure / Test / Disconnect actions; for v1 the server
// boots all configured adapters and the GUI is informational.

interface Adapter {
  id: string;
  name: string;
  builtin?: boolean;
  description: string;
}

const KNOWN_ADAPTERS: Adapter[] = [
  {
    id: "schwab",
    name: "Schwab",
    description: "OAuth via npm run schwab-auth · live-trading capable",
  },
  {
    id: "ibkr",
    name: "IBKR",
    description: "Local TWS / IB Gateway on port 4001/4002",
  },
  {
    id: "marketdata",
    name: "MarketData.app",
    description: "Quotes + chains, no order routing",
  },
  {
    id: "paper_local",
    name: "Local sim",
    builtin: true,
    description: "Built-in paper adapter — fills synthesised in-process",
  },
];

export function BrokersScreen() {
  const system = useSystemState();
  const available = new Set(system?.sources_available ?? []);
  const natsConnected = system?.nats_connected ?? false;

  return (
    <div style={{ padding: 16 }}>
      <ScreenHeader
        crumb="Settings · Data · Brokers"
        title="Brokers"
        body="Pluggable adapter cards. The server boots whichever adapters /api/system/status reports as available; this page is read-only. Adapter trait lives at server/order/adapters/."
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 10,
          marginTop: 14,
        }}
      >
        {KNOWN_ADAPTERS.map((a) => {
          const isPaper = a.id === "paper_local";
          const status = isPaper ? "connected" : available.has(a.id) ? "connected" : "disabled";
          return <Card key={a.id} adapter={a} status={status} />;
        })}
        <DashedCard />
      </div>
      <div className="dim" style={{ marginTop: 18, fontSize: 11 }}>
        NATS:{" "}
        <span className={natsConnected ? "pos" : "warn-text"}>
          {natsConnected ? "connected" : "not available"}
        </span>
        {" · "}
        Sources reported by server:{" "}
        <span className="mono" style={{ color: "var(--text-2)" }}>
          {Array.from(available).join(", ") || "none"}
        </span>
      </div>
    </div>
  );
}

function Card({
  adapter,
  status,
}: {
  adapter: Adapter;
  status: "connected" | "configured" | "disabled";
}) {
  const badgeClass = status === "connected" ? "pos" : status === "configured" ? "" : "neg";
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text-1)", fontSize: 13 }}>
          {adapter.name}
        </span>
        {adapter.builtin && <span className="badge">BUILTIN</span>}
        <span style={{ flex: 1 }} />
        <span className={`badge ${badgeClass}`}>{status.toUpperCase()}</span>
      </div>
      <div className="dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
        {adapter.description}
      </div>
      <div className="mono dim2" style={{ fontSize: 10, marginTop: 8 }}>
        id: {adapter.id}
      </div>
    </div>
  );
}

function DashedCard() {
  return (
    <div
      style={{
        background: "transparent",
        border: "1px dashed var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-3)",
        fontSize: 12,
        cursor: "default",
        minHeight: 96,
      }}
      title="Implement BrokerAdapter trait under server/order/adapters/"
    >
      <Icon name="plus" size={11} />
      &nbsp;&nbsp;Add broker adapter
    </div>
  );
}
