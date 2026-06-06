import { useEffect, useMemo, useState } from "react";
import { ScreenHeader } from "./RiskLimitsScreen.js";
import { exportDownloadUrl, listExports } from "../lib/api.js";
import type { ExportFormat, ExportKindMeta } from "../types/exports.js";

// Settings · Activity · Exports (QF-58)
//
// Operator picks a kind + date range + format and downloads.
// Server-side handler streams CSV/JSON from DuckDB; the screen is
// presentation only. New export kinds get one entry added to
// server/exports/api.ts; the screen self-populates from /api/exports.

export function ExportsScreen() {
  const [kinds, setKinds] = useState<ExportKindMeta[]>([]);
  const [selectedKind, setSelectedKind] = useState<string>("");
  const [from, setFrom] = useState<string>(defaultFromDate());
  const [to, setTo] = useState<string>(todayIso());
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listExports()
      .then((res) => {
        if (cancelled) return;
        setKinds(res.exports);
        if (res.exports[0]) setSelectedKind(res.exports[0].kind);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => kinds.find((k) => k.kind === selectedKind), [kinds, selectedKind]);
  const downloadUrl = selectedKind
    ? exportDownloadUrl(selectedKind, from || null, to || null, format)
    : null;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <ScreenHeader
        crumb="Settings · Activity · Exports"
        title="Exports"
        body="Download audit / journal slices as CSV or JSON. The server filters by date range and streams the result; data sources are the DuckDB tables — schema details listed below."
      />
      {loading && kinds.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : error ? (
        <div className="neg" style={{ fontSize: 12 }}>
          Failed to load: {error}
        </div>
      ) : (
        <div
          style={{
            background: "var(--bg-pane)",
            border: "1px solid var(--border-1)",
            borderRadius: "var(--r-2)",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <Row label="Export">
            <select
              value={selectedKind}
              onChange={(e) => setSelectedKind(e.target.value)}
              style={inputStyle()}
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="From">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              style={inputStyle(160)}
            />
          </Row>
          <Row label="To">
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              style={inputStyle(160)}
            />
          </Row>
          <Row label="Format">
            <div style={{ display: "flex", gap: 12 }}>
              {(["csv", "json"] as const).map((f) => (
                <label
                  key={f}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
                >
                  <input
                    type="radio"
                    name="format"
                    value={f}
                    checked={format === f}
                    onChange={() => setFormat(f)}
                  />
                  <span className="mono">{f.toUpperCase()}</span>
                </label>
              ))}
            </div>
          </Row>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
            {downloadUrl ? (
              <a
                href={downloadUrl}
                download
                style={{
                  background: "var(--accent)",
                  color: "var(--text-1)",
                  border: "1px solid var(--border-1)",
                  borderRadius: "var(--r-2)",
                  padding: "6px 14px",
                  fontSize: 12,
                  textDecoration: "none",
                  fontFamily: "var(--font-ui)",
                }}
              >
                Download
              </a>
            ) : null}
            <span className="dim2" style={{ fontSize: 10 }}>
              filtered on{" "}
              <span className="mono" style={{ color: "var(--text-3)" }}>
                {selected?.date_column ?? "—"}
              </span>
            </span>
          </div>

          {selected && (
            <div style={{ marginTop: 8, borderTop: "1px solid var(--border-1)", paddingTop: 10 }}>
              <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
                Columns ({selected.columns.length})
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  fontSize: 11,
                }}
              >
                {selected.columns.map((c) => (
                  <code
                    key={c}
                    style={{
                      background: "var(--bg-elev)",
                      border: "1px solid var(--border-1)",
                      borderRadius: "var(--r-2)",
                      padding: "2px 6px",
                      color: "var(--text-2)",
                    }}
                  >
                    {c}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="dim2" style={{ fontSize: 10 }}>
        Source of truth: <span className="mono">server/exports/api.ts</span>. New kinds get one
        entry added to the EXPORTS map there.
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        alignItems: "center",
        gap: 10,
        fontSize: 12,
      }}
    >
      <label className="dim">{label}</label>
      {children}
    </div>
  );
}

function inputStyle(width?: number): React.CSSProperties {
  return {
    background: "var(--bg-elev)",
    border: "1px solid var(--border-1)",
    borderRadius: "var(--r-2)",
    padding: "4px 8px",
    fontSize: 12,
    color: "var(--text-1)",
    fontFamily: "var(--font-mono)",
    ...(width ? { width } : {}),
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultFromDate(): string {
  // 30 days ago — sane default for operator-driven downloads.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}
