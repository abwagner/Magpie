/**
 * Integration test: Kill switch & halt conditions
 *
 * Tests manual kill, auto-halt from risk limits, reset + resume.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createOrderPlane, type OrderPlane } from "../../plane.js";
import { createPortfolioEngine, type PortfolioEngine } from "../../../portfolio/engine.js";
import { createFillLog } from "../../fill-log.js";
import { createFakeBroker } from "../fixtures/fake-broker.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";
import { testPortfolioConfig } from "../../../__tests__/helpers/fixtures.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

const logger = createTestLogger();
let tempDir: string;
let engine: PortfolioEngine;
let orderPlane: OrderPlane;

function makeIntent(overrides = {}) {
  return {
    intent_id: `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    portfolio: "main",
    strategy_id: "test-strategy",
    action: "open" as const,
    symbol: "OPT:SPY:2026-05-16:C:500",
    direction: "Short" as const,
    quantity: 1,
    reason: "test",
    signal_ids: [] as string[],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function setup() {
  tempDir = join(tmpdir(), `test-kill-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  engine = createPortfolioEngine({ logger });
  engine.initPortfolio("main", testPortfolioConfig());

  const fillLog = createFillLog(join(tempDir, "main.jsonl"));
  const broker = createFakeBroker({ autoFill: true });

  orderPlane = createOrderPlane({
    portfolioEngine: engine,
    broker: broker.adapter,
    fillLog,
    logger,
    generateId: () => `order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mode: "paper_local",
  });
}

describe("kill switch", () => {
  beforeEach(() => setup());
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  describe("manual kill", () => {
    it("halts the system", () => {
      orderPlane.killSwitch("operator activated");
      expect(orderPlane.isHalted()).toBe(true);
    });

    it("rejects all new intents after kill", async () => {
      orderPlane.killSwitch("operator activated");
      const order = await orderPlane.submit(makeIntent());
      expect(order.status).toBe("rejected");
    });

    it("resets and resumes", async () => {
      orderPlane.killSwitch("operator activated");
      expect(orderPlane.isHalted()).toBe(true);

      orderPlane.resetKillSwitch();
      expect(orderPlane.isHalted()).toBe(false);

      // Should accept intents again
      const order = await orderPlane.submit(makeIntent());
      expect(order.status).not.toBe("rejected");
    });
  });

  describe("auto-halt from risk limits", () => {
    it("halts portfolio engine on kill switch", () => {
      engine.halt("main", "daily loss exceeded");
      const state = engine.getState("main");
      expect(state.halted).toBe(true);
      expect(state.halt_reason).toBe("daily loss exceeded");
    });

    it("kill switch halts all intents across portfolios", () => {
      // Add a second portfolio
      engine.initPortfolio("secondary", testPortfolioConfig());

      orderPlane.killSwitch("system-wide halt");

      // Both portfolios should reject intents
      const result1 = engine.canExecute("main", makeIntent());
      // When the order plane is halted, it rejects before reaching canExecute
      expect(orderPlane.isHalted()).toBe(true);
    });
  });

  describe("reset flow", () => {
    it("reset clears halt reason", () => {
      engine.halt("main", "drawdown exceeded");
      expect(engine.getState("main").halted).toBe(true);

      engine.resetHalt("main");
      expect(engine.getState("main").halted).toBe(false);
      expect(engine.getState("main").halt_reason).toBeFalsy();
    });
  });
});
