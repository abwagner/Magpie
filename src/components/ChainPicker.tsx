import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { C, mono, sans, formatAge, pickDefault6mo } from "../lib/constants.js";
import { api } from "../lib/api.js";
import { log, useLog } from "../lib/log.js";
import { Pill, Card, Btn } from "./common.js";
import BulkLoadModal from "./BulkLoadModal.js";
import CurveChart from "./CurveChart.js";
import { generatePayoffCurve, findBreakevens } from "../lib/payoff.js";
import { GREEK_BUILDER_PRESETS } from "../lib/lp-optimizer.js";
import type { Contract } from "../types/market-data.js";

// ── Types ─────────────────────────────────────────────────────────

export interface ChainPickerProps {
  spotPrice?: number;
  onAddPosition?: (leg: unknown) => void;
  onSpotUpdate?: (spot: number) => void;
  accountHash?: string;
}

type GreekTarget = "min" | "max" | "flat" | "bound" | "any";
type GreekKey = "delta" | "gamma" | "theta" | "vega";

interface GreekModes {
  delta: GreekTarget;
  gamma: GreekTarget;
  theta: GreekTarget;
  vega: GreekTarget;
}

interface GreekBounds {
  deltaMin: string;
  deltaMax: string;
  gammaMin: string;
  gammaMax: string;
  thetaMin: string;
  thetaMax: string;
  vegaMin: string;
  vegaMax: string;
}

// Chain rows from api.chain conform to Contract from
// src/types/market-data.ts. Aliased here so a future widening (e.g.
// nullable greeks from the futures vendor path) only touches one
// place.
type ChainRow = Contract;

interface FuturesMonthRow {
  symbol: string;
  code?: string;
  month?: string;
  last: number;
  bid?: number;
  ask?: number;
}

