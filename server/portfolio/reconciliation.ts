// ── Position Reconciliation ────────────────────────────────────────
// Periodic diff of internal positions against broker positions.
// Defined in: docs/tdd/portfolio-risk-engine.md, §4

import type { BrokerAdapter, BrokerPosition } from "../../src/types/order.js";
import type { ReconciliationResult, DriftRecord } from "../../src/types/portfolio.js";
import type { PortfolioEngine } from "./engine.js";
import type { Logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────

interface ReconciliationConfig {
  interval_seconds: number;
  halt_on_drift: boolean;
}

// ── Reconciliation ─────────────────────────────────────────────────

export function reconcile(
  engine: PortfolioEngine,
  portfolioId: string,
  brokerPositions: BrokerPosition[],
): ReconciliationResult {
  const state = engine.getState(portfolioId);
  const drifts: DriftRecord[] = [];

  // Build maps for comparison
  const internalMap = new Map<string, number>();
  for (const pos of state.positions) {
    const key = `${pos.symbol}:${pos.direction}`;
    internalMap.set(key, (internalMap.get(key) ?? 0) + pos.quantity);
  }

  const brokerMap = new Map<string, number>();
  for (const pos of brokerPositions) {
    const key = `${pos.symbol}:${pos.direction}`;
    brokerMap.set(key, (brokerMap.get(key) ?? 0) + pos.quantity);
  }

  // Check internal positions against broker
  for (const [key, internalQty] of internalMap) {
    const brokerQty = brokerMap.get(key) ?? 0;
    if (internalQty !== brokerQty) {
      const [symbol] = key.split(":");
      drifts.push({
        type: brokerQty === 0 ? "missing_at_broker" : "quantity_mismatch",
        symbol: symbol!,
        internal_qty: internalQty,
        broker_qty: brokerQty,
      });
    }
    brokerMap.delete(key);
  }

  // Check broker positions not in internal
  for (const [key, brokerQty] of brokerMap) {
    const [symbol] = key.split(":");
    drifts.push({
      type: "missing_internally",
      symbol: symbol!,
      internal_qty: 0,
      broker_qty: brokerQty,
    });
  }

  return { match: drifts.length === 0, drifts };
}

// ── Reconciliation Loop ────────────────────────────────────────────

export function startReconciliation(
  engine: PortfolioEngine,
  portfolioId: string,
  broker: BrokerAdapter,
  config: ReconciliationConfig,
  logger: Logger,
): { stop: () => void } {
  const intervalMs = config.interval_seconds * 1000;

  const timer = setInterval(async () => {
    try {
      const brokerPositions = await broker.getPositions();
      const result = reconcile(engine, portfolioId, brokerPositions);

      if (!result.match) {
        logger.warn("Reconciliation drift detected", {
          portfolioId,
          broker: broker.name,
          drifts: result.drifts,
        });

        if (config.halt_on_drift) {
          engine.halt(
            portfolioId,
            `Reconciliation drift: ${result.drifts.length} position(s) differ from broker`,
          );
        }
      }
    } catch (err) {
      logger.error("Reconciliation failed", {
        portfolioId,
        error: String(err),
      });
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
