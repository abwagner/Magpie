import { useEffect, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { getFundamentalsStatus } from "../lib/api.js";
import type {
  FundamentalsFreshnessStatus,
  FundamentalsParquetStatus,
  FundamentalsStatusResponse,
} from "../types/fundamentals.js";

// Settings · Data · Fundamentals (QF-63)
//
// Visibility into the fundamentals parquets in the data lake. The
// adapter + manifest plumbing is done elsewhere (live: yfinance via
// peg-screen / peg-rotation manifests; planned: FMP via QF-188 →
// QF-192). This screen reads server/fundamentals/status.ts at
// REFRESH_MS cadence and renders per-parquet existence, row count,
// data-through date, and freshness vs the cron cadence.

const REFRESH_MS = 30_000;

const FRESHNESS_TONE: Record<FundamentalsFreshnessStatus, string> = {
  fresh: "pos",
  stale: "warn",
  missing: "neg",
};

const SOURCE_LABEL: Record<string, string> = {
  yfinance: "Yahoo Financial",
  fmp: "Financial Modeling Prep",
};

export function FundamentalsScreen() {
  const [data, setData] = useState<FundamentalsStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    function fetchOnce() {
      getFundamentalsStatus()
        .then((res) => {
          if (!cancelled) {
            setData(res);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    fetchOnce();
    const id = window.setInterval(fetchOnce, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · Data · Fundamentals"
        title="Fundamentals"
        body="Status of fundamentals parquets in the data lake — per-file existence, row count, data-through date, and freshness vs the scheduled refresh cadence. Read-only; cron pipelines own writes."
      />
      {loading && !data ? (
        <div className="dim" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : error ? (
        <div className="neg" style={{ fontSize: 12 }}>
          Failed to load: {error}
        </div>
      ) : data ? (
        <>
          <SourceGroups parquets={data.parquets} />
          <div className="dim2" style={{ fontSize: 10, marginTop: 4 }}>
            Snapshot generated {new Date(data.generated_at).toLocaleString()} · source of truth:{" "}
            <span className="mono">server/fundamentals/status.ts</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SourceGroups({ parquets }: { parquets: FundamentalsParquetStatus[] }) {
  const grouped = new Map<string, FundamentalsParquetStatus[]>();
  for (const p of parquets) {
    const list = grouped.get(p.source) ?? [];
    list.push(p);
    grouped.set(p.source, list);
  }
  if (grouped.size === 0) {
    return (
      <div className="dim" style={{ fontSize: 12, padding: 12 }}>
        No fundamentals parquets registered.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {[...grouped.entries()].map(([source, rows]) => (
        <SourcePanel key={source} source={source} rows={rows} />
      ))}
    </div>
  );
}

function SourcePanel({ source, rows }: { source: string; rows: FundamentalsParquetStatus[] }) {
  const label = SOURCE_LABEL[source] ?? source;
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
        {label}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "var(--text-4)", fontSize: 11 }}>
            <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500 }}>
              Parquet
            </th>
            <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Status</th>
            <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 500 }}>Rows</th>
            <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>Data through</th>
            <th style={{ textAlign: "right", padding: "4px 8px", fontWeight: 500 }}>Age</th>
            <th style={{ textAlign: "right", padding: "4px 0 4px 8px", fontWeight: 500 }}>
              Max age
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.file}
              style={{ borderTop: "1px solid var(--border-1)", verticalAlign: "top" }}
            >
              <td style={{ padding: "6px 8px 6px 0" }}>
                <div>{r.name}</div>
                <div className="mono dim2" style={{ fontSize: 10 }}>
                  {r.file}
                </div>
              </td>
              <td style={{ padding: "6px 8px" }}>
                <span className={`badge ${FRESHNESS_TONE[r.freshness_status]}`}>
                  {r.freshness_status.toUpperCase()}
                </span>
              </td>
              <td className="mono" style={{ padding: "6px 8px", textAlign: "right" }}>
                {r.row_count === null ? "—" : r.row_count.toLocaleString()}
              </td>
              <td className="mono dim" style={{ padding: "6px 8px", fontSize: 11 }}>
                {r.data_through ? formatDataThrough(r.data_through) : "—"}
              </td>
              <td
                className="mono dim"
                style={{ padding: "6px 8px", textAlign: "right", fontSize: 11 }}
              >
                {r.freshness_age_hours === null ? "—" : formatHours(r.freshness_age_hours)}
              </td>
              <td
                className="mono dim2"
                style={{ padding: "6px 0 6px 8px", textAlign: "right", fontSize: 11 }}
              >
                {formatHours(r.expected_max_age_hours)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDataThrough(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
