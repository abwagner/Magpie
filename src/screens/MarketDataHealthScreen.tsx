import { useCallback, useEffect, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import {
  getCatalogFreshness,
  getMarketDataBridges,
  getWriteJobToken,
  setWriteJobToken,
  submitIngest,
} from "../lib/api.js";
import type { BridgeStatus, BridgePolicy } from "../types/marketdata-health.js";
import type { FreshnessResponse, FreshnessStatus, SourceFreshness } from "../types/catalog.js";

// Settings · Data · Health (QF-55 / QF-296)
//
// Top section: per-broker bridge alive state + heartbeat age + RPC
// error rate (post-rewrite bridge-heartbeat topology, QF-296).
//
// Bottom section: batch ingestion freshness (QF-293/QF-294).
//
// Data source: server/market-data/health.ts.
// This screen is read-only; refreshes every 5s while mounted.

const REFRESH_MS = 5000;

// ── Freshness status ordering ─────────────────────────────────────
// missing (0) → stale (1) → fresh (2), so ascending sort puts worst first.
const STATUS_ORDER: Record<FreshnessStatus, number> = {
  missing: 0,
  stale: 1,
  fresh: 2,
};

const FRESHNESS_BADGE: Record<FreshnessStatus, string> = {
  fresh: "✅",
  stale: "⚠",
  missing: "🔴",
};

const FRESHNESS_TONE: Record<FreshnessStatus, string> = {
  fresh: "pos",
  stale: "warn",
  missing: "neg",
};

export function MarketDataHealthScreen() {
  const [bridges, setBridges] = useState<BridgeStatus[] | null>(null);
  const [bridgePolicy, setBridgePolicy] = useState<BridgePolicy | undefined>(undefined);
  const [bridgesError, setBridgesError] = useState<string | null>(null);
  const [bridgesLoading, setBridgesLoading] = useState(true);

  const [freshness, setFreshness] = useState<FreshnessResponse | null>(null);
  const [freshnessError, setFreshnessError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    function fetchBridges() {
      getMarketDataBridges()
        .then((res) => {
          if (!cancelled) {
            setBridges(res.bridges);
            setBridgePolicy(res.policy);
            setBridgesError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setBridgesError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setBridgesLoading(false);
        });
    }

    fetchBridges();
    const id = window.setInterval(fetchBridges, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    function fetchFreshness() {
      getCatalogFreshness()
        .then((res) => {
          if (!cancelled) {
            setFreshness(res);
            setFreshnessError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setFreshnessError(e instanceof Error ? e.message : String(e));
        });
    }

    fetchFreshness();
    const id = window.setInterval(fetchFreshness, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · Data · Health"
        title="Market data health"
        body={`Live broker bridge status + batch ingestion freshness. Auto-refreshes every ${REFRESH_MS / 1000}s.`}
      />
      <BridgesPanel
        bridges={bridges}
        loading={bridgesLoading}
        error={bridgesError}
        policy={bridgePolicy}
      />
      <BatchFreshnessPanel
        freshness={freshness}
        freshnessError={freshnessError}
        onRefresh={() => {
          // Trigger immediate re-fetch after a Run-now submission.
          getCatalogFreshness()
            .then((res) => {
              setFreshness(res);
              setFreshnessError(null);
            })
            .catch((e: unknown) => {
              setFreshnessError(e instanceof Error ? e.message : String(e));
            });
        }}
      />
    </div>
  );
}

// ── Broker MD Bridges ─────────────────────────────────────────────
// Post-rewrite top section: one row per active broker bridge showing
// alive/heartbeat/RPC-error. Stale heartbeat (> 30s) renders in red.

export interface BridgesPanelProps {
  bridges: BridgeStatus[] | null;
  loading: boolean;
  error: string | null;
  // QF-341 — read-only MD fallback policy header (Settings → Bridges).
  policy?: BridgePolicy;
}

export function BridgesPanel({ bridges, loading, error, policy }: BridgesPanelProps) {
  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        Broker MD bridges
      </div>
      {policy ? <FallbackPolicyHeader policy={policy} /> : null}
      {error ? (
        <div className="neg" style={{ fontSize: 11 }}>
          Failed to load: {error}
        </div>
      ) : loading && bridges === null ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          Loading…
        </div>
      ) : bridges !== null && bridges.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No bridge adapters configured. Enable nt_bridge in config/market-data.json.
        </div>
      ) : bridges !== null ? (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "var(--text-4)", fontSize: 11 }}>
                <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500 }}>
                  Broker
                </th>
                <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Status</th>
                <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Role</th>
                <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>
                  Last heartbeat
                </th>
                <th style={{ textAlign: "right", padding: "4px 0 4px 8px", fontWeight: 500 }}>
                  RPC err rate
                </th>
              </tr>
            </thead>
            <tbody>
              {bridges.map((b) => (
                <BridgeRow key={b.broker} bridge={b} />
              ))}
            </tbody>
          </table>
          <div className="dim2" style={{ fontSize: 10, marginTop: 8 }}>
            Bridge unavailable threshold: 30s without heartbeat.
          </div>
        </>
      ) : null}
    </div>
  );
}

