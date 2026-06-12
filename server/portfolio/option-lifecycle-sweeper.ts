// ── Option Lifecycle Sweeper ────────────────────────────────────────
// Periodic timer that detects positions whose expiration <= today at
// market close or market open. Classifies each as:
// - Expired worthless → settle the position directly (no OrderIntent
//   through OPL — there is no order to submit, the option simply ceases
//   to exist) and write the audit chain rows.
// - Assigned/exercised → do NOT settle here; the broker's assignment push
//   on broker.events.<broker> drives the ledger mutation (§11.3). The
//   classification is informational only (flags expected assignments so
//   a stale-bridge state surfaces as a missing-push alert).
//
// Runs at market close + market open per docs/tdd/portfolio-risk-engine.md §11.2

import type { Position } from "../../src/types/portfolio.js";
import type { Logger } from "../logger.js";
import type { Calendar } from "../calendar/index.js";
import type { PortfolioEngine } from "./engine.js";
import { buildIntentRow, type AuditIntentWriter } from "../order/audit-intent.js";
import { buildNtNativeOrderRow, type AuditOrderWriter } from "../order/audit-orders.js";
import { canonicalToUnderlying } from "../symbols/convert.js";
import { ulid } from "ulid";

// ── Classification Result ──────────────────────────────────────────

export type ExpiryClassification =
  | { type: "expired_worthless" }
  | { type: "auto_exercised" }
  | { type: "assigned" }
  | { type: "late_sweep" };

export interface SweeperDeps {
  calendar: Calendar;
  logger: Logger;
  engine: PortfolioEngine;
  auditIntentWriter: AuditIntentWriter;
  auditOrderWriter: AuditOrderWriter;
  // Broker the worthless-expiry audit rows are attributed to. The expiry
  // itself isn't broker-driven, but audit_orders.broker is NOT NULL, so we
  // tag it with the portfolio's configured broker.
  broker: string;
  // Spot resolver for a position's underlying at close. Returns null when
  // the engine has no recent quote (position is then left for the open
  // sweep / reconciliation rather than mis-classified).
  spotFor: (portfolioId: string, position: Position) => number | null;
}

// ── Classifier ─────────────────────────────────────────────────────

const TOLERANCE = 0.01; // $0.01 tolerance for close-of-day spot ticks

export function classifyExpiry(
  position: Position,
  closeSpot: number,
  today: string,
): ExpiryClassification {
  const expiration = expirationOf(position);
  if (!expiration || expiration > today) {
    // Not expiring today.
    return { type: "expired_worthless" };
  }

  if (expiration < today) {
    // Should have been handled at close; log as recovery.
    return { type: "late_sweep" };
  }

  // At this point: position.expiration === today. Classify based on spot.
  const isCall = position.symbol.includes(":C:");
  const isPut = position.symbol.includes(":P:");
  const isLong = position.direction === "Long";
  const strike = extractStrike(position.symbol);

  if (strike === null) {
    // Invalid symbol; treat as expired worthless to be safe.
    return { type: "expired_worthless" };
  }

  if (isCall && isLong && closeSpot >= strike + TOLERANCE) {
    return { type: "auto_exercised" };
  }
  if (isCall && !isLong && closeSpot >= strike - TOLERANCE) {
    return { type: "assigned" };
  }
  if (isPut && isLong && closeSpot <= strike - TOLERANCE) {
    return { type: "auto_exercised" };
  }
  if (isPut && !isLong && closeSpot <= strike + TOLERANCE) {
    return { type: "assigned" };
  }

  return { type: "expired_worthless" };
}

// ── Helpers ────────────────────────────────────────────────────────

function extractStrike(symbol: string): number | null {
  // Symbol format: OPT:SPY:2026-05-16:C:500
  const parts = symbol.split(":");
  if (parts.length < 5) return null;
  const strike = parseFloat(parts[4] ?? "");
  return isNaN(strike) ? null : strike;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0] ?? "";
}

function isOption(position: Position): boolean {
  return position.symbol.startsWith("OPT:") || position.symbol.startsWith("FOP:");
}

