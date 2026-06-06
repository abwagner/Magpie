// ── Data Catalog Tab ──────────────────────────────────────────────
// Cross-kind dataset inventory + recent download history. Wraps the
// existing /api/catalog descriptors with kind-grouped sections, and
// mounts DownloadHistoryPanel above them so the user can answer both
// "what data exists?" and "when was it last refreshed?".

import { useState, useEffect, useMemo, type ReactNode } from "react";
import { C, mono, sans } from "../lib/constants.js";
import { fmtNum, fmtBytes, fmtAge, dateRange } from "../lib/format.js";
import { api } from "../lib/api.js";
import { Card, Btn, Pill, TxtIn } from "./common.js";
import { DownloadHistoryPanel } from "./DownloadHistoryPanel.js";

// ── Display metadata for kinds / relations ─────────────────────────

type Kind = "chains" | "signals" | "etf" | "futures" | "macro" | "fills" | "backtest";

const KIND_ORDER: Kind[] = ["chains", "signals", "etf", "futures", "macro", "fills", "backtest"];

const KIND_META: Record<Kind, { label: string; color: string }> = {
  chains: { label: "Option Chains", color: C.accent },
  signals: { label: "Model Signals", color: C.purple },
  etf: { label: "ETFs", color: C.cyan },
  futures: { label: "Futures", color: C.amber },
  macro: { label: "Macro Series", color: C.green },
  fills: { label: "Fill Logs", color: C.red },
  backtest: { label: "Backtests", color: C.dim },
};

const RELATION_META: Record<string, { label: string; color: string }> = {
  "spx-index": { label: "SPX idx", color: C.accent },
  "spx-component": { label: "SPX comp", color: C.cyan },
  "ndx-extra": { label: "NDX", color: C.purple },
  "sector-etf": { label: "Sector", color: C.green },
  "vix-derived": { label: "VIX", color: C.red },
  commodity: { label: "Cmdty", color: C.amber },
  rates: { label: "Rates", color: C.green },
  credit: { label: "Credit", color: C.red },
  fx: { label: "FX", color: C.cyan },
  unrelated: { label: "—", color: C.dim },
};

const GRANULARITY_ORDER = [
  "event",
  "intraday-1s",
  "intraday-1m",
  "intraday-5m",
  "intraday-1h",
  "daily",
  "weekly",
  "monthly",
  "snapshot",
];

// ── Descriptor shape (keep loose: server is source of truth) ──────

