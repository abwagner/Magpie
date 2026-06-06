import { useEffect, useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { inspectTrades } from "../lib/api.js";

// Audit log = the same audit_* tables the Trade Inspector reads,
// presented chronologically. v1 wires "by time" mode and renders
// each row as a single-line event with kind/state badges. Operator
// actions land here in Phase 5 once an audit_operator_events table
// is added; for now this is signal-derived events only.

interface AuditRow {
  intent_id?: string;
  strategy_id?: string;
  symbol?: string;
  direction?: string;
  intent_qty?: number | string;
  created_at?: string;
  order_id?: string;
  order_status?: string;
  broker?: string;
  execution_mode?: string;
  fill_id?: string;
  price?: number;
  quantity?: number;
  filled_at?: string;
}

const PAGE = 50;

export function AuditLogScreen() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    setError(null);
    try {
      const data = (await inspectTrades({})) as AuditRow[] | unknown;
      setRows(Array.isArray(data) ? (data as AuditRow[]).slice(0, PAGE) : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <ScreenHeader
        crumb="Settings · Activity · Audit log"
        title="Audit log"
        body="Joined view of audit_intents, audit_orders, and audit_fills. Read-only; the same data backs the Trade Inspector panel."
      />
      <Panel
        title="Recent events"
        count={rows?.length}
        headerExtra={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 22, padding: "0 8px", fontSize: 11 }}
            disabled={refreshing}
            onClick={load}
          >
            {refreshing ? "…" : "Refresh"}
          </button>
        }
        actions={["download", "kebab"]}
        style={{ marginTop: 14 }}
      >
        {error && (
          <div className="neg" style={{ padding: 12, fontSize: 11 }}>
            {error}
          </div>
        )}
        {!error && rows == null && (
          <div className="dim" style={{ padding: 16, fontSize: 12 }}>
            Loading…
          </div>
        )}
        {!error && rows != null && rows.length === 0 && (
          <div className="dim" style={{ padding: 16, fontSize: 12 }}>
            No audit rows.
          </div>
        )}
        {!error && rows != null && rows.length > 0 && (
          <table className="tbl" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th className="l">Time</th>
                <th className="l">Strategy</th>
                <th className="l">Sym</th>
                <th className="l">Dir</th>
                <th>Qty</th>
                <th className="l">Order</th>
                <th className="l">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Row key={`${r.intent_id ?? r.order_id ?? r.fill_id ?? i}`} r={r} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Row({ r }: { r: AuditRow }) {
  const ts = r.filled_at ?? r.created_at ?? "";
  const time = ts ? new Date(ts).toLocaleString("en-US", { hour12: false }) : "—";
  const isHalt = r.order_status === "rejected";
  return (
    <tr style={isHalt ? { borderLeft: "2px solid var(--neg)" } : undefined}>
      <td className="l mono dim">{time}</td>
      <td className="l mono dim2">{r.strategy_id ?? "—"}</td>
      <td className="l">
        <span className="sym">{r.symbol ?? "—"}</span>
      </td>
      <td
        className={`l ${
          r.direction?.toLowerCase().includes("long") || r.direction?.toLowerCase().includes("buy")
            ? "pos"
            : r.direction
              ? "neg"
              : "dim"
        }`}
      >
        {r.direction ?? "—"}
      </td>
      <td>{r.intent_qty ?? r.quantity ?? "—"}</td>
      <td className="l mono dim2">{r.order_id ?? "—"}</td>
      <td className="l">
        <span className={`badge ${statusClass(r.order_status)}`}>
          {(r.order_status ?? "—").toUpperCase()}
        </span>
      </td>
    </tr>
  );
}

function statusClass(status?: string): string {
  if (!status) return "";
  if (status === "filled") return "pos";
  if (status === "rejected" || status === "submission_failed") return "neg";
  if (status === "pending_approval" || status === "submitted") return "accent";
  return "";
}
