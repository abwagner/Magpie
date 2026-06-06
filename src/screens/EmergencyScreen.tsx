import { useCallback, useEffect, useMemo, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { getHaltsHistory, haltPortfolio, resetPortfolio } from "../lib/api.js";
import { usePortfolios, useSystemState } from "../state/StateProvider.js";
import type { HaltEvent } from "../types/halts.js";
import type { PortfolioState } from "../types/portfolio.js";

// Settings · Risk · Emergency (QF-60)
//
// Per-portfolio halt controls + audit history. PortfolioEngine
// already owns the runtime halt state (state.halted /
// state.halt_reason); this screen wires the operator surface and the
// audit trail.
//
// Out of scope for v1 (filed as follow-ups in the PR body): cancel-
// all-pending, drain mode (reject new intents while completing
// pending fills), and a per-portfolio version of the order plane's
// killSwitch. The header below names these.

const REFRESH_MS = 8000;

export function EmergencyScreen() {
  const portfolios = usePortfolios();
  const system = useSystemState();
  const [history, setHistory] = useState<HaltEvent[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await getHaltsHistory(200);
      setHistory(res.events);
      setHistoryError(null);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  const portfolioIds = useMemo(() => Object.keys(portfolios).sort(), [portfolios]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · Risk · Emergency"
        title="Emergency"
        body="Per-portfolio halt + reset with audit history. System-wide kill switch still lives in the header. Cancel-all-pending and drain mode are deferred (separate tickets — see PR body)."
      />
      {system?.halted && (
        <div
          className="neg"
          style={{
            background: "var(--bg-pane)",
            border: "1px solid var(--neg)",
            borderRadius: "var(--r-2)",
            padding: 10,
            fontSize: 12,
          }}
        >
          <strong>SYSTEM HALTED</strong>
          {system.halt_reason ? ` · ${system.halt_reason}` : ""} — reset from the header kill
          switch.
        </div>
      )}
      <PortfolioPanels
        portfolioIds={portfolioIds}
        portfolios={portfolios}
        onChanged={() => void reload()}
      />
      <HistoryPanel events={history} error={historyError} />
    </div>
  );
}

function PortfolioPanels({
  portfolioIds,
  portfolios,
  onChanged,
}: {
  portfolioIds: string[];
  portfolios: Record<string, PortfolioState>;
  onChanged: () => void;
}) {
  if (portfolioIds.length === 0) {
    return (
      <div className="dim" style={{ fontSize: 12, padding: 12 }}>
        No portfolios loaded.
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
        gap: 10,
      }}
    >
      {portfolioIds.map((id) => (
        <PortfolioCard key={id} portfolioId={id} state={portfolios[id]} onChanged={onChanged} />
      ))}
    </div>
  );
}

function PortfolioCard({
  portfolioId,
  state,
  onChanged,
}: {
  portfolioId: string;
  state: PortfolioState | undefined;
  onChanged: () => void;
}) {
  const halted = state?.halted ?? false;
  const haltReason = state?.halt_reason;

  return (
    <div
      style={{
        background: "var(--bg-pane)",
        border: "1px solid var(--border-1)",
        borderRadius: "var(--r-2)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="mono" style={{ color: "var(--text-1)", fontSize: 13 }}>
          {portfolioId}
        </span>
        <span style={{ flex: 1 }} />
        <span className={`badge ${halted ? "neg" : "pos"}`}>{halted ? "HALTED" : "ACTIVE"}</span>
      </div>
      {halted && haltReason && (
        <div className="dim" style={{ fontSize: 11, fontStyle: "italic" }}>
          {haltReason}
        </div>
      )}
      <ActionRow portfolioId={portfolioId} halted={halted} onChanged={onChanged} />
    </div>
  );
}

function ActionRow({
  portfolioId,
  halted,
  onChanged,
}: {
  portfolioId: string;
  halted: boolean;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAction() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Reason is required");
      return;
    }
    if (
      !confirm(
        halted
          ? `Reset halt on ${portfolioId}?\n\nReason: ${trimmed}`
          : `Halt ${portfolioId}?\n\nReason: ${trimmed}`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (halted) {
        await resetPortfolio(portfolioId, trimmed);
      } else {
        await haltPortfolio(portfolioId, trimmed);
      }
      setReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        type="text"
        placeholder={halted ? "Reason for reset" : "Reason for halt"}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--r-2)",
          padding: "4px 8px",
          fontSize: 12,
          color: "var(--text-1)",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={() => void onAction()}
          disabled={busy}
          style={{
            background: halted ? "var(--accent)" : "var(--neg)",
            color: "var(--text-1)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--r-2)",
            padding: "4px 12px",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "var(--font-ui)",
          }}
        >
          {busy ? "…" : halted ? "Reset halt" : "Halt"}
        </button>
        {error && (
          <span className="neg" style={{ fontSize: 11 }}>
            {error}
          </span>
        )}
      </div>
    </>
  );
}

function HistoryPanel({ events, error }: { events: HaltEvent[]; error: string | null }) {
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
        History (newest first)
      </div>
      {error ? (
        <div className="neg" style={{ fontSize: 11 }}>
          {error}
        </div>
      ) : events.length === 0 ? (
        <div className="dim2" style={{ fontSize: 11 }}>
          No halts recorded.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-4)", fontSize: 11 }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500 }}>When</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Portfolio</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Kind</th>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Reason</th>
              <th style={{ textAlign: "left", padding: "4px 0 4px 8px", fontWeight: 500 }}>
                Actor
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr
                key={`${e.ts}-${i}`}
                style={{ borderTop: "1px solid var(--border-1)", verticalAlign: "top" }}
              >
                <td className="mono dim" style={{ padding: "6px 8px 6px 0", fontSize: 11 }}>
                  {new Date(e.ts).toLocaleString()}
                </td>
                <td className="mono" style={{ padding: "6px 8px" }}>
                  {e.portfolio_id}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  <span className={`badge ${e.kind === "halt" ? "neg" : "pos"}`}>
                    {e.kind.toUpperCase()}
                  </span>
                </td>
                <td style={{ padding: "6px 8px", color: "var(--text-2)" }}>{e.reason}</td>
                <td className="mono dim2" style={{ padding: "6px 0 6px 8px", fontSize: 11 }}>
                  {e.actor}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
