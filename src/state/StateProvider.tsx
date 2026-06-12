import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { connectStateWs } from "../lib/api.js";
import type {
  WsMessage,
  SystemState,
  SystemBlock,
  OrdersBlock,
  FillsBlock,
  RiskLimitsConfig,
  WorkspaceLayoutsConfig,
  PositionExitRuleMsg,
} from "../types/ws.js";
import type { PortfolioState } from "../types/portfolio.js";
import type { Fill } from "../types/order.js";
import type { Strategy } from "../types/strategy.js";

// QF-228 — outstanding quote-unavailable alerts. The reducer maintains
// a Map keyed by symbol so concurrent failures across multiple symbols
// collapse to one banner with a count. quote_recovered clears the
// entry for that symbol; the banner auto-dismisses.
export interface OutstandingQuoteAlert {
  symbol: string;
  reason: string;
  detail?: string;
  adapter?: string;
  portfolio?: string;
  ts: string;
}

// QF-322 — one exit-rule trip the monitor acted on. Folded from
// position_exit_rule WS events (server emits one per closed leg). The
// reducer keeps a bounded, most-recent-first ring so the Strategies
// screen can render trip history and the shell can banner the in-flight
// closes — both distinct from operator-driven manual liquidation.
export interface ExitRuleTrip {
  position_id: string;
  rule: "stop_loss" | "target" | "max_hold" | "max_drawdown";
  closing_intent_id: string;
  strategy_id: string;
  // Client-stamped arrival time; the server event carries no timestamp.
  ts: string;
}

// Cap on the retained trip ring. Trips are live monitoring signal, not
// the audit record (that lives in audit_orders via the closing intent),
// so a bounded recent window is enough for the GUI.
const MAX_EXIT_RULE_TRIPS = 50;

// ── Context shape ─────────────────────────────────────────────────

export interface StateContextValue {
  state: SystemState | null;
  connected: boolean;
  reconnecting: boolean;
  outstandingQuoteAlerts: ReadonlyMap<string, OutstandingQuoteAlert>;
  // QF-322 — most-recent-first ring of exit-rule trips.
  exitRuleTrips: readonly ExitRuleTrip[];
}

// Exported so tests can wrap consumers in a Provider with a fixed
// value without spinning up a WebSocket. Production code uses
// <StateProvider> below.
export const StateContext = createContext<StateContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────
// Wraps the existing connectStateWs() with exponential backoff
// reconnection (1s → 2s → 4s → 8s → 16s → 30s cap, per the source
// brief). On reconnect, the server sends a fresh snapshot which
// fully replaces the cached state — no diff merging across gaps.

