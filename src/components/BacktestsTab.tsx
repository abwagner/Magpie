// ── Backtests Tab ─────────────────────────────────────────────────
// Surfaces quant-optimizer wfo_results JSONs (kind: "qo-run" in
// /api/catalog) as a sortable list of runs. Click a row to drill
// down into per-fold best params, OOS metric panel, and the
// IS-vs-OOS walk-forward chart via /api/qo-run/:id. Up to 3 runs can
// be selected for side-by-side comparison. JSON is canonical; no
// Optuna SQLite reads.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api.js";
import { C, mono, sans } from "../lib/constants.js";
import { dateRange, fmtAge, fmtNum } from "../lib/format.js";
import { Btn, Card, TxtIn } from "./common.js";
import { OOS_METRICS, type OosMetric, WfChart } from "./WfChart.js";
import { RunHeatmap } from "./RunHeatmap.js";

// ── Types (loose; server is source of truth) ───────────────────────

interface DatasetDescriptor {
  id: string;
  kind: string;
  label: string;
  symbols: string[];
  date_min: string | null;
  date_max: string | null;
  granularity: string;
  row_count: number;
  file_count: number;
  size_bytes: number;
  last_updated: string | null;
  source: string;
  index_relation: string;
  type_specific: Record<string, unknown>;
}

interface CatalogResponse {
  generated_at: string;
  descriptors: DatasetDescriptor[];
}

interface OosPanel {
  n_trades?: number;
  net_pnl?: number;
  sortino?: number;
  hit_rate?: number;
  max_dd?: number;
}

interface FoldRow {
  fold_id?: number;
  is_start?: string;
  is_end?: string;
  oos_start?: string;
  oos_end?: string;
  is_metric?: number;
  best_params?: Record<string, unknown>;
  sampler?: string;
  n_trials_completed?: number;
  n_trials_target?: number | null;
  best_at_trial?: number | null;
  oos?: OosPanel;
}

interface WfoResults {
  schema_version?: number;
  strategy?: string;
  lineage_id?: string;
  folds?: FoldRow[];
}

// ── Helpers ────────────────────────────────────────────────────────

function shortLineage(lineage: string | undefined): string | undefined {
  if (!lineage) return undefined;
  return `lineage ${lineage.slice(0, 8)}`;
}

function tsString(d: DatasetDescriptor, key: string): string {
  const v = d.type_specific?.[key];
  return v == null ? "" : String(v);
}

function tsNum(d: DatasetDescriptor, key: string): number | null {
  const v = d.type_specific?.[key];
  if (typeof v === "number") return v;
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function tsWindow(d: DatasetDescriptor, key: string): [string | null, string | null] {
  const v = d.type_specific?.[key];
  if (!Array.isArray(v) || v.length !== 2) return [null, null];
  const a = v[0] == null ? null : String(v[0]);
  const b = v[1] == null ? null : String(v[1]);
  return [a, b];
}

function isQoRun(d: DatasetDescriptor): boolean {
  return d.kind === "qo-run";
}

// ── Header ─────────────────────────────────────────────────────────

interface HeaderStripProps {
  runs: DatasetDescriptor[];
  generatedAt: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}

function HeaderStrip({ runs, generatedAt, onRefresh, refreshing }: HeaderStripProps) {
  const strategies = new Set(runs.map((r) => tsString(r, "strategy")).filter(Boolean));
  const totalFolds = runs.reduce<number>((acc, r) => acc + (tsNum(r, "n_folds") ?? 0), 0);
  const stalestIso = runs.reduce<string | null>((acc, d) => {
    if (!d.last_updated) return acc;
    return !acc || d.last_updated < acc ? d.last_updated : acc;
  }, null);

  const cell = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: 0.8 }}>
        {label}
      </span>
      <span style={{ fontFamily: mono, fontSize: 13, color: C.text, fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );

  return (
    <Card>
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        {cell("Runs", runs.length)}
        {cell("Strategies", strategies.size)}
        {cell("Total folds", fmtNum(totalFolds))}
        {cell("Stalest", fmtAge(stalestIso))}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: C.dim, fontFamily: mono }}>
            generated {generatedAt ? fmtAge(generatedAt) + " ago" : "—"}
          </span>
          <Btn onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

