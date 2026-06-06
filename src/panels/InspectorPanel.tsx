// ── Trade Inspector Panel (QF-229) ────────────────────────────────
// Detail view for a single fill_id. Calls GET /api/trades/inspect
// (the QF-215 structured handler) and renders the full audit chain
// as five sections: Signal → Intent → Pricing decision(s) →
// Inputs snapshot → Order lifecycle → Fill.
//
// Cross-fill search (by time / strategy / signal) is intentionally
// out of scope for this ticket; a future "search shell" panel could
// wrap this detail view.

import { useState, type FormEvent } from "react";
import { Panel } from "../components/ui/Panel.js";
import { Icon } from "../components/ui/Icon.js";
import { inspectTrade } from "../lib/api.js";

// ── Wire payload (mirrors server/order/trade-inspector.ts) ────────

interface InspectorFillRow {
  fill_id: string;
  order_id: string;
  price: number;
  quantity: number;
  fees: number | null;
  filled_at: string;
  expected_price: number | null;
  slippage: number | null;
}

interface InspectorOrderRow {
  order_id: string;
  intent_id: string;
  broker: string;
  execution_mode: string;
  status: string;
  created_at: string;
  risk_checked_at: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  broker_order_id: string | null;
  operator_edits: unknown;
  risk_violations: unknown;
  halt_reason: string | null;
  broker_rejection_reason: string | null;
  quote_failure_reason?: string | null;
  cancel_reason?: string | null;
}

interface InspectorIntentRow {
  intent_id: string;
  portfolio: string;
  strategy_id: string;
  symbol: string;
  direction: string;
  quantity: number;
  signal_ids: string[];
  created_at: string;
}

interface InspectorPricingDecisionRow {
  decision_id: string;
  intent_id: string;
  strategy_id: string;
  strategy_chosen: string;
  profile_source: string;
  inputs: unknown;
  order_type: string;
  limit_price: number | null;
  limit_price_pre_snap: number | null;
  time_in_force: string;
  working_policy_id: string;
  reasoning: string;
  created_at: string;
}

interface InspectorSignalRow {
  signal_id: string;
  model_id: string;
  model_version: string;
  symbol: string;
  asof: string;
  kind: string;
  batch_id: string | null;
  ingest_ts: string;
}

interface TradeInspectorResult {
  fill: InspectorFillRow;
  order: InspectorOrderRow;
  intent: InspectorIntentRow;
  pricing_decisions: InspectorPricingDecisionRow[];
  originating_signal: InspectorSignalRow | null;
}

// ── Component ─────────────────────────────────────────────────────

