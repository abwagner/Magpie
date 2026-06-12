// QF-309 — option lifecycle scheduler: fires close/open sweeps off the
// trading calendar and self-reschedules. Uses injectable timers + clock.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "../logger.js";
import type { Calendar } from "../calendar/index.js";
import type { OptionLifecycleSweeper } from "./option-lifecycle-sweeper.js";
import { createOptionLifecycleScheduler } from "./option-lifecycle-scheduler.js";

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

interface FakeTimer {
  cb: () => void;
  ms: number;
}

function setup(opts: { nextCloseThrows?: boolean } = {}) {
  const NOW = new Date("2026-05-16T12:00:00Z");
  const timers: FakeTimer[] = [];
  const sweepCalls: string[] = [];

  const sweeper: OptionLifecycleSweeper = {
    sweepAtMarketClose: vi.fn(async () => {
      sweepCalls.push("close");
    }),
    sweepAtMarketOpen: vi.fn(async () => {
      sweepCalls.push("open");
    }),
  };

  const calendar = {
    nextClose: vi.fn((_ex: string, from: Date) => {
      if (opts.nextCloseThrows) throw new Error("no trading day");
      return new Date(from.getTime() + 4 * 3_600_000); // +4h
    }),
    nextOpen: vi.fn((_ex: string, from: Date) => new Date(from.getTime() + 20 * 3_600_000)),
    isMarketOpen: vi.fn(),
    isTradingDay: vi.fn(),
    tradingDaysBetween: vi.fn(),
    hoursSinceLastClose: vi.fn(),
  } as unknown as Calendar;

  const scheduler = createOptionLifecycleScheduler({
    calendar,
    logger: mockLogger,
    sweeper,
    exchange: "US_EQUITY",
    portfolioIds: () => ["main"],
    positionsFor: () => [],
    now: () => NOW,
    setTimer: (cb, ms) => {
      const t = { cb, ms };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });

  return { scheduler, timers, sweepCalls, calendar, sweeper };
}

describe("option-lifecycle-scheduler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("arms both a close timer and an open timer on start", () => {
    const { scheduler, timers, calendar } = setup();
    scheduler.start();
    expect(calendar.nextClose).toHaveBeenCalledTimes(1);
    expect(calendar.nextOpen).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(2);
    // close at +4h, open at +20h.
    expect(timers[0]!.ms).toBe(4 * 3_600_000);
    expect(timers[1]!.ms).toBe(20 * 3_600_000);
  });

  it("runs the close-sweep and re-arms when the close timer fires", async () => {
    const { scheduler, timers, sweepCalls, sweeper } = setup();
    scheduler.start();
    // Fire the close timer.
    timers[0]!.cb();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(sweeper.sweepAtMarketClose).toHaveBeenCalledWith("main", []);
    expect(sweepCalls).toContain("close");
    // Re-armed: a new close timer was scheduled.
    expect(timers.length).toBeGreaterThan(2);
  });

  it("does not throw and logs an error when nextClose fails", () => {
    const { scheduler } = setup({ nextCloseThrows: true });
    expect(() => scheduler.start()).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "option-lifecycle-scheduler: nextClose failed; sweeper inactive",
      expect.any(Object),
    );
  });

  it("stop() prevents further arming", () => {
    const { scheduler, timers } = setup();
    scheduler.start();
    scheduler.stop();
    const before = timers.length;
    timers[0]!.cb(); // fire close — finally() calls armClose, but stopped
    expect(timers.length).toBe(before);
  });
});
