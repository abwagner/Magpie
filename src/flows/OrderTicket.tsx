import { useEffect, useState, type ReactNode } from "react";
import { Drawer } from "../components/ui/Drawer.js";
import { TypedConfirmation } from "../components/ui/TypedConfirmation.js";
import {
  useUI,
  type OrderTicketDraft,
  type OrderTicketLeg,
  type OrderTicketTotals,
} from "../state/ui-store.js";
import { useSystemState } from "../state/StateProvider.js";
import { signed, usd } from "../lib/numbers.js";

// 380px right-edge drawer. Submit gating:
//   paper          → "Submit paper order" enabled immediately.
//   live (any auto) → "Submit live order" disabled until the operator
//                     types FIRE into the safety input.
//
// Phase 2a wires the surface + the gate; the actual submit is a
// no-op stub that closes the drawer. Phase 2b's Greek Builder hands
// us a real draft, and a future endpoint takes the place of the
// stub.

export function OrderTicket() {
  const draft = useUI((s) => s.orderTicket);
  const close = useUI((s) => s.closeOrderTicket);
  const system = useSystemState();
  const tradingMode = draft?.mode ?? system?.trading_mode ?? "paper";
  const isLive = tradingMode === "live";

  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!draft) {
      setArmed(false);
      setBusy(false);
      setError(null);
    }
  }, [draft]);

  if (!draft) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Phase 2a: stub submit. Phase 2b/2c routes through a real
      // POST /api/orders endpoint when the Greek Builder lands a
      // real intent + risk check.
      await new Promise((r) => setTimeout(r, 250));
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={close}
      title={
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span>Order Ticket</span>
          <ModeChip mode={tradingMode} />
        </span>
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={isLive ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy || (isLive && !armed)}
            onClick={submit}
          >
            {busy ? "Submitting…" : isLive ? "Submit live order" : "Submit paper order"}
          </button>
        </>
      }
    >
      <Section title="Strategy">
        <KV label="Symbol" value={draft.symbol} />
        <KV label="Direction" value={draft.direction} />
        <KV label="Quantity" value={String(draft.quantity)} />
        {draft.strategy && <KV label="Strategy" value={draft.strategy} />}
        {draft.reason && <KV label="Reason" value={draft.reason} />}
      </Section>

      {draft.legs && draft.legs.length > 0 && (
        <Section title={`Legs (${draft.legs.length})`}>
          <LegsGrid legs={draft.legs} />
        </Section>
      )}

      {draft.totals && (
        <Section title="Net Greeks · cost">
          <Totals totals={draft.totals} />
        </Section>
      )}

      <Section title="Risk checks">
        <div className="dim2" style={{ fontSize: 11 }}>
          Risk check pass row lands alongside POST /api/orders wiring. Until then, Submit only
          writes to the audit log.
        </div>
      </Section>

      {isLive && (
        <Section title="Safety gate">
          <TypedConfirmation
            safetyWord="FIRE"
            autoFocus
            onArmedChange={setArmed}
            hint={
              <>
                Live trading. Type <code>FIRE</code> to enable submit.
              </>
            }
          />
        </Section>
      )}

      {error && (
        <Section title="Error">
          <div className="neg" style={{ fontSize: 12 }}>
            {error}
          </div>
        </Section>
      )}
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        className="dim"
        style={{
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "100px 1fr",
        rowGap: 2,
        fontSize: 12,
      }}
    >
      <span className="dim">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

function ModeChip({ mode }: { mode: OrderTicketDraft["mode"] | "paper" | "live" }) {
  const live = mode === "live";
  return (
    <span className={`badge ${live ? "neg" : "accent"}`}>{(mode ?? "paper").toUpperCase()}</span>
  );
}

function LegsGrid({ legs }: { legs: OrderTicketLeg[] }) {
  return (
    <table className="tbl" style={{ fontSize: 11 }}>
      <thead>
        <tr>
          <th className="l">Side</th>
          <th className="l">Sym</th>
          <th>Qty</th>
          <th>Px</th>
          <th>Δ</th>
          <th>Γ</th>
        </tr>
      </thead>
      <tbody>
        {legs.map((leg, i) => (
          <tr key={`${leg.symbol}-${i}`}>
            <td className={`l ${leg.direction === "Long" ? "pos" : "neg"}`}>
              {leg.direction.toUpperCase()}
            </td>
            <td className="l">
              <span className="sym">{leg.symbol}</span>
            </td>
            <td>{leg.quantity}</td>
            <td>{leg.premium != null ? leg.premium.toFixed(2) : "—"}</td>
            <td>{leg.delta != null ? leg.delta.toFixed(2) : "—"}</td>
            <td>{leg.gamma != null ? leg.gamma.toFixed(3) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Totals({ totals }: { totals: OrderTicketTotals }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr 60px 1fr",
        rowGap: 4,
        columnGap: 8,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
      }}
    >
      <span className="dim">Δ</span>
      <span className="num">{totals.delta != null ? signed(totals.delta, 2) : "—"}</span>
      <span className="dim">Γ</span>
      <span className="num">{totals.gamma != null ? signed(totals.gamma, 3) : "—"}</span>
      <span className="dim">Θ</span>
      <span className="num">{totals.theta != null ? signed(totals.theta, 2) : "—"}</span>
      <span className="dim">ν</span>
      <span className="num">{totals.vega != null ? signed(totals.vega, 2) : "—"}</span>
      <span className="dim">Cost</span>
      <span className="num">{totals.cost != null ? usd(totals.cost, 0) : "—"}</span>
      <span className="dim">Margin</span>
      <span className="num">{totals.margin != null ? usd(totals.margin, 0) : "—"}</span>
    </div>
  );
}
