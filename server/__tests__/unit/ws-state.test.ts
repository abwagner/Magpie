import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createStateWebSocket, type StateWebSocket } from "../../ws-state.js";
import { createTestLogger } from "../helpers/test-logger.js";

// Mock WS client
function mockClient() {
  const sent: string[] = [];
  return {
    readyState: 1, // OPEN
    send(data: string) {
      sent.push(data);
    },
    on(_event: string, _handler: unknown) {},
    close() {
      this.readyState = 3;
    },
    sent,
  };
}

// Mock WS server that immediately registers a client
function mockWsServerFactory(client: ReturnType<typeof mockClient>) {
  return (_opts: { noServer: true }) => {
    let connectionHandler: ((ws: unknown) => void) | null = null;
    const wss = {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === "connection") {
          connectionHandler = handler;
          // Simulate immediate connection
          handler(client);
        }
      },
      close() {},
    };
    return wss;
  };
}

describe("ws-state", () => {
  const logger = createTestLogger();
  const server = createServer();

  it("starts with zero clients when no WS server", () => {
    const ws = createStateWebSocket(server, logger);
    expect(ws.clientCount()).toBe(0);
  });

  it("tracks connected clients", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    expect(ws.clientCount()).toBe(1);
  });

  it("pushPortfolioUpdate broadcasts portfolio + data to clients", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    ws.pushPortfolioUpdate("main", { cash: 100000, positions: [] });

    expect(client.sent).toHaveLength(1);
    const msg = JSON.parse(client.sent[0]!);
    expect(msg.type).toBe("portfolio_update");
    expect(msg.portfolio).toBe("main");
    expect(msg.data.cash).toBe(100000);
  });

  it("pushPortfolioUpdate includes positions[] when provided", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    const positions = [
      {
        position_id: "pos-1",
        symbol: "EQ:SPY",
        underlying: "SPY",
        direction: "Long" as const,
        quantity: 10,
        entry_price: 100,
        entry_date: "2026-06-01T12:00:00.000Z",
        current_price: 101,
        unrealized_pnl: 10,
        delta: 1,
        gamma: 0,
        theta: 0,
        vega: 0,
      },
    ];
    ws.pushPortfolioUpdate("main", { positions });

    const msg = JSON.parse(client.sent[0]!);
    expect(msg.portfolio).toBe("main");
    expect(msg.data.positions).toHaveLength(1);
    expect(msg.data.positions[0].position_id).toBe("pos-1");
  });

  it("pushOrderUpdate broadcasts correct type", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    ws.pushOrderUpdate({ order_id: "o1", status: "filled" } as never);

    const msg = JSON.parse(client.sent[0]!);
    expect(msg.type).toBe("order_update");
    expect(msg.data.order_id).toBe("o1");
  });

  it("pushSystemHalt broadcasts halt reason", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    ws.pushSystemHalt("max drawdown");

    const msg = JSON.parse(client.sent[0]!);
    expect(msg.type).toBe("system_halt");
    expect(msg.data.reason).toBe("max drawdown");
  });

  it("skips closed clients", () => {
    const client = mockClient();
    client.readyState = 3; // CLOSED
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    ws.pushAlert({ type: "test", message: "hi" });
    expect(client.sent).toHaveLength(0);
  });

  it("close() clears all clients", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    expect(ws.clientCount()).toBe(1);
    ws.close();
    expect(ws.clientCount()).toBe(0);
  });

  it("pushPositionExitRule broadcasts position_exit_rule event", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    ws.pushPositionExitRule({
      position_id: "pos-1",
      rule: "stop_loss",
      closing_intent_id: "intent-abc",
      strategy_id: "alpha",
    });

    expect(client.sent).toHaveLength(1);
    const msg = JSON.parse(client.sent[0]!);
    expect(msg.type).toBe("position_exit_rule");
    expect(msg.data.position_id).toBe("pos-1");
    expect(msg.data.rule).toBe("stop_loss");
    expect(msg.data.closing_intent_id).toBe("intent-abc");
    expect(msg.data.strategy_id).toBe("alpha");
  });

  it("pushWorkspaceLayouts broadcasts workspace_layout config", () => {
    const client = mockClient();
    const ws = createStateWebSocket(server, logger, mockWsServerFactory(client));
    ws.pushWorkspaceLayouts({
      version: 1,
      layouts: { operate: { rows: "1fr 1fr", cols: "320px 1fr" } },
    });

    expect(client.sent).toHaveLength(1);
    const msg = JSON.parse(client.sent[0]!);
    expect(msg.type).toBe("workspace_layout");
    expect(msg.data.layouts.operate).toEqual({ rows: "1fr 1fr", cols: "320px 1fr" });
  });
});