// Expiration is carried on Position.expiration when the projector
// populates it, but the canonical option symbol also encodes it
// (OPT:<root>:<YYYY-MM-DD>:<C|P>:<strike>). Fall back to the symbol so a
// projector that omits the field doesn't silently skip an expired option.
function expirationOf(position: Position): string | null {
  if (position.expiration) return position.expiration;
  const parts = position.symbol.split(":");
  const candidate = parts[2];
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

// ── Sweeper ────────────────────────────────────────────────────────

export interface OptionLifecycleSweeper {
  sweepAtMarketClose(portfolioId: string, positions: Position[]): Promise<void>;
  sweepAtMarketOpen(portfolioId: string, positions: Position[]): Promise<void>;
}

export function createOptionLifecycleSweeper(deps: SweeperDeps): OptionLifecycleSweeper {
  const { logger, engine, auditIntentWriter, auditOrderWriter, broker, spotFor } = deps;

  // Settle a worthless expiry: audit_intents (source=qf, the FK parent) →
  // audit_orders (status=expired, source=qf) → ledger mutation. The
  // correlation_id threads the chain so the audit trail joins back.
  async function settleWorthless(portfolioId: string, pos: Position): Promise<void> {
    const correlationId = ulid();
    const intentId = ulid();
    const orderId = ulid();
    const asof = new Date().toISOString();

    await auditIntentWriter(
      buildIntentRow({
        intent_id: intentId,
        signal_ids: [],
        portfolio: portfolioId,
        symbol: pos.symbol,
        // Closing direction is the inverse of the held position.
        direction: pos.direction === "Long" ? "Sell" : "Buy",
        quantity: pos.quantity,
        strategy_id: pos.strategy_id ?? "__operator__",
        created_at: asof,
        source: "qf",
        correlation_id: correlationId,
      }),
    );

    // buildNtNativeOrderRow stamps source='nt-native' and sets a terminal
    // completed_at for filled/rejected; for a calendar-driven worthless
    // expiry the chain is qf-owned (not a broker push) and 'expired' is
    // already terminal. Override source + completed_at after the build.
    const orderRow = buildNtNativeOrderRow({
      order_id: orderId,
      intent_id: intentId,
      broker,
      status: "expired",
      created_at: asof,
      broker_order_id: "",
      correlation_id: correlationId,
    });
    orderRow.source = "qf";
    orderRow.completed_at = asof;
    await auditOrderWriter(orderRow);

    // Worthless expiry: option closes at 0, cash settlement only (the
    // premium is already in cash from entry; realized P&L crystallizes).
    engine.settleLifecycle(portfolioId, {
      option_symbol: pos.symbol,
      kind: "expired",
      option_close_price: 0,
      settlement_type: "cash",
      cash_delta: 0,
      asof,
      ...(pos.strategy_id !== undefined ? { strategy_id: pos.strategy_id } : {}),
    });

    logger.info("option-lifecycle-sweeper: settled worthless expiry", {
      portfolio: portfolioId,
      position_id: pos.position_id,
      symbol: pos.symbol,
      correlation_id: correlationId,
    });
  }

  return {
    async sweepAtMarketClose(portfolioId: string, positions: Position[]): Promise<void> {
      const today = formatDate(new Date());

      for (const pos of positions) {
        if (!isOption(pos)) continue;
        const expiration = expirationOf(pos);
        if (!expiration || expiration > today) continue;

        const spot = spotFor(portfolioId, pos);
        if (spot === null) {
          logger.warn("option-lifecycle-sweeper: no spot for expiring option; deferring to open", {
            portfolio: portfolioId,
            position_id: pos.position_id,
            symbol: pos.symbol,
          });
          continue;
        }

        const classification = classifyExpiry(pos, spot, today);

        if (classification.type === "expired_worthless") {
          try {
            await settleWorthless(portfolioId, pos);
          } catch (err) {
            logger.error("option-lifecycle-sweeper: worthless settlement failed", {
              portfolio: portfolioId,
              position_id: pos.position_id,
              error: String(err),
            });
          }
        } else if (classification.type === "late_sweep") {
          logger.warn("option-lifecycle-sweeper: late sweep (expiry < today)", {
            portfolio: portfolioId,
            position_id: pos.position_id,
            symbol: pos.symbol,
            expiration,
          });
        } else {
          // auto_exercised or assigned — broker push drives the mutation.
          logger.info("option-lifecycle-sweeper: expecting assignment push", {
            portfolio: portfolioId,
            position_id: pos.position_id,
            symbol: pos.symbol,
            classification: classification.type,
            underlying: canonicalToUnderlying(pos.symbol),
          });
        }
      }
    },

    async sweepAtMarketOpen(portfolioId: string, positions: Position[]): Promise<void> {
      const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

      for (const pos of positions) {
        if (!isOption(pos)) continue;
        const expiration = expirationOf(pos);
        if (!expiration || expiration > yesterday) continue;

        // Still open at the open after an expiry the close-sweep should have
        // handled. Covers AM-settled index options + close-sweep skips
        // (spot uncertain). Classify and either settle worthless or alert.
        const spot = spotFor(portfolioId, pos);
        const classification =
          spot === null ? null : classifyExpiry(pos, spot, formatDate(new Date()));

        if (classification?.type === "expired_worthless") {
          logger.warn("option-lifecycle-sweeper: settling worthless at open (recovery)", {
            portfolio: portfolioId,
            position_id: pos.position_id,
            symbol: pos.symbol,
          });
          try {
            await settleWorthless(portfolioId, pos);
          } catch (err) {
            logger.error("option-lifecycle-sweeper: recovery settlement failed", {
              portfolio: portfolioId,
              position_id: pos.position_id,
              error: String(err),
            });
          }
        } else {
          // Predicted assignment without a broker push — §11.7 alert.
          logger.warn("option-lifecycle-sweeper: expired option unsettled at open", {
            portfolio: portfolioId,
            position_id: pos.position_id,
            symbol: pos.symbol,
            expiration,
            alert: "option_assignment_missing_alert",
          });
        }
      }
    },
  };
}