export function StateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SystemState | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // QF-228 — Map of outstanding quote_unavailable events, keyed by
  // symbol. Updated atomically alongside state by applyMessage.
  const [outstandingQuoteAlerts, setOutstandingQuoteAlerts] = useState<
    Map<string, OutstandingQuoteAlert>
  >(() => new Map());
  // QF-322 — exit-rule trip ring, fed by position_exit_rule events.
  const [exitRuleTrips, setExitRuleTrips] = useState<ExitRuleTrip[]>(() => []);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(1000);
  const closedByUsRef = useRef(false);

  const connect = useCallback(() => {
    try {
      const ws = connectStateWs(
        (msg: WsMessage) => {
          setState((prev) => applyMessage(prev, msg));
          if (msg.type === "alert") {
            setOutstandingQuoteAlerts((prev) => applyAlertToOutstanding(prev, msg));
          }
          if (msg.type === "position_exit_rule") {
            setExitRuleTrips((prev) => applyExitRuleTrip(prev, msg));
          }
          if (msg.type === "snapshot") {
            // A fresh snapshot means a reconnect gap: drop stale in-flight
            // trips so the banner doesn't show closes that may have already
            // settled while disconnected, then reset the retry backoff and
            // clear the reconnecting flag.
            setExitRuleTrips([]);
            retryRef.current = 1000;
            setReconnecting(false);
          }
        },
        () => {
          setConnected(false);
          if (closedByUsRef.current) return;
          setReconnecting(true);
          const delay = Math.min(retryRef.current, 30000);
          retryRef.current = delay * 2;
          setTimeout(connect, delay);
        },
      );
      ws.addEventListener("open", () => {
        setConnected(true);
        setReconnecting(false);
      });
      wsRef.current = ws;
    } catch {
      setReconnecting(true);
      setTimeout(connect, retryRef.current);
    }
  }, []);

  useEffect(() => {
    closedByUsRef.current = false;
    connect();
    return () => {
      closedByUsRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  const value = useMemo<StateContextValue>(
    () => ({ state, connected, reconnecting, outstandingQuoteAlerts, exitRuleTrips }),
    [state, connected, reconnecting, outstandingQuoteAlerts, exitRuleTrips],
  );

  return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
}

// QF-228 — pure outstanding-alerts reducer. Exported for test access.
// quote_unavailable adds or refreshes the entry; quote_recovered for
// the same symbol clears it. Other alert types pass through untouched.
export function applyAlertToOutstanding(
  prev: Map<string, OutstandingQuoteAlert>,
  msg: { type: "alert"; data: { type: string; ts?: string; payload?: Record<string, unknown> } },
): Map<string, OutstandingQuoteAlert> {
  const symbol = (msg.data.payload?.symbol as string | undefined) ?? "";
  if (!symbol) return prev;
  if (msg.data.type === "quote_unavailable") {
    const next = new Map(prev);
    next.set(symbol, {
      symbol,
      reason: (msg.data.payload?.reason as string | undefined) ?? "unknown",
      detail: msg.data.payload?.detail as string | undefined,
      adapter: msg.data.payload?.adapter as string | undefined,
      portfolio: msg.data.payload?.portfolio as string | undefined,
      ts: msg.data.ts ?? new Date().toISOString(),
    });
    return next;
  }
  if (msg.data.type === "quote_recovered") {
    if (!prev.has(symbol)) return prev;
    const next = new Map(prev);
    next.delete(symbol);
    return next;
  }
  return prev;
}

// QF-322 — pure exit-rule trip reducer. Exported for test access.
// Prepends the trip and caps the ring at MAX_EXIT_RULE_TRIPS. Dedupes on
// (closing_intent_id, position_id) so a re-broadcast of the same close
// (e.g. a retried submit) doesn't double the history.
export function applyExitRuleTrip(
  prev: ExitRuleTrip[],
  msg: PositionExitRuleMsg,
  now: () => string = () => new Date().toISOString(),
): ExitRuleTrip[] {
  const { position_id, closing_intent_id } = msg.data;
  const dup = prev.some(
    (t) => t.closing_intent_id === closing_intent_id && t.position_id === position_id,
  );
  if (dup) return prev;
  const trip: ExitRuleTrip = { ...msg.data, ts: now() };
  return [trip, ...prev].slice(0, MAX_EXIT_RULE_TRIPS);
}

// ── Reducer ───────────────────────────────────────────────────────
// Pure: takes prior state + message → next state. Exported so the
// state plumbing is testable without a live socket.

export function applyMessage(prev: SystemState | null, msg: WsMessage): SystemState | null {
  if (msg.type === "snapshot") {
    return msg;
  }
  if (!prev) return prev;

  switch (msg.type) {
    case "portfolio_update": {
      const portfolios = { ...(prev.portfolios ?? {}) };
      const existing = portfolios[msg.portfolio];
      portfolios[msg.portfolio] = { ...(existing ?? {}), ...msg.data } as PortfolioState;
      return { ...prev, portfolios };
    }
    case "order_update": {
      const orders: OrdersBlock = prev.orders ?? {};
      const recent = [msg.data, ...(orders.recent ?? [])].slice(0, 50);
      return { ...prev, orders: { ...orders, recent } };
    }
    case "fill": {
      const fills: FillsBlock = prev.fills ?? {};
      const recent = [msg.data, ...(fills.recent ?? [])].slice(0, 50);
      return { ...prev, fills: { ...fills, recent } };
    }
    case "system_halt": {
      const system: SystemBlock = {
        ...prev.system,
        halted: msg.halted ?? true,
        halt_reason: msg.reason ?? null,
      };
      return { ...prev, system };
    }
    case "alert":
      // QF-228 — outstanding-alerts state is maintained separately via
      // applyAlertToOutstanding (the alerts ring already lives in the
      // server's alertRouter.recent()). The reducer doesn't fold alerts
      // into SystemState because there's nothing field-shaped to track here.
      return prev;
    case "strategy_update": {
      const list = prev.strategies ?? [];
      const idx = list.findIndex((s) => s.id === msg.data.id);
      const next = idx >= 0 ? list.map((s, i) => (i === idx ? msg.data : s)) : [...list, msg.data];
      return { ...prev, strategies: next };
    }
    case "risk_limits":
      return { ...prev, risk_limits: msg.data };
    case "workspace_layout":
      return { ...prev, workspace_layouts: msg.data };
    default:
      return prev;
  }
}

// ── Hooks ─────────────────────────────────────────────────────────

export function useStateContext(): StateContextValue {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error("useStateContext must be used inside <StateProvider>");
  return ctx;
}

export function useSystemState(): SystemBlock | null {
  return useStateContext().state?.system ?? null;
}

export function usePortfolios(): Record<string, PortfolioState> {
  return useStateContext().state?.portfolios ?? {};
}

export function usePortfolio(id: string): PortfolioState | undefined {
  return useStateContext().state?.portfolios?.[id];
}

export function useOrders(): OrdersBlock | null {
  return useStateContext().state?.orders ?? null;
}

export function useRecentFills(): Fill[] {
  return useStateContext().state?.fills?.recent ?? [];
}

export function useStrategies(): Strategy[] {
  return useStateContext().state?.strategies ?? [];
}

export function useRiskLimits(): RiskLimitsConfig | null {
  return useStateContext().state?.risk_limits ?? null;
}

// QF-346 — server-persisted drag-resized panel layouts. WorkspaceGrid
// reads this to apply the operator's track-size overrides; absent =
// render the static template.
export function useWorkspaceLayouts(): WorkspaceLayoutsConfig | null {
  return useStateContext().state?.workspace_layouts ?? null;
}

export function useConnectionStatus(): {
  connected: boolean;
  reconnecting: boolean;
} {
  const { connected, reconnecting } = useStateContext();
  return { connected, reconnecting };
}

// QF-228 — outstanding quote-unavailable alerts (one per symbol).
// The QuoteUnavailableBanner subscribes here; the banner shows the
// count + most recent entry, and drilling further is the operator's
// job via Settings → Health.
export function useOutstandingQuoteAlerts(): ReadonlyMap<string, OutstandingQuoteAlert> {
  return useStateContext().outstandingQuoteAlerts;
}

// QF-322 — recent exit-rule trips (most-recent-first). The Strategies
// screen filters by strategy_id for per-strategy trip history; the shell
// banner uses the unfiltered list to flag in-flight rule-driven closes.
export function useExitRuleTrips(): readonly ExitRuleTrip[] {
  return useStateContext().exitRuleTrips;
}