export function InspectorPanel() {
  const [fillId, setFillId] = useState("");
  const [result, setResult] = useState<TradeInspectorResult | null>(null);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = fillId.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const data = (await inspectTrade(trimmed)) as TradeInspectorResult;
      setResult(data);
    } catch (err) {
      // The shared get() helper throws plain Errors with the server's
      // {error: "..."} message; "No fill with fill_id=..." is the 404
      // shape from TradeInspectorNotFoundError. Detect via prefix until
      // get() learns to expose HTTP status.
      const msg = (err as Error).message;
      const isNotFound = msg.startsWith("No fill with fill_id");
      setError({
        ...(isNotFound ? { status: 404 } : {}),
        message: msg,
      });
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setFillId(text.trim());
    } catch {
      // Clipboard access blocked — let the operator paste manually.
    }
  }

  return (
    <Panel
      title="Trade Inspector"
      headerExtra={
        <span className="dim2" style={{ fontSize: 10 }}>
          /api/trades/inspect
        </span>
      }
      actions={["filter", "kebab"]}
    >
      <form
        onSubmit={search}
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border-1)",
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 220 }}>
          <span
            className="dim"
            style={{ fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase" }}
          >
            Fill ID
          </span>
          <input
            className="input"
            type="text"
            value={fillId}
            onChange={(e) => setFillId(e.target.value)}
            placeholder="01HW..."
            autoFocus
          />
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={pasteFromClipboard}
          title="Paste fill_id from clipboard"
        >
          Paste
        </button>
        <button type="submit" className="btn btn-primary" disabled={loading || !fillId.trim()}>
          {loading ? (
            "…"
          ) : (
            <>
              <Icon name="search" size={11} />
              <span style={{ marginLeft: 6 }}>Inspect</span>
            </>
          )}
        </button>
      </form>
      <div style={{ padding: 12, overflow: "auto" }}>
        {error && error.status === 404 && (
          <EmptyState
            title="No fill found"
            detail={`Fill ID "${fillId}" doesn't match any audit_fills row.`}
          />
        )}
        {error && error.status !== 404 && (
          <div className="neg" style={{ fontSize: 11 }}>
            {error.message}
          </div>
        )}
        {!error && !result && (
          <div className="dim" style={{ fontSize: 11 }}>
            Enter a fill_id above to see the full audit chain.
          </div>
        )}
        {!error && result && <ResultView result={result} />}
      </div>
    </Panel>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────

function ResultView({ result }: { result: TradeInspectorResult }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Section title="Signal">
        <SignalView signal={result.originating_signal} />
      </Section>
      <Section title="Intent">
        <IntentView intent={result.intent} />
      </Section>
      <Section title="Pricing decision">
        <PricingDecisionsView decisions={result.pricing_decisions} />
      </Section>
      <Section title="Order lifecycle">
        <OrderView order={result.order} />
      </Section>
      <Section title="Fill">
        <FillView fill={result.fill} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--bg-app)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 10,
      }}
    >
      <div
        className="dim"
        style={{
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 6,
          color: "var(--accent)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function SignalView({ signal }: { signal: InspectorSignalRow | null }) {
  if (!signal) {
    return (
      <div className="dim" style={{ fontSize: 11 }}>
        Intent referenced no upstream signal (legacy path or manual entry).
      </div>
    );
  }
  return (
    <KV
      rows={[
        ["model", `${signal.model_id} @ ${signal.model_version}`],
        ["symbol", signal.symbol],
        ["as of", signal.asof],
        ["kind", signal.kind],
        ["ingested", signal.ingest_ts],
        ...(signal.batch_id ? ([["batch_id", signal.batch_id]] as Array<[string, string]>) : []),
      ]}
    />
  );
}

function IntentView({ intent }: { intent: InspectorIntentRow }) {
  return (
    <KV
      rows={[
        ["strategy", intent.strategy_id],
        ["portfolio", intent.portfolio],
        ["symbol", intent.symbol],
        ["direction", intent.direction],
        ["quantity", String(intent.quantity)],
        ["signal_ids", intent.signal_ids.length === 0 ? "—" : intent.signal_ids.join(", ")],
        ["created_at", intent.created_at],
      ]}
    />
  );
}

function PricingDecisionsView({ decisions }: { decisions: InspectorPricingDecisionRow[] }) {
  if (decisions.length === 0) {
    return (
      <div className="dim" style={{ fontSize: 11 }}>
        No pricing decisions recorded (pre-Execution-Layer order).
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {decisions.map((d, i) => (
        <div
          key={d.decision_id}
          style={{
            ...(decisions.length > 1
              ? {
                  borderLeft: "2px solid var(--border-1)",
                  paddingLeft: 8,
                }
              : {}),
          }}
        >
          {decisions.length > 1 && (
            <div className="dim" style={{ fontSize: 9, marginBottom: 2, letterSpacing: "0.06em" }}>
              DECISION {i + 1} of {decisions.length} · {d.created_at}
            </div>
          )}
          <div
            className="mono"
            style={{
              fontSize: 11,
              padding: "4px 6px",
              background: "var(--bg-pane)",
              borderRadius: "var(--r-1)",
              marginBottom: 6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {d.reasoning}
          </div>
          <KV
            rows={[
              ["strategy_chosen", d.strategy_chosen],
              ["profile_source", d.profile_source],
              ["order_type", d.order_type],
              [
                "limit_price",
                d.limit_price != null
                  ? `${d.limit_price.toFixed(2)}${
                      d.limit_price_pre_snap != null && d.limit_price_pre_snap !== d.limit_price
                        ? ` (pre-snap: ${d.limit_price_pre_snap.toFixed(2)})`
                        : ""
                    }`
                  : "—",
              ],
              ["time_in_force", d.time_in_force],
              ["working_policy", d.working_policy_id],
            ]}
          />
          <InputsSnapshotView inputs={d.inputs} />
        </div>
      ))}
    </div>
  );
}

function InputsSnapshotView({ inputs }: { inputs: unknown }) {
  if (!inputs || typeof inputs !== "object") return null;
  const obj = inputs as Record<string, unknown>;
  const bid = obj.bid as number | undefined;
  const ask = obj.ask as number | undefined;
  const mid = obj.mid as number | undefined;
  const signalAgeMs = obj.signal_age_ms as number | undefined;
  const signalHorizonMs = obj.signal_horizon_ms as number | undefined;
  const meta = obj._meta as Record<string, unknown> | undefined;
  if (
    bid == null &&
    ask == null &&
    mid == null &&
    signalAgeMs == null &&
    signalHorizonMs == null &&
    !meta
  )
    return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div
        className="dim"
        style={{
          fontSize: 9,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 3,
        }}
      >
        Inputs snapshot
      </div>
      <KV
        rows={[
          ...(bid != null && ask != null
            ? ([
                [
                  "quote",
                  `bid ${bid.toFixed(2)} · ask ${ask.toFixed(2)}${mid != null ? ` · mid ${mid.toFixed(2)}` : ""}`,
                ],
              ] as Array<[string, string]>)
            : []),
          ...(signalAgeMs != null
            ? ([["signal_age_ms", String(signalAgeMs)]] as Array<[string, string]>)
            : []),
          ...(signalHorizonMs != null
            ? ([["signal_horizon_ms", String(signalHorizonMs)]] as Array<[string, string]>)
            : []),
          ...(meta?.source ? ([["source", String(meta.source)]] as Array<[string, string]>) : []),
        ]}
      />
    </div>
  );
}

function OrderView({ order }: { order: InspectorOrderRow }) {
  const timestamps: Array<[string, string]> = [
    ["created_at", order.created_at],
    ...(order.risk_checked_at
      ? ([["risk_checked_at", order.risk_checked_at]] as Array<[string, string]>)
      : []),
    ...(order.approved_at ? ([["approved_at", order.approved_at]] as Array<[string, string]>) : []),
    ...(order.submitted_at
      ? ([["submitted_at", order.submitted_at]] as Array<[string, string]>)
      : []),
    ...(order.completed_at
      ? ([["completed_at", order.completed_at]] as Array<[string, string]>)
      : []),
  ];
  const reasons: Array<[string, string]> = [
    ...(order.broker_rejection_reason
      ? ([["broker_rejection_reason", order.broker_rejection_reason]] as Array<[string, string]>)
      : []),
    ...(order.quote_failure_reason
      ? ([["quote_failure_reason", order.quote_failure_reason]] as Array<[string, string]>)
      : []),
    ...(order.cancel_reason
      ? ([["cancel_reason", order.cancel_reason]] as Array<[string, string]>)
      : []),
    ...(order.halt_reason ? ([["halt_reason", order.halt_reason]] as Array<[string, string]>) : []),
  ];
  return (
    <>
      <KV
        rows={[
          ["status", order.status],
          ["broker", `${order.broker} · ${order.execution_mode}`],
          ["order_id", order.order_id],
          ...(order.broker_order_id
            ? ([["broker_order_id", order.broker_order_id]] as Array<[string, string]>)
            : []),
        ]}
      />
      <div style={{ marginTop: 6 }}>
        <KV rows={timestamps} />
      </div>
      {reasons.length > 0 && (
        <div style={{ marginTop: 6 }} className="neg">
          <KV rows={reasons} />
        </div>
      )}
    </>
  );
}

function FillView({ fill }: { fill: InspectorFillRow }) {
  return (
    <KV
      rows={[
        ["fill_id", fill.fill_id],
        ["price", fill.price.toFixed(4)],
        ["quantity", String(fill.quantity)],
        ...(fill.expected_price != null
          ? ([["expected_price", fill.expected_price.toFixed(4)]] as Array<[string, string]>)
          : []),
        ...(fill.slippage != null
          ? ([["slippage", fill.slippage.toFixed(4)]] as Array<[string, string]>)
          : []),
        ...(fill.fees != null ? ([["fees", fill.fees.toFixed(4)]] as Array<[string, string]>) : []),
        ["filled_at", fill.filled_at],
      ]}
    />
  );
}

function KV({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr",
        gap: "2px 12px",
        fontSize: 11,
      }}
    >
      {rows.map(([k, v]) => (
        <KVRow key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function KVRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div
        className="dim"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-3)",
        }}
      >
        {k}
      </div>
      <div
        className="mono"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-1)",
          wordBreak: "break-all",
        }}
      >
        {v}
      </div>
    </>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ textAlign: "center", padding: "24px 12px" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div className="dim" style={{ fontSize: 11 }}>
        {detail}
      </div>
    </div>
  );
}
