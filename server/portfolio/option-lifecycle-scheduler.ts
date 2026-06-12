// ── Option Lifecycle Scheduler ──────────────────────────────────────
// Drives the OptionLifecycleSweeper off the trading calendar: fires the
// close-sweep at each exchange close and the open-sweep at each exchange
// open, then self-reschedules for the next session. Wired in
// server/index.ts boot. Per docs/tdd/portfolio-risk-engine.md §11.2.
//
// Kept calendar-driven (not a fixed setInterval) so half-days, holidays,
// and the exchange's local close/open time resolve through the Calendar
// API rather than wall-clock guesses.

import type { Calendar } from "../calendar/index.js";
import type { Logger } from "../logger.js";
import type { OptionLifecycleSweeper } from "./option-lifecycle-sweeper.js";
import type { Position } from "../../src/types/portfolio.js";

export interface SchedulerDeps {
  calendar: Calendar;
  logger: Logger;
  sweeper: OptionLifecycleSweeper;
  exchange: string;
  // Portfolios whose positions get swept each session.
  portfolioIds: () => string[];
  positionsFor: (portfolioId: string) => Position[];
  // Injectable for tests; default to the real timer + clock.
  now?: () => Date;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface OptionLifecycleScheduler {
  start(): void;
  stop(): void;
}

// node's setTimeout caps the delay at a 32-bit signed int (~24.8 days).
// Clamp longer waits and re-arm when the timer fires.
const MAX_DELAY_MS = 2_147_483_647;

export function createOptionLifecycleScheduler(
  deps: SchedulerDeps,
): OptionLifecycleScheduler {
  const { calendar, logger, sweeper, exchange, portfolioIds, positionsFor } = deps;
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));

  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function runSweep(trigger: "market_close" | "market_open"): Promise<void> {
    for (const portfolioId of portfolioIds()) {
      const positions = positionsFor(portfolioId);
      try {
        if (trigger === "market_close") {
          await sweeper.sweepAtMarketClose(portfolioId, positions);
        } else {
          await sweeper.sweepAtMarketOpen(portfolioId, positions);
        }
      } catch (err) {
        logger.error("option-lifecycle-scheduler: sweep failed", {
          portfolio: portfolioId,
          trigger,
          error: String(err),
        });
      }
    }
  }

  function armClose(): void {
    if (stopped) return;
    let target: Date;
    try {
      target = calendar.nextClose(exchange, now());
    } catch (err) {
      logger.error("option-lifecycle-scheduler: nextClose failed; sweeper inactive", {
        exchange,
        error: String(err),
      });
      return;
    }
    const delay = Math.max(0, target.getTime() - now().getTime());
    if (delay > MAX_DELAY_MS) {
      closeTimer = setTimer(armClose, MAX_DELAY_MS);
      return;
    }
    closeTimer = setTimer(() => {
      void runSweep("market_close").finally(() => armClose());
    }, delay);
    logger.info("option-lifecycle-scheduler: close-sweep armed", {
      exchange,
      at: target.toISOString(),
    });
  }

  function armOpen(): void {
    if (stopped) return;
    let target: Date;
    try {
      target = calendar.nextOpen(exchange, now());
    } catch (err) {
      logger.error("option-lifecycle-scheduler: nextOpen failed; open-sweep inactive", {
        exchange,
        error: String(err),
      });
      return;
    }
    const delay = Math.max(0, target.getTime() - now().getTime());
    if (delay > MAX_DELAY_MS) {
      openTimer = setTimer(armOpen, MAX_DELAY_MS);
      return;
    }
    openTimer = setTimer(() => {
      void runSweep("market_open").finally(() => armOpen());
    }, delay);
    logger.info("option-lifecycle-scheduler: open-sweep armed", {
      exchange,
      at: target.toISOString(),
    });
  }

  return {
    start(): void {
      stopped = false;
      armClose();
      armOpen();
    },
    stop(): void {
      stopped = true;
      if (closeTimer) clearTimer(closeTimer);
      if (openTimer) clearTimer(openTimer);
      closeTimer = null;
      openTimer = null;
    },
  };
}