// QF-341 — read-only fallback policy header. Mirrors the read-only
// posture of the BrokersScreen adapter cards; the policy is edited in
// config/brokers.json, not here.
function FallbackPolicyHeader({ policy }: { policy: BridgePolicy }) {
  const overrides = Object.entries(policy.methods);
  return (
    <div
      className="dim2"
      style={{
        fontSize: 10,
        marginBottom: 8,
        padding: "6px 8px",
        background: "var(--bg-1)",
        borderRadius: "var(--r-1)",
      }}
    >
      <span>
        Fallback:{" "}
        <span className={policy.fallback_enabled ? "pos" : "dim"}>
          {policy.fallback_enabled ? "enabled" : "disabled"}
        </span>
      </span>
      {policy.priority.length > 0 ? (
        <span style={{ marginLeft: 12 }}>Priority: {policy.priority.join(" → ")}</span>
      ) : null}
      <span style={{ marginLeft: 12 }}>Stale threshold: {policy.heartbeat_stale_ms / 1000}s</span>
      {overrides.length > 0 ? (
        <span style={{ marginLeft: 12 }}>
          Overrides:{" "}
          {overrides
            .map(([m, o]) => {
              const parts: string[] = [];
              if (o.fallback_enabled !== undefined)
                parts.push(o.fallback_enabled ? "on" : "off");
              if (o.priority) parts.push(o.priority.join(">"));
              return `${m}(${parts.join(", ")})`;
            })
            .join(", ")}
        </span>
      ) : null}
    </div>
  );
}

interface BridgeRowProps {
  bridge: BridgeStatus;
}

function BridgeRow({ bridge }: BridgeRowProps) {
  const aliveLabel = bridge.alive ? "alive" : "unavailable";
  const aliveTone = bridge.alive ? "pos" : "neg";
  const aliveDot = bridge.alive ? "●" : "●";

  const heartbeatLabel =
    bridge.last_heartbeat_age_ms !== null
      ? formatHeartbeatAge(bridge.last_heartbeat_age_ms)
      : bridge.alive
        ? "< 30s ago"
        : "stale";

  const heartbeatTone = bridge.alive ? undefined : "neg";

  const roleLabel =
    bridge.priority_rank === null
      ? "—"
      : bridge.priority_rank === 0
        ? "primary"
        : `fallback #${bridge.priority_rank}`;

  const errorPct =
    bridge.rpc_count_5m > 0 ? `${(bridge.rpc_error_rate_5m * 100).toFixed(1)}%` : "—";
  const errorTone =
    bridge.rpc_error_rate_5m >= 0.1 ? "neg" : bridge.rpc_error_rate_5m > 0 ? "warn" : undefined;

  return (
    <tr style={{ borderTop: "1px solid var(--border-1)", verticalAlign: "middle" }}>
      <td className="mono" style={{ padding: "8px 8px 8px 0", color: "var(--text-2)" }}>
        {bridge.broker}
      </td>
      <td style={{ padding: "8px 8px" }}>
        <span className={aliveTone} aria-label={aliveLabel}>
          {aliveDot}
        </span>{" "}
        <span className={aliveTone} style={{ fontSize: 11 }}>
          {aliveLabel}
        </span>
      </td>
      <td style={{ padding: "8px 8px" }}>
        <span className="dim" style={{ fontSize: 11 }}>
          {roleLabel}
        </span>
        {bridge.serving_as_fallback ? (
          <span className="warn" style={{ fontSize: 10, marginLeft: 6 }} aria-label="serving as fallback">
            serving as fallback
          </span>
        ) : null}
      </td>
      <td style={{ padding: "8px 8px" }}>
        <span
          className={heartbeatTone !== undefined ? heartbeatTone : "dim"}
          style={{ fontSize: 11 }}
        >
          {heartbeatLabel}
        </span>
      </td>
      <td
        className="mono"
        style={{
          padding: "8px 0 8px 8px",
          textAlign: "right",
          color: errorTone !== undefined ? `var(--${errorTone})` : undefined,
        }}
      >
        {errorPct}{" "}
        <span className="dim2" style={{ fontSize: 10 }}>
          (last 5m)
        </span>
      </td>
    </tr>
  );
}

