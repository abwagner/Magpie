import { useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import { useOrders, useSystemState } from "../state/StateProvider.js";
import { approveOrder, rejectOrder, type ApproveOrderEdits } from "../lib/api.js";
import { ageSeconds } from "../lib/numbers.js";
import type { Order } from "../types/order.js";

// Pending intents awaiting operator action. The server auto-approves
// in paper_local; the panel renders a "PAPER · BYPASSED" placeholder
// in that case (the queue is intentionally empty by design).

export function ApprovalsPanel() {
  const sys = useSystemState();
  const orders = useOrders();
  const pending = orders?.pending ?? [];
  const isPaper = sys?.execution_mode === "paper_local";

  if (isPaper && pending.length === 0) {
    return (
      <Panel
        title="Approval Queue"
        badge={<span className="badge">PAPER · BYPASSED</span>}
        actions={["kebab"]}
      >
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: "var(--text-3)",
            fontSize: 12,
          }}
        >
          <div style={{ marginBottom: 6 }}>No pending intents.</div>
          <div className="dim2" style={{ fontSize: 11 }}>
            execution_mode = paper_local · intents auto-approve
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Approval Queue"
      count={pending.length}
      badge={
        <span className={`badge ${pending.length > 0 ? "warn" : ""}`}>
          {sys?.execution_mode?.toUpperCase() ?? "UNKNOWN"}
        </span>
      }
      actions={["kebab"]}
    >
      {pending.length === 0 ? (
        <Empty />
      ) : (
        <div>
          {pending.map((o) => (
            <Row key={o.order_id} order={o} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function Empty() {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        color: "var(--text-3)",
        fontSize: 12,
      }}
    >
      <div>Queue is empty.</div>
    </div>
  );
}

// QF-51 — local form state for the operator-edit inputs. Each field is
// optional; the API call only sends the values that are set (empty
// string = "leave as recommended" → omitted from the request body).
// Exported so unit tests can name the type.
export interface EditState {
  order_type: "" | "market" | "limit";
  limit_price: string; // string so an empty input is unambiguously "not edited"
  time_in_force: "" | "day" | "gtc" | "ioc" | "fok";
  working_policy_id: string;
}

const EMPTY_EDIT: EditState = {
  order_type: "",
  limit_price: "",
  time_in_force: "",
  working_policy_id: "",
};

// Translate the form state to the API's edits shape, dropping empties.
// Exported for unit testing the empty-field semantics in isolation.
export function editStateToApiEdits(state: EditState): ApproveOrderEdits | undefined {
  const edits: ApproveOrderEdits = {};
  if (state.order_type !== "") edits.order_type = state.order_type;
  if (state.limit_price !== "") {
    const n = Number(state.limit_price);
    if (Number.isFinite(n)) edits.limit_price = n;
  }
  if (state.time_in_force !== "") edits.time_in_force = state.time_in_force;
  if (state.working_policy_id.trim() !== "")
    edits.working_policy_id = state.working_policy_id.trim();
  return Object.keys(edits).length > 0 ? edits : undefined;
}

function Row({ order }: { order: Order }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<EditState>(EMPTY_EDIT);
  const ageS = Math.max(0, Math.round((Date.now() - new Date(order.created_at).getTime()) / 1000));

  async function approve() {
    setBusy("approve");
    setErr(null);
    try {
      // editStateToApiEdits returns undefined when no fields were
      // touched — exactly the "approve as recommended" path.
      await approveOrder(order.order_id, editStateToApiEdits(edits));
      setEditing(false);
      setEdits(EMPTY_EDIT);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function reject() {
    setBusy("reject");
    setErr(null);
    try {
      await rejectOrder(order.order_id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--border-1)",
        background: ageS > 240 ? "var(--warn-bg)" : "transparent",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span className="sym" style={{ fontSize: 12 }}>
              {order.intent_id}
            </span>
            <span style={{ flex: 1 }} />
            <span className="dim mono" style={{ fontSize: 10 }}>
              {ageSeconds(ageS)}
            </span>
          </div>
          <div
            className="dim mono"
            style={{
              fontSize: 10,
              marginTop: 1,
            }}
          >
            {order.broker} · {order.execution_mode} · {order.status}
          </div>
          {err && (
            <div className="neg" style={{ fontSize: 11, marginTop: 3 }}>
              {err}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <button
            type="button"
            className="btn btn-buy"
            style={{ height: 22, padding: "0 10px", fontSize: 11 }}
            disabled={busy !== null}
            onClick={approve}
          >
            {busy === "approve" ? "…" : "Approve"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              height: 22,
              padding: "0 10px",
              fontSize: 11,
              color: "var(--text-3)",
            }}
            disabled={busy !== null}
            onClick={() => setEditing((e) => !e)}
            aria-label={editing ? "Hide edit fields" : "Show edit fields"}
            aria-pressed={editing}
          >
            {editing ? "✕ Cancel edit" : "✎ Edit"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              height: 22,
              padding: "0 10px",
              fontSize: 11,
              color: "var(--text-3)",
            }}
            disabled={busy !== null}
            onClick={reject}
          >
            {busy === "reject" ? "…" : "Reject"}
          </button>
        </div>
      </div>
      {editing && <EditFields edits={edits} setEdits={setEdits} disabled={busy !== null} />}
    </div>
  );
}

// QF-51 — inline edit form. Reuses the dim/mono labelling pattern from
// the rest of the panel. Empty values mean "use the Execution Layer's
// recommendation"; touched values flow through to operator_edits.
function EditFields({
  edits,
  setEdits,
  disabled,
}: {
  edits: EditState;
  setEdits: (s: EditState | ((p: EditState) => EditState)) => void;
  disabled: boolean;
}) {
  const labelStyle = {
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
    fontSize: 10,
    color: "var(--text-3)",
  };
  const inputStyle = {
    background: "var(--surface-1)",
    border: "1px solid var(--border-1)",
    color: "var(--text-1)",
    fontSize: 11,
    height: 22,
    padding: "0 6px",
    fontFamily: "var(--font-mono, monospace)",
  };
  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 6,
        borderTop: "1px dashed var(--border-1)",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 6,
      }}
    >
      <label style={labelStyle}>
        order_type
        <select
          aria-label="order_type"
          disabled={disabled}
          value={edits.order_type}
          style={inputStyle}
          onChange={(e) =>
            setEdits((p) => ({
              ...p,
              order_type: e.target.value as EditState["order_type"],
            }))
          }
        >
          <option value="">(use recommendation)</option>
          <option value="market">market</option>
          <option value="limit">limit</option>
        </select>
      </label>
      <label style={labelStyle}>
        limit_price
        <input
          aria-label="limit_price"
          type="number"
          step="0.01"
          disabled={disabled}
          placeholder="(use recommendation)"
          value={edits.limit_price}
          style={inputStyle}
          onChange={(e) => setEdits((p) => ({ ...p, limit_price: e.target.value }))}
        />
      </label>
      <label style={labelStyle}>
        time_in_force
        <select
          aria-label="time_in_force"
          disabled={disabled}
          value={edits.time_in_force}
          style={inputStyle}
          onChange={(e) =>
            setEdits((p) => ({
              ...p,
              time_in_force: e.target.value as EditState["time_in_force"],
            }))
          }
        >
          <option value="">(use recommendation)</option>
          <option value="day">day</option>
          <option value="gtc">gtc</option>
          <option value="ioc">ioc</option>
          <option value="fok">fok</option>
        </select>
      </label>
      <label style={labelStyle}>
        working_policy_id
        <input
          aria-label="working_policy_id"
          type="text"
          disabled={disabled}
          placeholder="(use recommendation)"
          value={edits.working_policy_id}
          style={inputStyle}
          onChange={(e) => setEdits((p) => ({ ...p, working_policy_id: e.target.value }))}
        />
      </label>
    </div>
  );
}
