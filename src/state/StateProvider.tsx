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

// ── Context shape ─────────────────────────────────────────────────

export interface StateContextValue {
  state: SystemState | null;
  connected: boolean;
  reconnecting: boolean;
  outstandingQuoteAlerts: ReadonlyMap<string, OutstandingQuoteAlert>;
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
          if (msg.type === "snapshot") {
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
    () => ({ state, connected, reconnecting, outstandingQuoteAlerts }),
    [state, connected, reconnecting, outstandingQuoteAlerts],
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