// ── Run list ───────────────────────────────────────────────────────

interface RunRowProps {
  run: DatasetDescriptor;
  selected: boolean;
  onSelect: () => void;
  compareChecked: boolean;
  compareDisabled: boolean;
  onCompareToggle: () => void;
}

function RunRow({
  run,
  selected,
  onSelect,
  compareChecked,
  compareDisabled,
  onCompareToggle,
}: RunRowProps) {
  const strategy = tsString(run, "strategy");
  const [isStart, isEnd] = tsWindow(run, "is_window");
  const [oosStart, oosEnd] = tsWindow(run, "oos_window");
  const nFolds = tsNum(run, "n_folds");
  const nTrials = tsNum(run, "n_trials_per_fold");
  const bestOos = tsNum(run, "best_oos_metric");
  const lineage = tsString(run, "lineage_id");
  return (
    <tr
      onClick={onSelect}
      style={{
        borderTop: `1px solid ${C.border}`,
        cursor: "pointer",
        background: selected ? C.surfAlt : "transparent",
      }}
    >
      <td style={{ padding: "5px 8px", width: 28 }} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Compare ${strategy || run.label}`}
          checked={compareChecked}
          disabled={!compareChecked && compareDisabled}
          onChange={onCompareToggle}
        />
      </td>
      <td style={{ padding: "5px 8px", color: C.accent, fontWeight: 600 }}>
        {strategy || run.label}
      </td>
      <td style={{ padding: "5px 8px", fontSize: 10 }}>{dateRange(isStart, isEnd)}</td>
      <td style={{ padding: "5px 8px", fontSize: 10 }}>{dateRange(oosStart, oosEnd)}</td>
      <td style={{ padding: "5px 8px", textAlign: "right" }}>{nFolds ?? "—"}</td>
      <td style={{ padding: "5px 8px", textAlign: "right" }}>{nTrials ?? "—"}</td>
      <td style={{ padding: "5px 8px", textAlign: "right", fontFamily: mono }}>
        {bestOos == null ? "—" : bestOos.toFixed(0)}
      </td>
      <td
        style={{ padding: "5px 8px", fontSize: 9, color: C.dim, fontFamily: mono }}
        title={lineage}
      >
        {lineage ? lineage.slice(0, 8) : "—"}
      </td>
      <td style={{ padding: "5px 8px", textAlign: "right", color: C.dim, fontSize: 10 }}>
        {fmtAge(run.last_updated)}
      </td>
    </tr>
  );
}

interface RunListProps {
  runs: DatasetDescriptor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  compareIds: Set<string>;
  onCompareToggle: (id: string) => void;
  compareLimit: number;
}

function RunList({
  runs,
  selectedId,
  onSelect,
  compareIds,
  onCompareToggle,
  compareLimit,
}: RunListProps) {
  const atLimit = compareIds.size >= compareLimit;
  return (
    <Card title={<span>Runs</span>}>
      <div style={{ maxHeight: 360, overflow: "auto" }}>
        <table
          style={{ width: "100%", fontSize: 11, fontFamily: mono, borderCollapse: "collapse" }}
        >
          <thead>
            <tr
              style={{
                color: C.dim,
                fontSize: 9,
                textTransform: "uppercase",
                position: "sticky",
                top: 0,
                background: C.surface,
              }}
            >
              <th style={{ padding: "4px 8px", width: 28 }} />
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Strategy</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>IS window</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>OOS window</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>Folds</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>Trials/fold</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>Best OOS</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>Lineage</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                selected={selectedId === r.id}
                onSelect={() => onSelect(r.id)}
                compareChecked={compareIds.has(r.id)}
                compareDisabled={atLimit}
                onCompareToggle={() => onCompareToggle(r.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Comparison panel ──────────────────────────────────────────────

interface ComparisonPanelProps {
  runs: DatasetDescriptor[];
  metric: OosMetric;
  onMetricChange: (m: OosMetric) => void;
  onClear: () => void;
}

interface FetchedRun {
  id: string;
  label: string;
  folds: WfoResults["folds"];
  error: string | null;
}

function ComparisonPanel({ runs, metric, onMetricChange, onClear }: ComparisonPanelProps) {
  const [fetched, setFetched] = useState<FetchedRun[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all(
      runs.map(async (r): Promise<FetchedRun> => {
        const label = tsString(r, "strategy") || r.label;
        try {
          const data = (await api.getQoRun(r.id)) as WfoResults;
          return { id: r.id, label, folds: data.folds ?? [], error: null };
        } catch (e) {
          return {
            id: r.id,
            label,
            folds: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    ).then((res) => {
      if (mounted) {
        setFetched(res);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [runs]);

  return (
    <Card
      title={<span>Comparison ({runs.length})</span>}
      actions={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {OOS_METRICS.map((m) => (
            <button
              key={m}
              onClick={() => onMetricChange(m)}
              style={{
                padding: "2px 8px",
                background: metric === m ? C.aGlow : "transparent",
                border: `1px solid ${metric === m ? C.accent : C.border}`,
                color: metric === m ? C.accent : C.dim,
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: mono,
                fontSize: 10,
              }}
            >
              {m}
            </button>
          ))}
          <Btn onClick={onClear}>Clear</Btn>
        </div>
      }
    >
      {loading && (
        <div style={{ color: C.dim, fontFamily: mono, fontSize: 11, padding: 8 }}>Loading…</div>
      )}
      {!loading && (
        <>
          <div style={{ marginBottom: 12 }}>
            <RunHeatmap
              rows={fetched
                .filter((f) => !f.error)
                .map((f) => ({ label: f.label, folds: f.folds ?? [] }))}
              metric={metric}
            />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${Math.min(runs.length, 3)}, 1fr)`,
              gap: 12,
            }}
          >
            {fetched.map((f) => (
              <div key={f.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {f.error ? (
                  <div
                    style={{
                      color: C.red,
                      fontFamily: mono,
                      fontSize: 10,
                      padding: 8,
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                    }}
                  >
                    {f.label}: {f.error}
                  </div>
                ) : (
                  <WfChart
                    folds={f.folds ?? []}
                    metric={metric}
                    title={f.label}
                    width={420}
                    height={180}
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Per-run drill-down ─────────────────────────────────────────────

interface RunDetailProps {
  runId: string;
  strategy: string;
  metric: OosMetric;
  onMetricChange: (m: OosMetric) => void;
}

function RunDetail({ runId, strategy, metric, onMetricChange }: RunDetailProps) {
  const [data, setData] = useState<WfoResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    api
      .getQoRun(runId)
      .then((d) => {
        if (mounted) setData(d as WfoResults);
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [runId]);

  if (loading) {
    return (
      <Card title={<span>Detail</span>}>
        <div style={{ padding: 12, color: C.dim, fontSize: 11 }}>Loading {strategy}…</div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card title={<span>Detail</span>}>
        <div style={{ padding: 12, color: C.red, fontFamily: mono, fontSize: 11 }}>{error}</div>
      </Card>
    );
  }
  if (!data || !data.folds || data.folds.length === 0) {
    return (
      <Card title={<span>Detail</span>}>
        <div style={{ padding: 12, color: C.dim, fontSize: 11 }}>No folds in this run.</div>
      </Card>
    );
  }

  const folds = [...data.folds].sort((a, b) => (a.fold_id ?? 0) - (b.fold_id ?? 0));
  return (
    <Card
      title={
        <span>
          {data.strategy ?? strategy}
          {data.lineage_id ? (
            <span
              style={{ marginLeft: 8, color: C.dim, fontFamily: mono, fontSize: 10 }}
              title={data.lineage_id}
            >
              lineage {data.lineage_id.slice(0, 8)}
            </span>
          ) : null}
        </span>
      }
      actions={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: C.dim, fontFamily: mono, marginRight: 4 }}>
            OOS metric
          </span>
          {OOS_METRICS.map((m) => (
            <button
              key={m}
              onClick={() => onMetricChange(m)}
              style={{
                padding: "2px 8px",
                background: metric === m ? C.aGlow : "transparent",
                border: `1px solid ${metric === m ? C.accent : C.border}`,
                color: metric === m ? C.accent : C.dim,
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: mono,
                fontSize: 10,
              }}
            >
              {m}
            </button>
          ))}
        </div>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <WfChart folds={folds} metric={metric} width={720} height={220} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <RunHeatmap
          rows={[
            { label: data.strategy ?? strategy, sublabel: shortLineage(data.lineage_id), folds },
          ]}
          metric={metric}
        />
      </div>
      <div style={{ overflow: "auto" }}>
        <table
          style={{ width: "100%", fontSize: 11, fontFamily: mono, borderCollapse: "collapse" }}
        >
          <thead>
            <tr style={{ color: C.dim, fontSize: 9, textTransform: "uppercase" }}>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>Fold</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>IS</th>
              <th style={{ textAlign: "left", padding: "4px 8px" }}>OOS</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>IS metric</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>n trades</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>net pnl</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>sortino</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>hit rate</th>
              <th style={{ textAlign: "right", padding: "4px 8px" }}>max dd</th>
            </tr>
          </thead>
          <tbody>
            {folds.map((f) => {
              const oos = f.oos ?? {};
              return (
                <tr key={f.fold_id ?? Math.random()} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: C.text }}>
                    {f.fold_id}
                  </td>
                  <td style={{ padding: "4px 8px", fontSize: 10 }}>
                    {dateRange(f.is_start ?? null, f.is_end ?? null)}
                  </td>
                  <td style={{ padding: "4px 8px", fontSize: 10 }}>
                    {dateRange(f.oos_start ?? null, f.oos_end ?? null)}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {f.is_metric == null ? "—" : f.is_metric.toFixed(2)}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>{oos.n_trades ?? "—"}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {oos.net_pnl == null ? "—" : oos.net_pnl.toFixed(0)}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {oos.sortino == null ? "—" : oos.sortino.toFixed(2)}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {oos.hit_rate == null ? "—" : `${(oos.hit_rate * 100).toFixed(0)}%`}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {oos.max_dd == null ? "—" : oos.max_dd.toFixed(0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary
          style={{
            fontSize: 9,
            color: C.dim,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            cursor: "pointer",
          }}
        >
          Per-fold best params
        </summary>
        <pre
          style={{
            margin: "6px 0 0 0",
            padding: 10,
            background: C.bg,
            borderRadius: 4,
            fontFamily: mono,
            fontSize: 10,
            color: C.text,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 280,
            overflow: "auto",
          }}
        >
          {JSON.stringify(
            folds.map((f) => ({ fold_id: f.fold_id, best_params: f.best_params ?? {} })),
            null,
            2,
          )}
        </pre>
      </details>
    </Card>
  );
}

// ── Main tab ───────────────────────────────────────────────────────

type SortKey = "last_updated" | "strategy" | "best_oos";

const COMPARE_LIMIT = 3;

export default function BacktestsTab() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("last_updated");
  const [compareIds, setCompareIds] = useState<Set<string>>(() => new Set());
  const [metric, setMetric] = useState<OosMetric>("net_pnl");
  const [search, setSearch] = useState("");

  function toggleCompare(id: string): void {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < COMPARE_LIMIT) {
        next.add(id);
      }
      return next;
    });
  }

  async function load(refresh = false): Promise<void> {
    try {
      if (refresh) setRefreshing(true);
      const data = (await api.getCatalog({ refresh })) as CatalogResponse;
      setCatalog(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load(false);
  }, []);

  const runs = useMemo<DatasetDescriptor[]>(() => {
    const all = catalog?.descriptors ?? [];
    return all.filter(isQoRun);
  }, [catalog]);

  const sortedRuns = useMemo<DatasetDescriptor[]>(() => {
    const arr = [...runs];
    arr.sort((a, b) => {
      if (sortKey === "strategy") {
        return tsString(a, "strategy").localeCompare(tsString(b, "strategy"));
      }
      if (sortKey === "best_oos") {
        const av = tsNum(a, "best_oos_metric") ?? -Infinity;
        const bv = tsNum(b, "best_oos_metric") ?? -Infinity;
        return bv - av;
      }
      // last_updated desc, nulls last
      const au = a.last_updated ?? "";
      const bu = b.last_updated ?? "";
      if (au === bu) return 0;
      return au < bu ? 1 : -1;
    });
    return arr;
  }, [runs, sortKey]);

  // Client-side search across strategy + lineage_id. Case-insensitive
  // substring match; empty query passes through everything. The list
  // is small (≤100 runs in practice), so client-side filtering is
  // simpler than a server roundtrip — see QF-180 out-of-scope note.
  const filteredRuns = useMemo<DatasetDescriptor[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedRuns;
    return sortedRuns.filter((r) => {
      const strategy = tsString(r, "strategy").toLowerCase();
      const lineage = tsString(r, "lineage_id").toLowerCase();
      return strategy.includes(q) || lineage.includes(q);
    });
  }, [sortedRuns, search]);

  // Auto-select the first run when none picked yet, so the detail panel
  // always has something to show after load finishes. Auto-select runs
  // off the *filtered* list so a typed query that excludes the current
  // selection can still surface something visible.
  useEffect(() => {
    if (filteredRuns.length === 0) return;
    if (selectedId === null || !filteredRuns.find((r) => r.id === selectedId)) {
      setSelectedId(filteredRuns[0]!.id);
    }
  }, [filteredRuns, selectedId]);

  const selected = filteredRuns.find((r) => r.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {loading && (
        <div
          style={{ color: C.dim, padding: 20, textAlign: "center", fontFamily: sans, fontSize: 13 }}
        >
          Loading runs…
        </div>
      )}
      {error && (
        <Card>
          <div style={{ color: C.red, fontFamily: mono, fontSize: 12 }}>Error: {error}</div>
        </Card>
      )}
      {!loading && !error && (
        <>
          <HeaderStrip
            runs={filteredRuns}
            generatedAt={catalog?.generated_at ?? null}
            onRefresh={() => void load(true)}
            refreshing={refreshing}
          />
          {runs.length === 0 ? (
            <Card>
              <div
                style={{
                  color: C.dim,
                  padding: 20,
                  textAlign: "center",
                  fontFamily: sans,
                  fontSize: 12,
                }}
              >
                No quant-optimizer runs found in <code>data/results/qo/</code>. Drop a{" "}
                <code>wfo_results_*.json</code> there and refresh, or kick off a sweep with{" "}
                <code>python -m oil_paper.adapters.cl_scalp</code>.
              </div>
            </Card>
          ) : (
            <>
              <Card>
                <TxtIn
                  value={search}
                  onChange={setSearch}
                  label="Search"
                  placeholder="strategy name or lineage_id"
                  style={{ width: 320 }}
                />
              </Card>
            </>
          )}
          {runs.length > 0 && filteredRuns.length === 0 ? (
            <Card>
              <div
                style={{
                  color: C.dim,
                  padding: 20,
                  textAlign: "center",
                  fontFamily: sans,
                  fontSize: 12,
                }}
              >
                No runs match <code>{search}</code>. Clear the search to see all {runs.length} runs.
              </div>
            </Card>
          ) : runs.length === 0 ? null : (
            <>
              <Card>
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    alignItems: "center",
                    fontFamily: mono,
                    fontSize: 10,
                  }}
                >
                  <span style={{ color: C.dim, marginRight: 4 }}>Sort</span>
                  {(["last_updated", "strategy", "best_oos"] as SortKey[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => setSortKey(k)}
                      style={{
                        padding: "2px 8px",
                        background: sortKey === k ? C.aGlow : "transparent",
                        border: `1px solid ${sortKey === k ? C.accent : C.border}`,
                        color: sortKey === k ? C.accent : C.dim,
                        borderRadius: 3,
                        cursor: "pointer",
                        fontFamily: mono,
                        fontSize: 10,
                      }}
                    >
                      {k.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </Card>
              <RunList
                runs={filteredRuns}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
                compareIds={compareIds}
                onCompareToggle={toggleCompare}
                compareLimit={COMPARE_LIMIT}
              />
              {compareIds.size >= 2 && (
                <ComparisonPanel
                  runs={filteredRuns.filter((r) => compareIds.has(r.id))}
                  metric={metric}
                  onMetricChange={setMetric}
                  onClear={() => setCompareIds(new Set())}
                />
              )}
              {selected && (
                <RunDetail
                  runId={selected.id}
                  strategy={tsString(selected, "strategy")}
                  metric={metric}
                  onMetricChange={setMetric}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