function formatHeartbeatAge(ms: number): string {
  if (ms < 1000) return "< 1s ago";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

// ── Batch Ingestion Freshness ─────────────────────────────────────

interface BatchFreshnessPanelProps {
  freshness: FreshnessResponse | null;
  freshnessError: string | null;
  onRefresh: () => void;
}

export function BatchFreshnessPanel({
  freshness,
  freshnessError,
  onRefresh,
}: BatchFreshnessPanelProps) {
  const [tokenInput, setTokenInput] = useState<string>(getWriteJobToken() ?? "");
  const [tokenSaved, setTokenSaved] = useState<string | null>(getWriteJobToken());
  const [runNowFeedback, setRunNowFeedback] = useState<Record<string, string>>({});
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  function onSaveToken(): void {
    const trimmed = tokenInput.trim();
    setWriteJobToken(trimmed.length > 0 ? trimmed : null);
    setTokenSaved(trimmed.length > 0 ? trimmed : null);
  }

  function onClearToken(): void {
    setWriteJobToken(null);
    setTokenSaved(null);
    setTokenInput("");
  }

  const handleRunNow = useCallback(
    async (source: string): Promise<void> => {
      if (inFlight.has(source)) return;
      setInFlight((prev) => new Set([...prev, source]));
      setRunNowFeedback((prev) => {
        const next = { ...prev };
        delete next[source];
        return next;
      });
      try {
        const res = await submitIngest(source);
        setRunNowFeedback((prev) => ({
          ...prev,
          [source]: `job_id=${res.job_id}${res.deduped ? " (deduped)" : ""}`,
        }));
        onRefresh();
      } catch (e) {
        setRunNowFeedback((prev) => ({
          ...prev,
          [source]: `Error: ${e instanceof Error ? e.message : String(e)}`,
        }));
      } finally {
        setInFlight((prev) => {
          const next = new Set(prev);
          next.delete(source);
          return next;
        });
      }
    },
    [inFlight, onRefresh],
  );

  const sorted = freshness
    ? [...freshness.sources].sort((a, b) => {
        const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (byStatus !== 0) return byStatus;
        return a.source.localeCompare(b.source);
      })
    : null;

  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
      }}
    >
      <div className="dim" style={{ fontSize: 11, marginBottom: 10 }}>
        Batch ingestion freshness
      </div>
      {freshnessError ? (
        <div className="neg" style={{ fontSize: 11 }}>
          Failed to load: {freshnessError}
        </div>
      ) : !sorted ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          Loading…
        </div>
      ) : sorted.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No sources configured.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-4)", fontSize: 11 }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500 }}>
                Source
              </th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>
                Last ingest
              </th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>
                Data through
              </th>
              <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 500 }}>Age</th>
              <th style={{ textAlign: "center", padding: "4px 8px", fontWeight: 500 }}>St</th>
              {tokenSaved && (
                <th style={{ textAlign: "left", padding: "4px 0 4px 8px", fontWeight: 500 }}>
                  Action
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <FreshnessRow
                key={s.source}
                row={s}
                showAction={!!tokenSaved}
                inFlight={inFlight.has(s.source)}
                feedback={runNowFeedback[s.source] ?? null}
                onRunNow={() => void handleRunNow(s.source)}
              />
            ))}
          </tbody>
        </table>
      )}
      {tokenSaved ? (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
          }}
        >
          <span className="dim2">
            Write token: {tokenSaved.slice(0, 4)}…{tokenSaved.slice(-4)}
          </span>
          <button
            type="button"
            onClick={onClearToken}
            style={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--r-2)",
              padding: "2px 10px",
              fontSize: 11,
              color: "var(--text-2)",
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
            }}
          >
            Clear token
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="password"
            placeholder="Paste write-dispatch bearer token to enable Run now"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{
              flex: 1,
              background: "var(--bg-elev)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--r-2)",
              padding: "5px 8px",
              fontSize: 11,
              color: "var(--text-1)",
              fontFamily: "var(--font-mono)",
            }}
          />
          <button
            type="button"
            onClick={onSaveToken}
            disabled={tokenInput.trim().length === 0}
            style={{
              background: "var(--accent)",
              color: "var(--text-1)",
              border: "1px solid var(--border-1)",
              borderRadius: "var(--r-2)",
              padding: "5px 12px",
              fontSize: 11,
              cursor: tokenInput.trim().length === 0 ? "not-allowed" : "pointer",
              opacity: tokenInput.trim().length === 0 ? 0.5 : 1,
              fontFamily: "var(--font-ui)",
            }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

interface FreshnessRowProps {
  row: SourceFreshness;
  showAction: boolean;
  inFlight: boolean;
  feedback: string | null;
  onRunNow: () => void;
}

function FreshnessRow({ row, showAction, inFlight, feedback, onRunNow }: FreshnessRowProps) {
  const age = formatAge(row.age_hours);

  return (
    <tr style={{ borderTop: "1px solid var(--border-1)", verticalAlign: "top" }}>
      <td className="mono" style={{ padding: "6px 8px 6px 0", color: "var(--text-2)" }}>
        {row.source}
      </td>
      <td className="mono dim" style={{ padding: "6px 8px", fontSize: 11 }}>
        {row.last_success_at ? relativeTime(row.last_success_at) : "—"}
      </td>
      <td className="mono dim" style={{ padding: "6px 8px", fontSize: 11 }}>
        {row.data_through ?? "—"}
      </td>
      <td className="mono" style={{ padding: "6px 8px", textAlign: "right", fontSize: 11 }}>
        {age}
      </td>
      <td style={{ padding: "6px 8px", textAlign: "center" }}>
        <span
          className={FRESHNESS_TONE[row.status]}
          style={{ fontSize: 13 }}
          aria-label={row.status}
        >
          {FRESHNESS_BADGE[row.status]}
        </span>
      </td>
      {showAction && (
        <td style={{ padding: "6px 0 6px 8px" }}>
          {(row.status === "stale" || row.status === "missing") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <button
                type="button"
                onClick={onRunNow}
                disabled={inFlight}
                aria-label={`Run now: ${row.source}`}
                style={{
                  background: "var(--bg-elev)",
                  border: "1px solid var(--border-1)",
                  borderRadius: "var(--r-2)",
                  padding: "2px 8px",
                  fontSize: 11,
                  cursor: inFlight ? "wait" : "pointer",
                  opacity: inFlight ? 0.6 : 1,
                  fontFamily: "var(--font-ui)",
                  color: "var(--text-2)",
                }}
              >
                {inFlight ? "Submitting…" : `Run now: ${row.source}`}
              </button>
              {feedback && (
                <span
                  className={feedback.startsWith("Error:") ? "neg" : "pos"}
                  style={{ fontSize: 10 }}
                >
                  {feedback}
                </span>
              )}
            </div>
          )}
        </td>
      )}
    </tr>
  );
}

// ── Freshness formatting helpers ──────────────────────────────────

function formatAge(ageHours: number | null): string {
  if (ageHours === null) return "—";
  if (ageHours < 24) return `${ageHours.toFixed(1)} h`;
  const days = ageHours / 24;
  if (days < 14) return `${days.toFixed(0)} d`;
  return `${(days / 7).toFixed(0)} wk`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)} min ago`;
  if (hours < 24) return `${hours.toFixed(0)} hour${hours < 2 ? "" : "s"} ago`;
  const days = hours / 24;
  if (days < 14) return `${days.toFixed(0)} day${days < 2 ? "" : "s"} ago`;
  return `${(days / 7).toFixed(0)} week${days < 14 ? "" : "s"} ago`;
}