interface DatasetDescriptor {
  id: string;
  kind: Kind;
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

interface ChainDetailRow {
  date: string;
  underlying_price: number;
  contracts: number;
  unique_strikes: number;
  expirations: number;
  strike_min: number;
  strike_max: number;
  strike_width_pct: number;
}

interface FilterState {
  kinds: Kind[];
  relations: string[];
  granularities: string[];
}

function unionRange(descriptors: DatasetDescriptor[]): { min: string | null; max: string | null } {
  let min: string | null = null;
  let max: string | null = null;
  for (const d of descriptors) {
    if (d.date_min && (!min || d.date_min < min)) min = d.date_min;
    if (d.date_max && (!max || d.date_max > max)) max = d.date_max;
  }
  return { min, max };
}

// ── Badges ─────────────────────────────────────────────────────────

interface ChipProps {
  children: ReactNode;
  color?: string;
  title?: string;
}

function Chip({ children, color = C.dim, title }: ChipProps) {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 3,
        background: `${color}22`,
        border: `1px solid ${color}55`,
        color,
        fontFamily: mono,
        fontSize: 9,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function RelationBadge({ relation }: { relation: string }) {
  const meta = RELATION_META[relation] ?? RELATION_META["unrelated"]!;
  return (
    <Chip color={meta.color} title={relation}>
      {meta.label}
    </Chip>
  );
}

// Kind-specific "headline" badge rendered in each row.
function KindBadge({ descriptor }: { descriptor: DatasetDescriptor }) {
  const ts = descriptor.type_specific ?? {};
  const num = (k: string): number | null => {
    const v = ts[k];
    return typeof v === "number" ? v : v == null ? null : Number(v);
  };
  const str = (k: string): string => String(ts[k] ?? "");
  switch (descriptor.kind) {
    case "chains":
      return (
        <Chip color={C.accent} title="strikes × expirations (most recent snapshot)">
          {num("strike_count") ?? 0}×{num("expiration_count") ?? 0}
          {num("strike_width_pct") ? ` · ±${num("strike_width_pct")}%` : ""}
        </Chip>
      );
    case "signals":
      return (
        <Chip color={C.purple} title="confidence p50 · p90">
          p50 {num("confidence_p50") == null ? "—" : Number(num("confidence_p50")).toFixed(2)}
        </Chip>
      );
    case "macro":
      return (
        <Chip color={C.green} title="median gap days between observations">
          ~{num("median_gap_days")}d
        </Chip>
      );
    case "futures":
      return <Chip color={C.amber}>{str("schema")}</Chip>;
    case "etf":
      return <Chip color={C.cyan}>daily</Chip>;
    case "fills":
      return (
        <Chip color={C.red}>
          {num("fill_count")} fills · {num("distinct_underliers")}u
        </Chip>
      );
    case "backtest":
      return (
        <Chip color={C.dim}>
          {num("total_pnl") != null ? `P&L ${Number(num("total_pnl")).toFixed(0)}` : "—"}
          {num("win_rate") ? ` · ${num("win_rate")}` : ""}
        </Chip>
      );
    default:
      return <Chip>{descriptor.granularity}</Chip>;
  }
}

// ── Row expander — kind-specific detail ────────────────────────────

function ChainsExpander({ symbol }: { symbol: string }) {
  const [detail, setDetail] = useState<ChainDetailRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    api
      .getDataDetail(symbol)
      .then((d) => {
        if (mounted) setDetail(d);
      })
      .catch(() => {
        if (mounted) setDetail([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [symbol]);
  if (loading) return <div style={{ color: C.dim, padding: 8, fontSize: 11 }}>Loading...</div>;
  if (detail.length === 0)
    return <div style={{ color: C.dim, padding: 8, fontSize: 11 }}>No detail</div>;
  const last10 = detail.slice(-10).reverse();
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
        Latest {last10.length} snapshots (of {detail.length})
      </div>
      <table style={{ width: "100%", fontSize: 10, fontFamily: mono, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: C.dim, fontSize: 9, textTransform: "uppercase" }}>
            <th style={{ textAlign: "left", padding: "2px 4px" }}>Date</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Spot</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Strikes</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Exps</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Range</th>
            <th style={{ textAlign: "right", padding: "2px 4px" }}>Width %</th>
          </tr>
        </thead>
        <tbody>
          {last10.map((d) => (
            <tr key={d.date} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: "2px 4px", color: C.text }}>{d.date}</td>
              <td style={{ padding: "2px 4px", textAlign: "right" }}>
                ${d.underlying_price.toFixed(2)}
              </td>
              <td style={{ padding: "2px 4px", textAlign: "right" }}>{d.unique_strikes}</td>
              <td style={{ padding: "2px 4px", textAlign: "right" }}>{d.expirations}</td>
              <td style={{ padding: "2px 4px", textAlign: "right", fontSize: 9 }}>
                {d.strike_min}–{d.strike_max}
              </td>
              <td
                style={{
                  padding: "2px 4px",
                  textAlign: "right",
                  color:
                    d.strike_width_pct > 30 ? C.green : d.strike_width_pct > 15 ? C.amber : C.red,
                }}
              >
                {d.strike_width_pct}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GenericExpander({ descriptor }: { descriptor: DatasetDescriptor }) {
  return (
    <div
      style={{
        padding: "6px 10px",
        background: C.bg,
        borderRadius: 4,
        fontFamily: mono,
        fontSize: 10,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: C.dim,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        Type-specific metadata
      </div>
      <pre style={{ margin: 0, color: C.text, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {JSON.stringify(descriptor.type_specific, null, 2)}
      </pre>
    </div>
  );
}

function RowExpander({ descriptor }: { descriptor: DatasetDescriptor }) {
  if (descriptor.kind === "chains") {
    return <ChainsExpander symbol={descriptor.symbols[0] ?? ""} />;
  }
  return <GenericExpander descriptor={descriptor} />;
}

// ── Row / section / filter bar ─────────────────────────────────────

interface DatasetRowProps {
  descriptor: DatasetDescriptor;
  expanded: boolean;
  onToggle: () => void;
}

function DatasetRow({ descriptor, expanded, onToggle }: DatasetRowProps) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderTop: `1px solid ${C.border}`,
          cursor: "pointer",
          background: expanded ? C.surfAlt : "transparent",
        }}
      >
        <td style={{ padding: "5px 8px", color: C.accent, fontWeight: 600 }}>
          {descriptor.symbols.length > 0 ? descriptor.symbols.join(", ") : descriptor.label}
        </td>
        <td style={{ padding: "5px 8px", fontSize: 10 }}>
          {dateRange(descriptor.date_min, descriptor.date_max)}
        </td>
        <td style={{ padding: "5px 8px" }}>
          <Chip color={C.dim}>{descriptor.granularity}</Chip>
        </td>
        <td style={{ padding: "5px 8px", textAlign: "right" }}>{fmtNum(descriptor.row_count)}</td>
        <td style={{ padding: "5px 8px", textAlign: "right" }}>
          {fmtBytes(descriptor.size_bytes)}
        </td>
        <td style={{ padding: "5px 8px" }}>
          <RelationBadge relation={descriptor.index_relation} />
        </td>
        <td style={{ padding: "5px 8px" }}>
          <KindBadge descriptor={descriptor} />
        </td>
        <td style={{ padding: "5px 8px", textAlign: "right", color: C.dim, fontSize: 10 }}>
          {fmtAge(descriptor.last_updated)}
        </td>
        <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 10, color: C.dim }}>
          {expanded ? "▲" : "▼"}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9} style={{ padding: "4px 12px 10px 12px" }}>
            <RowExpander descriptor={descriptor} />
          </td>
        </tr>
      )}
    </>
  );
}

interface KindSectionProps {
  kind: Kind;
  descriptors: DatasetDescriptor[];
  expandedId: string | null;
  onToggleRow: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function KindSection({
  kind,
  descriptors,
  expandedId,
  onToggleRow,
  collapsed,
  onToggleCollapse,
}: KindSectionProps) {
  const meta = KIND_META[kind] ?? { label: kind, color: C.accent };
  const range = unionRange(descriptors);
  const totalSize = descriptors.reduce((s, d) => s + (d.size_bytes ?? 0), 0);
  const totalRows = descriptors.reduce((s, d) => s + (d.row_count ?? 0), 0);
  return (
    <Card
      title={<span style={{ color: meta.color }}>{meta.label}</span>}
      actions={
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            fontSize: 10,
            color: C.dim,
            fontFamily: mono,
          }}
        >
          <span>{descriptors.length} datasets</span>
          <span>{dateRange(range.min, range.max)}</span>
          <span>{fmtNum(totalRows)} rows</span>
          <span>{fmtBytes(totalSize)}</span>
          <Btn onClick={onToggleCollapse} color={meta.color}>
            {collapsed ? "Show" : "Hide"}
          </Btn>
        </div>
      }
    >
      {!collapsed && (
        <div style={{ maxHeight: 500, overflow: "auto" }}>
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
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Symbols</th>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Date Range</th>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Granularity</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>Rows</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>Size</th>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Relation</th>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>Detail</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {descriptors.map((d) => (
                <DatasetRow
                  key={d.id}
                  descriptor={d}
                  expanded={expandedId === d.id}
                  onToggle={() => onToggleRow(d.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

interface FilterBarProps {
  kinds: Kind[];
  relations: string[];
  granularities: string[];
  filters: FilterState;
  setFilters: (f: FilterState) => void;
  search: string;
  setSearch: (s: string) => void;
}

function FilterBar({
  kinds,
  relations,
  granularities,
  filters,
  setFilters,
  search,
  setSearch,
}: FilterBarProps) {
  function toggle<K extends keyof FilterState>(key: K, value: FilterState[K][number]): void {
    const arr = filters[key] as readonly string[];
    const has = arr.includes(value as string);
    const next = (
      has ? arr.filter((v) => v !== (value as string)) : [...arr, value as string]
    ) as FilterState[K];
    setFilters({ ...filters, [key]: next });
  }

  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <TxtIn
            value={search}
            onChange={setSearch}
            label="Search"
            placeholder="symbol / label"
            style={{ width: 200 }}
          />
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 9,
              color: C.dim,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginRight: 4,
            }}
          >
            Kind
          </span>
          {kinds.map((k) => (
            <Pill
              key={k}
              small
              active={filters.kinds.length === 0 || filters.kinds.includes(k)}
              color={KIND_META[k]?.color}
              onClick={() => toggle("kinds", k)}
            >
              {KIND_META[k]?.label ?? k}
            </Pill>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 9,
              color: C.dim,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginRight: 4,
            }}
          >
            Relation
          </span>
          {relations.map((r) => (
            <Pill
              key={r}
              small
              active={filters.relations.length === 0 || filters.relations.includes(r)}
              color={RELATION_META[r]?.color}
              onClick={() => toggle("relations", r)}
            >
              {RELATION_META[r]?.label ?? r}
            </Pill>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 9,
              color: C.dim,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginRight: 4,
            }}
          >
            Granularity
          </span>
          {granularities.map((g) => (
            <Pill
              key={g}
              small
              active={filters.granularities.length === 0 || filters.granularities.includes(g)}
              onClick={() => toggle("granularities", g)}
            >
              {g}
            </Pill>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Header ─────────────────────────────────────────────────────────

interface HeaderStripProps {
  descriptors: DatasetDescriptor[];
  generatedAt: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}

function HeaderStrip({ descriptors, generatedAt, onRefresh, refreshing }: HeaderStripProps) {
  const range = unionRange(descriptors);
  const totalRows = descriptors.reduce((s, d) => s + (d.row_count ?? 0), 0);
  const totalSize = descriptors.reduce((s, d) => s + (d.size_bytes ?? 0), 0);
  const kinds = new Set(descriptors.map((d) => d.kind));
  const stalestIso = descriptors.reduce<string | null>((acc, d) => {
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
        {cell("Datasets", descriptors.length)}
        {cell("Kinds", `${kinds.size}/${KIND_ORDER.length}`)}
        {cell("Date Range", dateRange(range.min, range.max))}
        {cell("Total Rows", fmtNum(totalRows))}
        {cell("Total Size", fmtBytes(totalSize))}
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

// ── Main tab ───────────────────────────────────────────────────────

export default function DataCatalogTab() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<FilterState>({
    kinds: [],
    relations: [],
    granularities: [],
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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

  const descriptors = catalog?.descriptors ?? [];

  const facets = useMemo(() => {
    const kinds = new Set(descriptors.map((d) => d.kind));
    const relations = new Set(descriptors.map((d) => d.index_relation));
    const granularities = new Set(descriptors.map((d) => d.granularity));
    return {
      kinds: KIND_ORDER.filter((k) => kinds.has(k)),
      relations: Object.keys(RELATION_META).filter((r) => relations.has(r)),
      granularities: GRANULARITY_ORDER.filter((g) => granularities.has(g)),
    };
  }, [descriptors]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return descriptors.filter((d) => {
      if (filters.kinds.length > 0 && !filters.kinds.includes(d.kind)) return false;
      if (filters.relations.length > 0 && !filters.relations.includes(d.index_relation))
        return false;
      if (filters.granularities.length > 0 && !filters.granularities.includes(d.granularity))
        return false;
      if (q) {
        const hay = [d.id, d.label, ...(d.symbols ?? [])].join(" ").toUpperCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [descriptors, filters, search]);

  const grouped = useMemo(() => {
    const map = new Map<Kind, DatasetDescriptor[]>();
    for (const d of filtered) {
      if (!map.has(d.kind)) map.set(d.kind, []);
      map.get(d.kind)!.push(d);
    }
    return map;
  }, [filtered]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DownloadHistoryPanel />
      {loading && (
        <div
          style={{ color: C.dim, padding: 20, textAlign: "center", fontFamily: sans, fontSize: 13 }}
        >
          Loading data catalog... (first load can take up to 2 minutes as we scan 500+ datasets)
        </div>
      )}
      {error && (
        <Card>
          <div style={{ color: C.red, fontFamily: mono, fontSize: 12 }}>Error: {error}</div>
        </Card>
      )}
      {!loading && !error && catalog && (
        <>
          <HeaderStrip
            descriptors={filtered}
            generatedAt={catalog.generated_at}
            onRefresh={() => void load(true)}
            refreshing={refreshing}
          />
          <FilterBar
            kinds={facets.kinds}
            relations={facets.relations}
            granularities={facets.granularities}
            filters={filters}
            setFilters={setFilters}
            search={search}
            setSearch={setSearch}
          />
          {KIND_ORDER.filter((kind) => grouped.has(kind)).map((kind) => (
            <KindSection
              key={kind}
              kind={kind}
              descriptors={grouped.get(kind)!}
              expandedId={expandedId}
              onToggleRow={(id) => setExpandedId(expandedId === id ? null : id)}
              collapsed={!!collapsed[kind]}
              onToggleCollapse={() => setCollapsed({ ...collapsed, [kind]: !collapsed[kind] })}
            />
          ))}
          {filtered.length === 0 && (
            <Card>
              <div style={{ color: C.dim, padding: 20, textAlign: "center", fontSize: 12 }}>
                No datasets match your filters.
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
