// ── Per-Run Activity Drilldown ────────────────────────────────────
// Lazy-loaded payload from /api/downloads/runs/:id. Shows per-symbol
// roll-up of files touched, contracts, credits, and any error refs.

import { useEffect, useState } from "react";
import { C, mono } from "../lib/constants.js";
import { fmtNum, dateRange } from "../lib/format.js";
import { api } from "../lib/api.js";
import type { RunActivityResponse } from "../types/downloads.js";

export interface RunActivityDetailProps {
  runId: string;
}

export function RunActivityDetail({ runId }: RunActivityDetailProps) {
  const [data, setData] = useState<RunActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getDownloadRun(runId)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  if (loading) {
    return <div style={{ color: C.dim, padding: 8, fontSize: 11 }}>Loading…</div>;
  }
  if (error) {
    return <div style={{ color: C.red, padding: 8, fontSize: 11, fontFamily: mono }}>{error}</div>;
  }
  if (!data || data.activity.length === 0) {
    return (
      <div style={{ color: C.dim, padding: 8, fontSize: 11 }}>
        No per-symbol activity recorded for this run.
      </div>
    );
  }

  const visible = data.activity.slice(0, 50);
  const hidden = data.activity.length - visible.length;

  return (
    <div style={{ padding: "6px 10px", background: C.bg, borderRadius: 4 }}>
      <div
        style={{
          fontSize: 9,
          color: C.dim,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        Per-symbol activity ({data.activity.length} symbol
        {data.activity.length === 1 ? "" : "s"})
      </div>
      <table style={{ width: "100%", fontSize: 10, fontFamily: mono, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: C.dim, fontSize: 9, textTransform: "uppercase" }}>
            <th style={{ textAlign: "left", padding: "2px 4px" }}>Symbol</th>
            <th style={{ textAlign: "left", padding: "2px 4px" }}>Date Range</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Files</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Contracts</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Errors</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((a) => (
            <tr key={a.symbol} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: "2px 4px", color: C.accent }}>{a.symbol}</td>
              <td style={{ padding: "2px 4px", color: C.text }}>
                {dateRange(a.date_range?.[0], a.date_range?.[1])}
              </td>
              <td style={{ padding: "2px 4px", textAlign: "right" }}>{a.files_touched}</td>
              <td style={{ padding: "2px 4px", textAlign: "right" }}>{fmtNum(a.contracts)}</td>
              <td
                style={{
                  padding: "2px 4px",
                  textAlign: "right",
                  color: a.errors.length ? C.red : C.dim,
                }}
              >
                {a.errors.length ? a.errors.length : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <div style={{ color: C.dim, fontSize: 9, marginTop: 4 }}>
          + {hidden} more symbol{hidden === 1 ? "" : "s"} not shown
        </div>
      )}
    </div>
  );
}

export default RunActivityDetail;
