import { useState } from "react";
import { Panel } from "../components/ui/Panel.js";
import { Icon } from "../components/ui/Icon.js";
import { useOrders } from "../state/StateProvider.js";
import { cancelOrder } from "../lib/api.js";
import { clock } from "../lib/numbers.js";
import type { Order, OrderStatus } from "../types/order.js";

const ACTIVE_STATUSES: OrderStatus[] = ["approved", "submitted", "partial_fill", "risk_check"];

export function ActiveOrdersPanel() {
  const orders = useOrders();
  const recent = orders?.recent ?? [];
  const active = recent.filter((o) => ACTIVE_STATUSES.includes(o.status));

  return (
    <Panel title="Active Orders" count={active.length} actions={["kebab"]}>
      {active.length === 0 ? (
        <Empty />
      ) : (
        <table className="tbl" style={{ fontSize: 11 }}>
          <thead>
            <tr>
              <th className="l">Time</th>
              <th className="l">Order</th>
              <th className="l">Broker</th>
              <th className="l">Mode</th>
              <th className="l">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {active.map((o) => (
              <Row key={o.order_id} order={o} />
            ))}
          </tbody>
        </table>
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
      <div>No active orders.</div>
    </div>
  );
}

function Row({ order }: { order: Order }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setErr(null);
    try {
      await cancelOrder(order.order_id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ts = order.submitted_at ?? order.created_at;
  return (
    <tr>
      <td className="l mono dim">{clock(ts)}</td>
      <td className="l mono">{order.intent_id}</td>
      <td className="l dim">{order.broker}</td>
      <td className="l dim">{order.execution_mode}</td>
      <td className="l">
        <span className="badge accent">{order.status.toUpperCase()}</span>
      </td>
      <td>
        <button
          type="button"
          aria-label="cancel order"
          disabled={busy}
          onClick={cancel}
          title={err ?? "cancel"}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-3)",
            cursor: busy ? "not-allowed" : "pointer",
            padding: 4,
          }}
        >
          <Icon name="x" size={10} />
        </button>
      </td>
    </tr>
  );
}
