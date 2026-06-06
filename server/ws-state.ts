// ── System State WebSocket ─────────────────────────────────────────
// Pushes portfolio, order, and system state updates to GUI clients.
// Defined in: docs/tdd/gui.md, §6

import type { Server } from "node:http";
import type { PortfolioState } from "../src/types/portfolio.js";
import type { Order, Fill } from "../src/types/order.js";
import type { Logger } from "./logger.js";
import type { Strategy } from "./strategy/lifecycle.js";
import type { RiskLimitsConfig } from "./risk/limits.js";

// ── Types ─────────────────────────────────────────────────────────
// QF-351 — trip event data carried on position_exit_rule messages.
export interface PositionExitRuleData {
  position_id: string;
  rule: "stop_loss" | "target" | "max_hold" | "max_drawdown";
  closing_intent_id: string;
  strategy_id: string;
}

// ── Internal types ─────────────────────────────────────────────────

interface WsClient {
  send(data: string): void;
  readyState: number;
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): void;
}

interface WsServer {
  on(event: string, handler: (...args: unknown[]) => void): void;
  close(): void;
}

export interface StateWebSocket {
  // QF-351 — portfolio_update now carries Partial<PortfolioState> (incl.
  // positions[]) per the gui.md §1 contract. The `portfolio` arg names
  // the target portfolio so the client-side reducer can patch the right
  // entry in portfolios{}.
  pushPortfolioUpdate(portfolio: string, data: Partial<PortfolioState>): void;
  pushOrderUpdate(order: Order): void;
  pushFill(fill: Fill): void;
  pushSystemHalt(reason: string): void;
  pushAlert(alert: {
    type: string;
    message: string;
    level?: "info" | "warning" | "critical";
    ts?: string;
    payload?: Record<string, unknown>;
  }): void;
  pushStrategyUpdate(strategy: Strategy): void;
  pushRiskLimits(cfg: RiskLimitsConfig): void;
  // QF-351 — trip event; drives the in-flight closing banner in the GUI.
  pushPositionExitRule(data: PositionExitRuleData): void;
  clientCount(): number;
  close(): void;
}

// ── Implementation ─────────────────────────────────────────────────

export function createStateWebSocket(
  _server: Server,
  logger: Logger,
  createWsServer?: (options: { noServer: true }) => WsServer,
): StateWebSocket {
  const clients = new Set<WsClient>();

  // If ws library is available, set up WebSocket server
  if (createWsServer) {
    const wss = createWsServer({ noServer: true });
    wss.on("connection", (ws: unknown) => {
      const client = ws as WsClient;
      clients.add(client);
      logger.debug("State WS client connected", { clients: clients.size });

      client.on("close", () => {
        clients.delete(client);
        logger.debug("State WS client disconnected", { clients: clients.size });
      });
    });
  }

  function broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) {
        // OPEN
        try {
          client.send(data);
        } catch {
          clients.delete(client);
        }
      }
    }
  }

  return {
    pushPortfolioUpdate(portfolio: string, data: Partial<PortfolioState>): void {
      broadcast({ type: "portfolio_update", portfolio, data });
    },

    pushOrderUpdate(order: Order): void {
      broadcast({ type: "order_update", data: order });
    },

    pushFill(fill: Fill): void {
      broadcast({ type: "fill", data: fill });
    },

    pushSystemHalt(reason: string): void {
      broadcast({ type: "system_halt", data: { reason, ts: new Date().toISOString() } });
    },

    pushAlert(alert: {
      type: string;
      message: string;
      level?: "info" | "warning" | "critical";
      ts?: string;
      payload?: Record<string, unknown>;
    }): void {
      broadcast({ type: "alert", data: alert });
    },

    pushStrategyUpdate(strategy: Strategy): void {
      broadcast({ type: "strategy_update", data: strategy });
    },

    pushRiskLimits(cfg: RiskLimitsConfig): void {
      broadcast({ type: "risk_limits", data: cfg });
    },

    pushPositionExitRule(data: PositionExitRuleData): void {
      broadcast({ type: "position_exit_rule", data });
    },

    clientCount(): number {
      return clients.size;
    },

    close(): void {
      for (const client of clients) {
        client.close();
      }
      clients.clear();
    },
  };
}