interface PositionRow {
  underlying: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  unrealizedPnl: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

interface PositionsResponse {
  options: PositionRow[];
  equities: unknown[];
}

interface BulkProgress {
  done: number;
  total: number;
  current: string;
}

interface SavedSymbolState {
  symbol: string;
  spot?: number;
  exps?: string[];
  selExp?: string;
  ts?: number;
}

interface StagedTrade {
  id: number;
  side: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  premium: number;
  iv: number;
  quantity: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

interface BuilderWorkerPosition {
  side: "call" | "put";
  strike: number;
  premium: number;
  iv: number;
  qty: number;
  direction: "long" | "short";
  rawDelta: number;
  rawGamma: number;
  rawTheta: number;
  rawVega: number;
}

interface BuilderWorkerTotals {
  contracts: number;
  margin: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  cost?: number;
  perLegMargin?: number;
}

interface BuilderWorkerResult {
  feasible: boolean;
  reason?: string;
  positions: BuilderWorkerPosition[];
  totals: BuilderWorkerTotals;
  strategyLabel?: string;
  solveMs?: number;
}

interface BuilderPresetEntry {
  label: string;
  modes: GreekModes;
  bounds: Partial<Record<keyof GreekBounds, number | null>>;
}

interface PnlPoint {
  price: number;
  current: number;
  staged: number;
  combined: number;
}

interface PnlLine {
  key: string;
  label: string;
  color: string;
}

interface LogEntry {
  ts: number;
  level: string;
  msg: string;
}

// ── Helpers ────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined, d = 2): string => (v != null ? v.toFixed(d) : "—");
const fmtPct = (v: number | null | undefined): string =>
  v != null ? (v * 100).toFixed(1) + "%" : "—";
const fmtGreek = (v: number | null | undefined): string => (v != null ? v.toFixed(3) : "—");
const fmtDollarGreek = (v: number | null | undefined): string =>
  v != null ? "$" + (v * 100).toFixed(0) : "—";
const isFuturesSym = (s: string): boolean => s.startsWith("/");
const fmtDollars = (v: number): string => "$" + v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ── MarginDiscrepancyPanel ─────────────────────────────────────────
// Surfaces the §3.5.2 two-pass portfolio-margin reconciliation result.
// Shows per-leg (conservative) vs portfolio (spread-netted) margin side
// by side, with the freed capital highlighted when spread netting helped.

export interface MarginDiscrepancyPanelProps {
  totals: BuilderWorkerTotals;
}

export function MarginDiscrepancyPanel({ totals }: MarginDiscrepancyPanelProps) {
  const portfolioMargin = totals.margin;
  const perLegMargin = totals.perLegMargin ?? portfolioMargin;
  const freed = perLegMargin - portfolioMargin;
  const hasDiscrepancy = freed > 100;

  return (
    <div
      style={{
        marginTop: 8,
        padding: "6px 10px",
        background: C.bg,
        border: `1px solid ${hasDiscrepancy ? C.accent : C.border}`,
        borderRadius: 5,
        fontSize: 10,
        fontFamily: mono,
        display: "flex",
        gap: 16,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <span style={{ color: C.dim, textTransform: "uppercase", fontSize: 8, letterSpacing: 0.8 }}>
        Margin
      </span>
      <span>
        <span style={{ color: C.dim }}>Per-leg: </span>
        <span>{fmtDollars(perLegMargin)}</span>
      </span>
      <span style={{ color: C.dim }}>→</span>
      <span>
        <span style={{ color: C.dim }}>Portfolio: </span>
        <span style={{ color: hasDiscrepancy ? C.accent : C.text }}>
          {fmtDollars(portfolioMargin)}
        </span>
      </span>
      {hasDiscrepancy && (
        <span style={{ color: C.green, fontWeight: 600 }}>
          freed {fmtDollars(freed)} via spread netting
        </span>
      )}
      {!hasDiscrepancy && <span style={{ color: C.dim }}>no spread netting benefit</span>}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────

export default function ChainPicker({
  spotPrice: parentSpot = 100,
  onSpotUpdate,
  accountHash,
}: ChainPickerProps) {
  // ── Chain state (existing) ────────────────────────────────────
  const [symbol, setSymbol] = useState<string>("");
  const [exps, setExps] = useState<string[]>([]);
  const [selExp, setSelExp] = useState<string>("");
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [loading, setLoading] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [strikeLimit, setStrikeLimit] = useState<number>(20);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [expCacheTs, setExpCacheTs] = useState<Record<string, number>>({});
  const [showBulk, setShowBulk] = useState<boolean>(false);
  const [showLog, setShowLog] = useState<boolean>(false);
  const [spotPrice, setSpotPrice] = useState<number>(parentSpot);
  const logEntries = useLog() as LogEntry[];
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const reqId = useRef(0);

  // ── Positions state ───────────────────────────────────────────
  const [positions, setPositions] = useState<PositionsResponse>({
    options: [],
    equities: [],
  });
  const [posLoading, setPosLoading] = useState<boolean>(false);
  const [selTicker, setSelTicker] = useState<string>("");

  // ── Futures state ──────────────────────────────────────────────
  const [futMonths, setFutMonths] = useState<FuturesMonthRow[]>([]); // [{symbol, code, month, last, bid, ask}]
  const [selMonth, setSelMonth] = useState<string>(""); // e.g. "/CLM26"

  const isFutures = useMemo(() => isFuturesSym(symbol.trim()), [symbol]);
  // The effective symbol for chain/quote: specific month for futures, raw symbol otherwise
  const chainSymbol = useMemo(() => {
    if (!isFutures) return symbol.trim().toUpperCase();
    if (selMonth) return selMonth;
    // If user typed /CLM26 directly, use that
    const upper = symbol.trim().toUpperCase();
    if (/^\/[A-Z]+[FGHJKMNQUVXZ]\d{2}$/.test(upper)) return upper;
    return upper;
  }, [isFutures, selMonth, symbol]);

  // ── Staged trades ─────────────────────────────────────────────
  const [staged, setStaged] = useState<StagedTrade[]>([]);

  // ── P&L chart range ───────────────────────────────────────────
  const [xMin, setXMin] = useState<number | null>(null);
  const [xMax, setXMax] = useState<number | null>(null);
  // yMin/yMax setters preserved (unused) to mirror the original .jsx
  // state surface; future axis-pin UX will read these.
  const [, setYMin] = useState<number | null>(null);
  const [, setYMax] = useState<number | null>(null);
  void setYMin;
  void setYMax;

  // ── Greek builder ─────────────────────────────────────────────
  const [greekModes, setGreekModes] = useState<GreekModes>({
    delta: "flat",
    gamma: "max",
    theta: "flat",
    vega: "flat",
  });
  const [greekBounds, setGreekBounds] = useState<GreekBounds>({
    deltaMin: "",
    deltaMax: "",
    gammaMin: "",
    gammaMax: "",
    thetaMin: "",
    thetaMax: "",
    vegaMin: "",
    vegaMax: "",
  });
  const [builderBudget, setBuilderBudget] = useState<number>(5000);
  const [builderMaxLegs, setBuilderMaxLegs] = useState<number>(6);
  const [builderError, setBuilderError] = useState<string>("");
  const [builderLoading, setBuilderLoading] = useState<boolean>(false);
  const [builderLastResult, setBuilderLastResult] = useState<BuilderWorkerResult | null>(null);
  const builderWorker = useRef<Worker | null>(null);

  // ── Ticking clock + log scroll ────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (showLog && logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [logEntries.length, showLog]);

  // ── Restore last symbol from localStorage ─────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem("last-symbol");
      const saved = raw ? (JSON.parse(raw) as SavedSymbolState | null) : null;
      if (!saved) return;
      setSymbol(saved.symbol);
      if (saved.spot) {
        setSpotPrice(saved.spot);
        onSpotUpdate?.(saved.spot);
      }
      if (saved.exps?.length) {
        setExps(saved.exps);
        setSelExp(saved.selExp || pickDefault6mo(saved.exps));
      }
      if (saved.ts) setLastRefresh(saved.ts);
    } catch {
      // ignore parse errors
    }
  }, []);

  // ── Load positions ────────────────────────────────────────────
  const loadPositions = useCallback(async () => {
    setPosLoading(true);
    try {
      const data = (await api.getPositions(accountHash)) as PositionsResponse;
      setPositions(data);
      if (!selTicker && data.options.length > 0) {
        const tickers = [...new Set(data.options.map((p) => p.underlying))];
        const first = tickers[0];
        setSelTicker(first || "");
        if (!symbol && first) setSymbol(first);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", `Positions fetch failed: ${msg}`);
    } finally {
      setPosLoading(false);
    }
  }, [selTicker, symbol, accountHash]);

  useEffect(() => {
    loadPositions();
  }, [accountHash]);

  // ── Load symbol (quote + expirations) ─────────────────────────
  const loadSymbol = useCallback(async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    const id = ++reqId.current;
    setLoading("quote");
    setError("");

    if (isFuturesSym(sym)) {
      // ── Futures flow: load available months first ─────────────
      log("info", `Fetching futures months for ${sym}`);
      try {
        const months = (await api.futuresMonths(sym)) as FuturesMonthRow[];
        if (id !== reqId.current) return;
        setFutMonths(months);

        // Pick default month: if user typed specific contract (/CLM26), use it;
        // otherwise use first available month (front month)
        let defaultMonth = "";
        if (/^\/[A-Z]+[FGHJKMNQUVXZ]\d{2}$/.test(sym)) {
          defaultMonth = sym;
        } else if (months.length > 0) {
          const head = months[0];
          if (head) defaultMonth = head.symbol;
        }
        setSelMonth(defaultMonth);

        // Quote the selected month
        if (defaultMonth) {
          const quote = await api.stockQuote(defaultMonth);
          if (id !== reqId.current) return;
          if (quote.last) {
            setSpotPrice(quote.last);
            onSpotUpdate?.(quote.last);
          }
        }

        // Load expirations (uses root symbol internally)
        const expList = (await api.expirations(sym)) as string[] | { expirations?: string[] };
        if (id !== reqId.current) return;
        const dates = Array.isArray(expList) ? expList : expList.expirations || [];
        if (dates.length) {
          setExps(dates);
          const defaultExp = pickDefault6mo(dates);
          setSelExp(defaultExp);
          setLastRefresh(Date.now());
        } else {
          setError("No expirations found");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (id === reqId.current) setError(msg);
      }
    } else {
      // ── Equity flow (unchanged) ──────────────────────────────
      log("info", `Fetching ${sym} quote + expirations`);
      setFutMonths([]);
      setSelMonth("");
      try {
        const [quote, expList] = (await Promise.all([
          api.stockQuote(sym),
          api.expirations(sym),
        ])) as [{ last?: number }, string[] | { expirations?: string[] }];
        if (id !== reqId.current) return;
        if (quote.last) {
          setSpotPrice(quote.last);
          onSpotUpdate?.(quote.last);
        }
        const dates = Array.isArray(expList) ? expList : expList.expirations || [];
        if (dates.length) {
          setExps(dates);
          const defaultExp = pickDefault6mo(dates);
          setSelExp(defaultExp);
          const ts = Date.now();
          setLastRefresh(ts);
          try {
            const payload: SavedSymbolState = {
              symbol: sym,
              spot: quote.last,
              exps: dates,
              selExp: defaultExp,
              ts,
            };
            localStorage.setItem("last-symbol", JSON.stringify(payload));
          } catch {
            // ignore quota errors
          }
        } else {
          setError("No expirations found");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (id === reqId.current) setError(msg);
      }
    }
    if (id === reqId.current) setLoading("");
  }, [symbol, onSpotUpdate]);

  // ── Load chain for a given expiration ─────────────────────────
  const loadChain = useCallback(
    async (exp: string) => {
      const sym = chainSymbol;
      if (!exp || !sym) return;
      const id = ++reqId.current;
      setLoading("chain");
      setError("");
      try {
        const opts = (await api.chain(sym, exp, strikeLimit)) as ChainRow[];
        if (id !== reqId.current) return;
        setChain(opts);
        const ts = Date.now();
        setLastRefresh(ts);
        setExpCacheTs((prev) => ({ ...prev, [exp]: ts }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (id === reqId.current) {
          setError(msg);
          setChain([]);
        }
      }
      if (id === reqId.current) setLoading("");
    },
    [chainSymbol, strikeLimit],
  );

  useEffect(() => {
    if (selExp && chainSymbol) loadChain(selExp);
  }, [selExp, chainSymbol, loadChain]);

  // ── Futures month change → re-quote spot + reload chain ────────
  const handleMonthChange = useCallback(
    async (monthSymbol: string) => {
      setSelMonth(monthSymbol);
      if (!monthSymbol) return;
      try {
        const quote = await api.stockQuote(monthSymbol);
        if (quote.last) {
          setSpotPrice(quote.last);
          onSpotUpdate?.(quote.last);
        }
      } catch {
        // ignore quote errors; chain reload still happens via effect
      }
      // Chain will reload via the effect on chainSymbol change
    },
    [onSpotUpdate],
  );

  const refreshAll = useCallback(() => {
    loadPositions();
    loadSymbol().then(() => {
      if (selExp) loadChain(selExp);
    });
  }, [loadPositions, loadSymbol, selExp, loadChain]);

  // ── Bulk load ─────────────────────────────────────────────────
  const expsNext6mo = useMemo(() => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() + 6);
    return exps.filter((d) => new Date(d + "T16:00:00") <= cutoff);
  }, [exps]);

  const bulkLoad = useCallback(
    async (selectedExps: string[], bulkStrikeLimit: number) => {
      const sym = symbol.trim().toUpperCase();
      if (!sym || !selectedExps.length) return;
      setShowBulk(false);
      const today = new Date().toISOString().slice(0, 10);
      const validExps = selectedExps.filter((d) => d >= today);
      log("info", `Bulk load started: ${sym}, ${validExps.length} expirations`);
      const firstExp = validExps[0];
      if (firstExp) setBulkProgress({ done: 0, total: validExps.length, current: firstExp });
      for (let i = 0; i < validExps.length; i++) {
        const exp = validExps[i];
        if (!exp) continue;
        setBulkProgress({ done: i, total: validExps.length, current: exp });
        try {
          const opts = (await api.chain(sym, exp, bulkStrikeLimit)) as ChainRow[];
          setExpCacheTs((prev) => ({ ...prev, [exp]: Date.now() }));
          if (exp === selExp) {
            setChain(opts);
            setLastRefresh(Date.now());
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("error", `Bulk ${exp} failed: ${msg}`);
        }
      }
      setBulkProgress(null);
    },
    [symbol, selExp],
  );

  // ── Derived data ──────────────────────────────────────────────
  const daysToExp = selExp
    ? Math.max(
        0,
        Math.round((new Date(selExp + "T16:00:00").getTime() - new Date().getTime()) / 86400000),
      )
    : chain[0]?.dte || 0;

  const grouped = useMemo(() => {
    const m = new Map<number, { call?: ChainRow; put?: ChainRow }>();
    chain.forEach((o) => {
      if (!m.has(o.strike)) m.set(o.strike, {});
      const slot = m.get(o.strike);
      if (slot) slot[o.side] = o;
    });
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [chain]);

  const positionTickers = useMemo(
    () => [...new Set(positions.options.map((p) => p.underlying))].sort(),
    [positions.options],
  );

  const allPositions = useMemo(() => {
    if (!selTicker) return positions.options;
    // Show all positions, but sort so matching ticker appears first
    return [...positions.options].sort((a, b) => {
      const aMatch = a.underlying === selTicker ? 0 : 1;
      const bMatch = b.underlying === selTicker ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [positions.options, selTicker]);

  const filteredPositions = useMemo(
    () =>
      selTicker ? positions.options.filter((p) => p.underlying === selTicker) : positions.options,
    [positions.options, selTicker],
  );

  // ── Staging ───────────────────────────────────────────────────
  const stageContract = (opt: ChainRow, direction: "long" | "short") => {
    setStaged((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        side: opt.side,
        strike: opt.strike,
        expiration: selExp,
        dte: opt.dte || daysToExp,
        premium: opt.mid || opt.last || 0,
        iv: opt.iv || 0.25,
        quantity: direction === "long" ? 1 : -1,
        delta: opt.delta,
        gamma: opt.gamma,
        theta: opt.theta,
        vega: opt.vega,
      },
    ]);
  };

  const removeStaged = (id: number) => setStaged((prev) => prev.filter((s) => s.id !== id));
  const updateStagedQty = (id: number, qty: number) =>
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, quantity: qty } : s)));

  const runBuilder = useCallback(() => {
    if (!chain.length || builderLoading) {
      if (!chain.length) setBuilderError("Load a chain first");
      return;
    }
    setBuilderError("");
    setBuilderLoading(true);
    setBuilderLastResult(null);

    if (!builderWorker.current) {
      builderWorker.current = new Worker(
        new URL("../lib/greek-builder-worker.js", import.meta.url),
        { type: "module" },
      );
    }

    const parseNum = (v: string): number | null => (v === "" ? null : parseFloat(v));
    builderWorker.current.onmessage = (e: MessageEvent<BuilderWorkerResult>) => {
      setBuilderLoading(false);
      const result = e.data;
      if (!result.feasible) {
        setBuilderError(result.reason || "No feasible solution");
        setBuilderLastResult(null);
        return;
      }
      setBuilderLastResult(result);
      setStaged(
        result.positions.map((p) => ({
          id: Date.now() + Math.random(),
          side: p.side,
          strike: p.strike,
          expiration: selExp,
          dte: daysToExp,
          premium: p.premium,
          iv: p.iv,
          quantity: p.direction === "long" ? p.qty : -p.qty,
          delta: p.rawDelta,
          gamma: p.rawGamma,
          theta: p.rawTheta,
          vega: p.rawVega,
        })),
      );
      log(
        "info",
        `Builder: ${result.strategyLabel} — ${result.totals.contracts} contracts, margin $${result.totals.margin.toFixed(0)}, ${result.solveMs || "?"}ms`,
      );
    };
    builderWorker.current.onerror = (e: ErrorEvent) => {
      setBuilderLoading(false);
      setBuilderError(`Worker error: ${e.message}`);
    };

    builderWorker.current.postMessage({
      chain,
      options: {
        modes: greekModes,
        bounds: {
          deltaMin: parseNum(greekBounds.deltaMin),
          deltaMax: parseNum(greekBounds.deltaMax),
          gammaMin: parseNum(greekBounds.gammaMin),
          gammaMax: parseNum(greekBounds.gammaMax),
          thetaMin: parseNum(greekBounds.thetaMin),
          thetaMax: parseNum(greekBounds.thetaMax),
          vegaMin: parseNum(greekBounds.vegaMin),
          vegaMax: parseNum(greekBounds.vegaMax),
        },
        maxBudget: builderBudget,
        maxLegs: builderMaxLegs,
        spot: spotPrice,
        assetClass: isFutures ? "futures" : "equity",
      },
    });
  }, [
    chain,
    selExp,
    daysToExp,
    greekModes,
    greekBounds,
    builderBudget,
    builderMaxLegs,
    spotPrice,
    isFutures,
    builderLoading,
  ]);

  const applyBuilderPreset = (key: string) => {
    const presets = GREEK_BUILDER_PRESETS as Record<string, BuilderPresetEntry>;
    const preset = presets[key];
    if (!preset) return;
    setGreekModes({ ...preset.modes });
    const nb: GreekBounds = {
      deltaMin: "",
      deltaMax: "",
      gammaMin: "",
      gammaMax: "",
      thetaMin: "",
      thetaMax: "",
      vegaMin: "",
      vegaMax: "",
    };
    for (const [k, v] of Object.entries(preset.bounds || {})) {
      if (v != null) nb[k as keyof GreekBounds] = String(v);
    }
    setGreekBounds(nb);
    setBuilderError("");
  };

  const stagedNet = useMemo(
    () =>
      staged.reduce(
        (acc, s) => ({
          premium: acc.premium + s.premium * s.quantity * 100,
          delta: acc.delta + (s.delta ?? 0) * s.quantity,
          gamma: acc.gamma + (s.gamma ?? 0) * s.quantity,
          theta: acc.theta + (s.theta ?? 0) * s.quantity,
          vega: acc.vega + (s.vega ?? 0) * s.quantity,
        }),
        { premium: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
      ),
    [staged],
  );

  // ── P&L curves ────────────────────────────────────────────────
  const effectiveXMin = xMin ?? Math.round(spotPrice * 0.85);
  const effectiveXMax = xMax ?? Math.round(spotPrice * 1.15);

  // Leg shape consumed by lib/payoff.js's generatePayoffCurve. iv/dte
  // are optional — omitted means "at expiry, no IV needed".
  interface PayoffLegLite {
    side: "call" | "put";
    strike: number;
    premium: number;
    quantity: number;
    iv?: number;
    dte?: number;
  }

  const positionLegs = useMemo<PayoffLegLite[]>(
    () =>
      filteredPositions.map((p) => ({
        side: p.side,
        strike: p.strike,
        premium: p.averageCost,
        quantity: p.quantity,
      })),
    [filteredPositions],
  );

  const stagedLegs = useMemo<PayoffLegLite[]>(
    () =>
      staged.map((s) => ({
        side: s.side,
        strike: s.strike,
        premium: s.premium,
        quantity: s.quantity,
        iv: s.iv,
        dte: s.dte,
      })),
    [staged],
  );

  const pnlData = useMemo<PnlPoint[]>(() => {
    if (positionLegs.length === 0 && stagedLegs.length === 0) return [];
    const allLegs = [...positionLegs, ...stagedLegs];
    type CurvePt = { spot: number; pnl: number };
    const curvePos =
      positionLegs.length > 0
        ? (generatePayoffCurve(positionLegs, effectiveXMin, effectiveXMax) as CurvePt[])
        : null;
    const curveStg =
      stagedLegs.length > 0
        ? (generatePayoffCurve(stagedLegs, effectiveXMin, effectiveXMax) as CurvePt[])
        : null;
    const curveAll =
      allLegs.length > 0
        ? (generatePayoffCurve(allLegs, effectiveXMin, effectiveXMax) as CurvePt[])
        : null;

    const base: CurvePt[] = curveAll ?? curvePos ?? curveStg ?? [];
    return base.map((pt, i) => ({
      price: pt.spot,
      current: curvePos?.[i]?.pnl ?? 0,
      staged: curveStg?.[i]?.pnl ?? 0,
      combined: curveAll?.[i]?.pnl ?? 0,
    }));
  }, [positionLegs, stagedLegs, effectiveXMin, effectiveXMax]);

  const pnlLines = useMemo<PnlLine[]>(() => {
    const lines: PnlLine[] = [];
    if (positionLegs.length > 0)
      lines.push({ key: "current", label: "Current Position", color: C.accent });
    if (stagedLegs.length > 0)
      lines.push({ key: "staged", label: "Staged Trades", color: C.amber });
    if (positionLegs.length > 0 && stagedLegs.length > 0)
      lines.push({ key: "combined", label: "Combined", color: "#fff" });
    return lines;
  }, [positionLegs.length, stagedLegs.length]);

  const breakevens = useMemo<number[]>(() => {
    if (!pnlData.length) return [];
    const allLegs = [...positionLegs, ...stagedLegs];
    if (!allLegs.length) return [];
    const curve = generatePayoffCurve(allLegs, effectiveXMin, effectiveXMax) as {
      spot: number;
      pnl: number;
    }[];
    return findBreakevens(curve) as number[];
  }, [pnlData, positionLegs, stagedLegs, effectiveXMin, effectiveXMax]);

  // ── Chain cell renderer ───────────────────────────────────────
  const OptCell = ({ opt }: { opt: ChainRow | undefined }) => {
    if (!opt)
      return (
        <td
          colSpan={9}
          style={{ padding: "3px 4px", color: C.dim, fontSize: 10, textAlign: "center" }}
        >
          —
        </td>
      );
    return (
      <>
        <td
          style={{
            padding: "3px 3px",
            fontFamily: mono,
            fontSize: 10,
            color: C.dim,
            textAlign: "right",
          }}
        >
          {opt.volume || 0}
        </td>
        <td
          style={{
            padding: "3px 3px",
            fontFamily: mono,
            fontSize: 10,
            color: C.dim,
            textAlign: "right",
          }}
        >
          {opt.openInterest || 0}
        </td>
        <td style={{ padding: "3px 3px", fontFamily: mono, fontSize: 11, textAlign: "right" }}>
          {fmt(opt.bid)}
        </td>
        <td style={{ padding: "3px 3px", fontFamily: mono, fontSize: 11, textAlign: "right" }}>
          {fmt(opt.ask)}
        </td>
        <td
          style={{
            padding: "3px 3px",
            fontFamily: mono,
            fontSize: 10,
            color: C.cyan,
            textAlign: "right",
          }}
        >
          {fmtPct(opt.iv)}
        </td>
        <td style={{ padding: "3px 3px", fontFamily: mono, fontSize: 10, textAlign: "right" }}>
          {fmtGreek(opt.delta)}
        </td>
        <td
          style={{
            padding: "3px 3px",
            fontFamily: mono,
            fontSize: 10,
            textAlign: "right",
            color: C.dim,
          }}
        >
          {fmtGreek(opt.gamma)}
        </td>
        <td
          style={{
            padding: "3px 3px",
            fontFamily: mono,
            fontSize: 10,
            textAlign: "right",
            color: C.dim,
          }}
        >
          {fmtGreek(opt.theta)}
        </td>
        <td style={{ padding: "3px 3px" }}>
          <div style={{ display: "flex", gap: 2 }}>
            <button
              onClick={() => stageContract(opt, "long")}
              title="Buy"
              style={{
                border: "none",
                background: C.gDim,
                color: C.green,
                borderRadius: 3,
                fontSize: 8,
                fontWeight: 700,
                padding: "2px 4px",
                cursor: "pointer",
              }}
            >
              +
            </button>
            <button
              onClick={() => stageContract(opt, "short")}
              title="Sell"
              style={{
                border: "none",
                background: C.rDim,
                color: C.red,
                borderRadius: 3,
                fontSize: 8,
                fontWeight: 700,
                padding: "2px 4px",
                cursor: "pointer",
              }}
            >
              −
            </button>
          </div>
        </td>
      </>
    );
  };

  // ── Render ────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ── Controls bar ─────────────────────────────────────────── */}
      <Card
        title="Options"
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {lastRefresh && !loading && (
              <span style={{ fontSize: 9, fontFamily: mono, color: C.dim }}>
                {formatAge(lastRefresh, now)}
              </span>
            )}
            <Btn onClick={refreshAll} disabled={!!loading || !!bulkProgress}>
              {loading ? "Loading..." : "Refresh"}
            </Btn>
            {exps.length > 0 && (
              <Btn
                onClick={() => setShowBulk(true)}
                disabled={!!loading || !!bulkProgress}
                color={C.purple}
              >
                Bulk
              </Btn>
            )}
          </div>
        }
      >
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label
              style={{
                fontSize: 9,
                fontFamily: sans,
                color: C.dim,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              Symbol
            </label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadSymbol()}
              placeholder="SPY or /CL"
              style={{
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 5,
                color: C.text,
                fontFamily: mono,
                fontSize: 12,
                padding: "5px 8px",
                width: 90,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label
              style={{
                fontSize: 9,
                fontFamily: sans,
                color: C.dim,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              Strikes
            </label>
            <select
              value={strikeLimit}
              onChange={(e) => setStrikeLimit(+e.target.value)}
              style={{
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 5,
                color: C.text,
                fontFamily: mono,
                fontSize: 12,
                padding: "5px 8px",
                height: 30,
              }}
            >
              {[10, 20, 30, 50].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <span style={{ fontSize: 10, color: C.dim }}>
            Spot{isFutures && selMonth ? ` (${selMonth})` : ""}:{" "}
            <span style={{ color: C.cyan, fontFamily: mono }}>${spotPrice.toFixed(2)}</span>
          </span>
          {error && <span style={{ fontSize: 10, color: C.red }}>{error}</span>}
          {bulkProgress && (
            <span style={{ fontSize: 9, fontFamily: mono, color: C.purple }}>
              {bulkProgress.done + 1}/{bulkProgress.total} — {bulkProgress.current}
            </span>
          )}
        </div>

        {/* ── Futures month selector ───────────────────────────────── */}
        {isFutures && futMonths.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <label
              style={{
                fontSize: 9,
                fontFamily: sans,
                color: C.dim,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                display: "block",
                marginBottom: 4,
              }}
            >
              Contract Month
            </label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              {futMonths.slice(0, 8).map((m) => (
                <Pill
                  key={m.symbol}
                  active={selMonth === m.symbol}
                  onClick={() => handleMonthChange(m.symbol)}
                  small
                >
                  {m.symbol.replace(/^\//, "")}{" "}
                  <span style={{ color: C.dim, fontSize: 8, marginLeft: 2 }}>
                    ${m.last.toFixed(2)}
                  </span>
                </Pill>
              ))}
              {futMonths.length > 8 && (
                <select
                  value={selMonth}
                  onChange={(e) => handleMonthChange(e.target.value)}
                  style={{
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                    borderRadius: 4,
                    color: C.text,
                    fontFamily: mono,
                    fontSize: 10,
                    padding: "2px 4px",
                  }}
                >
                  {futMonths.map((m) => (
                    <option key={m.symbol} value={m.symbol}>
                      {m.symbol.replace(/^\//, "")} ${m.last.toFixed(2)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}

        {exps.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <label
              style={{
                fontSize: 9,
                fontFamily: sans,
                color: C.dim,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                display: "block",
                marginBottom: 4,
              }}
            >
              Expiration ({daysToExp} DTE)
            </label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              {exps.slice(0, 10).map((exp) => {
                const ts = expCacheTs[exp];
                return (
                  <Pill key={exp} active={selExp === exp} onClick={() => setSelExp(exp)} small>
                    {ts && (
                      <span
                        style={{ color: C.green, marginRight: 3 }}
                        title={`cached ${formatAge(ts, now)}`}
                      >
                        ●
                      </span>
                    )}
                    {exp}
                  </Pill>
                );
              })}
              {exps.length > 10 && (
                <select
                  value={selExp}
                  onChange={(e) => setSelExp(e.target.value)}
                  style={{
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                    borderRadius: 4,
                    color: C.text,
                    fontFamily: mono,
                    fontSize: 10,
                    padding: "2px 4px",
                  }}
                >
                  {exps.map((exp) => (
                    <option key={exp} value={exp}>
                      {expCacheTs[exp] ? "● " : ""}
                      {exp}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── Section 1: Current Position ──────────────────────────── */}
      <Card
        title="Current Position"
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {positionTickers.length > 0 && (
              <select
                value={selTicker}
                onChange={(e) => {
                  setSelTicker(e.target.value);
                  setSymbol(e.target.value);
                }}
                style={{
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  color: C.text,
                  fontFamily: mono,
                  fontSize: 10,
                  padding: "2px 6px",
                }}
              >
                <option value="">All</option>
                {positionTickers.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
            <Btn
              onClick={loadPositions}
              disabled={posLoading}
              style={{ fontSize: 9, padding: "2px 8px" }}
            >
              {posLoading ? "..." : "Refresh"}
            </Btn>
          </div>
        }
      >
        {allPositions.length === 0 && (
          <div style={{ padding: 12, color: C.dim, fontSize: 11, textAlign: "center" }}>
            {posLoading ? "Loading positions..." : "No positions"}
          </div>
        )}
        {allPositions.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: mono }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: `1px solid ${C.border}`,
                    color: C.dim,
                    fontSize: 8,
                    textTransform: "uppercase",
                  }}
                >
                  {[
                    "Sym",
                    "Side",
                    "Strike",
                    "Exp",
                    "Qty",
                    "Avg Cost",
                    "Mkt Val",
                    "P&L",
                    "Δ",
                    "Γ",
                    "Θ",
                    "V",
                  ].map((h) => (
                    <th key={h} style={{ padding: "3px 5px", textAlign: "right" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allPositions.map((p, i) => {
                  const isActive = !!selTicker && p.underlying === selTicker;
                  const dimmed = !!selTicker && !isActive;
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom: `1px solid ${C.border}`,
                        background: isActive ? `${C.accent}10` : "transparent",
                        opacity: dimmed ? 0.4 : 1,
                      }}
                    >
                      <td
                        style={{
                          padding: "3px 5px",
                          textAlign: "right",
                          fontWeight: 600,
                          color: isActive ? C.accent : C.dim,
                        }}
                      >
                        {p.underlying}
                      </td>
                      <td
                        style={{
                          padding: "3px 5px",
                          color: p.side === "call" ? C.green : C.red,
                          fontWeight: 600,
                          textAlign: "right",
                        }}
                      >
                        {p.side.toUpperCase()}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right", fontWeight: 600 }}>
                        {p.strike}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                        {p.expiration}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right" }}>{p.quantity}</td>
                      <td style={{ padding: "3px 5px", textAlign: "right" }}>
                        {fmt(p.averageCost)}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right" }}>
                        {fmt(p.marketValue)}
                      </td>
                      <td
                        style={{
                          padding: "3px 5px",
                          textAlign: "right",
                          color: p.unrealizedPnl >= 0 ? C.green : C.red,
                          fontWeight: 600,
                        }}
                      >
                        {p.unrealizedPnl >= 0 ? "+" : ""}
                        {fmt(p.unrealizedPnl)}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right" }}>
                        {fmtGreek(p.delta)}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                        {fmtGreek(p.gamma)}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                        {fmtGreek(p.theta)}
                      </td>
                      <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                        {fmtGreek(p.vega)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Section 2: Options Chain ─────────────────────────────── */}
      {chain.length > 0 && !loading && (
        <Card title={`Chain — ${chainSymbol} ${selExp}`}>
          <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
              <thead style={{ position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
                <tr>
                  <th
                    colSpan={9}
                    style={{
                      padding: "4px 4px",
                      textAlign: "center",
                      color: C.green,
                      fontSize: 9,
                      borderBottom: `1px solid ${C.border}`,
                      letterSpacing: 1,
                    }}
                  >
                    CALLS
                  </th>
                  <th
                    style={{
                      padding: "4px 4px",
                      textAlign: "center",
                      color: C.amber,
                      fontSize: 10,
                      fontFamily: mono,
                      borderBottom: `1px solid ${C.border}`,
                      fontWeight: 700,
                    }}
                  >
                    STRIKE
                  </th>
                  <th
                    colSpan={9}
                    style={{
                      padding: "4px 4px",
                      textAlign: "center",
                      color: C.red,
                      fontSize: 9,
                      borderBottom: `1px solid ${C.border}`,
                      letterSpacing: 1,
                    }}
                  >
                    PUTS
                  </th>
                </tr>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Vol", "OI", "Bid", "Ask", "IV", "Δ", "Γ", "Θ", ""].map((h, i) => (
                    <th
                      key={"c" + i}
                      style={{
                        padding: "2px 3px",
                        fontSize: 7,
                        color: C.dim,
                        textTransform: "uppercase",
                        textAlign: "right",
                        letterSpacing: 0.5,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                  <th></th>
                  {["Vol", "OI", "Bid", "Ask", "IV", "Δ", "Γ", "Θ", ""].map((h, i) => (
                    <th
                      key={"p" + i}
                      style={{
                        padding: "2px 3px",
                        fontSize: 7,
                        color: C.dim,
                        textTransform: "uppercase",
                        textAlign: "right",
                        letterSpacing: 0.5,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grouped.map(([strike, opts]) => {
                  const atm = Math.abs(strike - spotPrice) < spotPrice * 0.005;
                  return (
                    <tr
                      key={strike}
                      style={{
                        borderBottom: `1px solid ${C.border}`,
                        background: atm ? `${C.amber}12` : "transparent",
                      }}
                    >
                      <OptCell opt={opts.call} />
                      <td
                        style={{
                          padding: "3px 4px",
                          textAlign: "center",
                          fontFamily: mono,
                          fontSize: 11,
                          fontWeight: 700,
                          color: atm ? C.amber : C.text,
                          borderLeft: `1px solid ${C.border}`,
                          borderRight: `1px solid ${C.border}`,
                        }}
                      >
                        {strike}
                      </td>
                      <OptCell opt={opts.put} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {loading === "chain" && (
        <div style={{ padding: 20, textAlign: "center", color: C.dim, fontSize: 12 }}>
          Loading chain...
        </div>
      )}

      {/* ── Greek Builder ─────────────────────────────────────────── */}
      {chain.length > 0 && !loading && (
        <Card
          title="Greek Builder"
          actions={
            <div style={{ display: "flex", gap: 4 }}>
              {Object.entries(GREEK_BUILDER_PRESETS as Record<string, BuilderPresetEntry>).map(
                ([key, p]) => (
                  <Pill key={key} small onClick={() => applyBuilderPreset(key)}>
                    {p.label}
                  </Pill>
                ),
              )}
            </div>
          }
        >
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
            {(["delta", "gamma", "theta", "vega"] as const).map((greek: GreekKey) => {
              const symMap: Record<GreekKey, string> = {
                delta: "Δ",
                gamma: "Γ",
                theta: "Θ",
                vega: "V",
              };
              const sym = symMap[greek];
              const mode = greekModes[greek];
              const isObj = mode === "max" || mode === "min";
              return (
                <div key={greek} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: mono,
                      color: isObj ? C.accent : C.dim,
                      fontWeight: isObj ? 700 : 400,
                      width: 12,
                    }}
                  >
                    {sym}
                  </span>
                  <select
                    value={mode}
                    onChange={(e) =>
                      setGreekModes((prev) => ({
                        ...prev,
                        [greek]: e.target.value as GreekTarget,
                      }))
                    }
                    style={{
                      background: C.bg,
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                      color: isObj ? C.accent : C.text,
                      fontFamily: mono,
                      fontSize: 10,
                      padding: "3px 4px",
                    }}
                  >
                    <option value="max">Max</option>
                    <option value="flat">Flat</option>
                    <option value="min">Min</option>
                    <option value="bound">Bound</option>
                    <option value="any">Any</option>
                  </select>
                  {mode === "bound" && (
                    <>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="min"
                        value={greekBounds[(greek + "Min") as keyof GreekBounds]}
                        onChange={(e) =>
                          setGreekBounds((prev) => ({
                            ...prev,
                            [greek + "Min"]: e.target.value,
                          }))
                        }
                        style={{
                          width: 60,
                          background: C.bg,
                          border: `1px solid ${C.border}`,
                          borderRadius: 3,
                          color: C.text,
                          fontFamily: mono,
                          fontSize: 10,
                          textAlign: "right",
                          padding: "3px 4px",
                        }}
                      />
                      <span style={{ fontSize: 9, color: C.dim }}>to</span>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="max"
                        value={greekBounds[(greek + "Max") as keyof GreekBounds]}
                        onChange={(e) =>
                          setGreekBounds((prev) => ({
                            ...prev,
                            [greek + "Max"]: e.target.value,
                          }))
                        }
                        style={{
                          width: 60,
                          background: C.bg,
                          border: `1px solid ${C.border}`,
                          borderRadius: 3,
                          color: C.text,
                          fontFamily: mono,
                          fontSize: 10,
                          textAlign: "right",
                          padding: "3px 4px",
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label
                style={{
                  fontSize: 9,
                  fontFamily: sans,
                  color: C.dim,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                Budget
              </label>
              <input
                type="number"
                value={builderBudget}
                onChange={(e) => setBuilderBudget(+e.target.value || 0)}
                style={{
                  width: 70,
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  borderRadius: 5,
                  color: C.text,
                  fontFamily: mono,
                  fontSize: 12,
                  padding: "5px 8px",
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label
                style={{
                  fontSize: 9,
                  fontFamily: sans,
                  color: C.dim,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                Max Legs
              </label>
              <input
                type="number"
                value={builderMaxLegs}
                onChange={(e) => setBuilderMaxLegs(+e.target.value || 1)}
                style={{
                  width: 50,
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  borderRadius: 5,
                  color: C.text,
                  fontFamily: mono,
                  fontSize: 12,
                  padding: "5px 8px",
                }}
              />
            </div>
            <Btn onClick={runBuilder} color={C.accent} disabled={builderLoading}>
              {builderLoading ? "Building..." : "Build"}
            </Btn>
          </div>
          {builderError && (
            <div style={{ marginTop: 6, fontSize: 10, color: C.red }}>{builderError}</div>
          )}
          {/* ── Margin summary (§3.5.2 two-pass reconciliation) ──── */}
          {builderLastResult && <MarginDiscrepancyPanel totals={builderLastResult.totals} />}
        </Card>
      )}

      {/* ── Section 3: Staged Trades ─────────────────────────────── */}
      <Card
        title="Staged Trades"
        actions={
          staged.length > 0 ? (
            <Btn
              onClick={() => setStaged([])}
              color={C.red}
              style={{ fontSize: 9, padding: "2px 8px" }}
            >
              Clear
            </Btn>
          ) : undefined
        }
      >
        {staged.length === 0 && (
          <div style={{ padding: 12, color: C.dim, fontSize: 11, textAlign: "center" }}>
            Click + or − on a chain row to stage a trade
          </div>
        )}
        {staged.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: mono }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: `1px solid ${C.border}`,
                    color: C.dim,
                    fontSize: 8,
                    textTransform: "uppercase",
                  }}
                >
                  {["Side", "Strike", "Exp", "Qty", "Premium", "Δ", "Γ", "Θ", "V", ""].map((h) => (
                    <th key={h} style={{ padding: "3px 5px", textAlign: "right" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staged.map((s) => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td
                      style={{
                        padding: "3px 5px",
                        color: s.side === "call" ? C.green : C.red,
                        fontWeight: 600,
                        textAlign: "right",
                      }}
                    >
                      {s.side.toUpperCase()}
                    </td>
                    <td style={{ padding: "3px 5px", textAlign: "right", fontWeight: 600 }}>
                      {s.strike}
                    </td>
                    <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                      {s.expiration}
                    </td>
                    <td style={{ padding: "3px 5px", textAlign: "right" }}>
                      <input
                        type="number"
                        value={s.quantity}
                        onChange={(e) => updateStagedQty(s.id, parseInt(e.target.value) || 0)}
                        style={{
                          width: 40,
                          background: C.bg,
                          border: `1px solid ${C.border}`,
                          borderRadius: 3,
                          color: C.text,
                          fontFamily: mono,
                          fontSize: 10,
                          textAlign: "right",
                          padding: "1px 3px",
                        }}
                      />
                    </td>
                    <td style={{ padding: "3px 5px", textAlign: "right" }}>{fmt(s.premium)}</td>
                    <td style={{ padding: "3px 5px", textAlign: "right" }}>{fmtGreek(s.delta)}</td>
                    <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                      {fmtGreek(s.gamma)}
                    </td>
                    <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                      {fmtGreek(s.theta)}
                    </td>
                    <td style={{ padding: "3px 5px", textAlign: "right", color: C.dim }}>
                      {fmtGreek(s.vega)}
                    </td>
                    <td style={{ padding: "3px 5px", textAlign: "center" }}>
                      <button
                        onClick={() => removeStaged(s.id)}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: C.red,
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: `2px solid ${C.border}`, fontWeight: 600 }}>
                  <td
                    colSpan={4}
                    style={{ padding: "4px 5px", textAlign: "right", color: C.dim, fontSize: 9 }}
                  >
                    NET
                  </td>
                  <td
                    style={{
                      padding: "4px 5px",
                      textAlign: "right",
                      color: stagedNet.premium >= 0 ? C.green : C.red,
                    }}
                  >
                    ${Math.abs(stagedNet.premium).toFixed(0)}
                    {stagedNet.premium >= 0 ? " cr" : " db"}
                  </td>
                  <td style={{ padding: "4px 5px", textAlign: "right" }}>
                    {fmtDollarGreek(stagedNet.delta)}
                  </td>
                  <td style={{ padding: "4px 5px", textAlign: "right", color: C.dim }}>
                    {fmtDollarGreek(stagedNet.gamma)}
                  </td>
                  <td style={{ padding: "4px 5px", textAlign: "right", color: C.dim }}>
                    {fmtDollarGreek(stagedNet.theta)}
                  </td>
                  <td style={{ padding: "4px 5px", textAlign: "right", color: C.dim }}>
                    {fmtDollarGreek(stagedNet.vega)}
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Section 4: P&L Chart ─────────────────────────────────── */}
      <Card
        title="P&L at Expiry"
        actions={
          <div
            style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 9, fontFamily: mono }}
          >
            <label style={{ color: C.dim }}>X:</label>
            <input
              type="number"
              value={effectiveXMin}
              onChange={(e) => setXMin(+e.target.value || null)}
              style={{
                width: 55,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                color: C.text,
                fontFamily: mono,
                fontSize: 10,
                textAlign: "right",
                padding: "1px 3px",
              }}
            />
            <span style={{ color: C.dim }}>–</span>
            <input
              type="number"
              value={effectiveXMax}
              onChange={(e) => setXMax(+e.target.value || null)}
              style={{
                width: 55,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                color: C.text,
                fontFamily: mono,
                fontSize: 10,
                textAlign: "right",
                padding: "1px 3px",
              }}
            />
            {breakevens.length > 0 && (
              <span style={{ color: C.amber, marginLeft: 8 }}>
                BE: {breakevens.map((b) => "$" + b.toFixed(1)).join(", ")}
              </span>
            )}
          </div>
        }
      >
        {pnlData.length > 0 ? (
          <CurveChart
            data={pnlData as unknown as Record<string, number>[]}
            xKey="price"
            lines={pnlLines}
            xlabel="Underlying Price"
            ylabel="P&L ($)"
            height={280}
            spotLine={spotPrice}
          />
        ) : (
          <div style={{ padding: 30, textAlign: "center", color: C.dim, fontSize: 11 }}>
            Add positions or stage trades to see the P&L chart
          </div>
        )}
      </Card>

      {/* ── Log ────────────────────────────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
        <button
          onClick={() => setShowLog(!showLog)}
          style={{
            background: "transparent",
            border: "none",
            color: C.dim,
            fontSize: 10,
            fontFamily: sans,
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 8 }}>{showLog ? "▼" : "▶"}</span> Log ({logEntries.length})
        </button>
        {showLog && (
          <div
            style={{
              marginTop: 6,
              maxHeight: 180,
              overflowY: "auto",
              background: C.bg,
              borderRadius: 5,
              border: `1px solid ${C.border}`,
              padding: 6,
              fontFamily: mono,
              fontSize: 10,
            }}
          >
            {logEntries.map((e, i) => (
              <div
                key={i}
                style={{
                  color: e.level === "error" ? C.red : e.level === "warn" ? C.amber : C.dim,
                }}
              >
                <span style={{ color: C.dim, opacity: 0.6 }}>
                  {new Date(e.ts).toLocaleTimeString()}
                </span>{" "}
                {e.msg}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        )}
      </div>

      {showBulk && (
        <BulkLoadModal
          exps={expsNext6mo}
          symbol={symbol}
          now={now}
          onClose={() => setShowBulk(false)}
          onStart={bulkLoad}
        />
      )}
    </div>
  );
}
