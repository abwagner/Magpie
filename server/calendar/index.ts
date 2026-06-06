// ── Market Calendar ────────────────────────────────────────────────
// Answers market-hours questions for any configured exchange.
// Backed by config/market-calendar.json (static, updated yearly).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

interface ExchangeHours {
  open: string; // "HH:MM"
  close: string; // "HH:MM"
  tz: string; // IANA timezone
}

interface ExchangeConfig {
  regular_hours: ExchangeHours;
  half_days: string[]; // ISO date strings
  half_day_close: string; // "HH:MM"
  holidays: string[]; // ISO date strings
  note?: string;
}

interface CalendarConfig {
  exchanges: Record<string, ExchangeConfig>;
}

export interface Calendar {
  isMarketOpen(exchange: string, timestamp: Date): boolean;
  nextOpen(exchange: string, timestamp: Date): Date;
  nextClose(exchange: string, timestamp: Date): Date;
  isTradingDay(exchange: string, date: Date): boolean;
  tradingDaysBetween(exchange: string, from: Date, to: Date): string[];
  hoursSinceLastClose(exchange: string, now?: Date): number;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseHHMM(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(":").map(Number);
  return { hours: h!, minutes: m! };
}

function toExchangeDate(timestamp: Date, tz: string): string {
  return timestamp.toLocaleDateString("en-CA", { timeZone: tz });
}

function toExchangeTime(timestamp: Date, tz: string): { hours: number; minutes: number } {
  const parts = timestamp.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false });
  const [h, m] = parts.split(":").map(Number);
  return { hours: h!, minutes: m! };
}

function dateInTz(isoDate: string, hhmm: string, tz: string): Date {
  const { hours, minutes } = parseHHMM(hhmm);
  const dateStr = `${isoDate}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Build a UTC date then adjust for timezone offset
  const naive = new Date(dateStr + "Z");
  const targetParts = formatter.formatToParts(naive);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(targetParts.find((p) => p.type === type)?.value ?? 0);

  const actualInTz = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")),
  );
  const offsetMs = actualInTz.getTime() - naive.getTime();
  return new Date(naive.getTime() - offsetMs);
}

function isWeekend(date: Date, tz: string): boolean {
  const day = new Date(toExchangeDate(date, tz) + "T12:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Factory ────────────────────────────────────────────────────────

export function createCalendar(config: CalendarConfig): Calendar {
  const holidaysSets: Record<string, Set<string>> = {};
  const halfDaysSets: Record<string, Set<string>> = {};

  for (const [name, exc] of Object.entries(config.exchanges)) {
    holidaysSets[name] = new Set(exc.holidays);
    halfDaysSets[name] = new Set(exc.half_days);
  }

  function getExchange(exchange: string): ExchangeConfig {
    const exc = config.exchanges[exchange];
    if (!exc) {
      throw new Error(`Unknown exchange: ${exchange}`);
    }
    return exc;
  }

  function isTradingDay(exchange: string, date: Date): boolean {
    const exc = getExchange(exchange);
    const isoDate = toExchangeDate(date, exc.regular_hours.tz);
    if (isWeekend(date, exc.regular_hours.tz)) return false;
    if (holidaysSets[exchange]!.has(isoDate)) return false;
    return true;
  }

  function getCloseTime(exchange: string, isoDate: string): string {
    const exc = getExchange(exchange);
    if (halfDaysSets[exchange]!.has(isoDate)) {
      return exc.half_day_close;
    }
    return exc.regular_hours.close;
  }

  function isMarketOpen(exchange: string, timestamp: Date): boolean {
    const exc = getExchange(exchange);
    const tz = exc.regular_hours.tz;
    const isoDate = toExchangeDate(timestamp, tz);

    if (!isTradingDay(exchange, timestamp)) return false;

    const time = toExchangeTime(timestamp, tz);
    const open = parseHHMM(exc.regular_hours.open);
    const close = parseHHMM(getCloseTime(exchange, isoDate));

    const nowMin = time.hours * 60 + time.minutes;
    const openMin = open.hours * 60 + open.minutes;
    const closeMin = close.hours * 60 + close.minutes;

    if (openMin < closeMin) {
      // Normal session (e.g., 09:30–16:00)
      return nowMin >= openMin && nowMin < closeMin;
    } else {
      // Overnight session (e.g., CME 17:00–16:00)
      return nowMin >= openMin || nowMin < closeMin;
    }
  }

  function nextOpen(exchange: string, timestamp: Date): Date {
    const exc = getExchange(exchange);
    const tz = exc.regular_hours.tz;
    let isoDate = toExchangeDate(timestamp, tz);

    // If currently before today's open and today is a trading day, return today's open
    if (isTradingDay(exchange, timestamp)) {
      const time = toExchangeTime(timestamp, tz);
      const open = parseHHMM(exc.regular_hours.open);
      const nowMin = time.hours * 60 + time.minutes;
      const openMin = open.hours * 60 + open.minutes;
      if (nowMin < openMin) {
        return dateInTz(isoDate, exc.regular_hours.open, tz);
      }
    }

    // Find next trading day
    for (let i = 0; i < 14; i++) {
      isoDate = addDays(isoDate, 1);
      const candidate = new Date(isoDate + "T12:00:00Z");
      if (isTradingDay(exchange, candidate)) {
        return dateInTz(isoDate, exc.regular_hours.open, tz);
      }
    }

    throw new Error(`No trading day found within 14 days for ${exchange}`);
  }

  function nextClose(exchange: string, timestamp: Date): Date {
    const exc = getExchange(exchange);
    const tz = exc.regular_hours.tz;
    const isoDate = toExchangeDate(timestamp, tz);

    // If market is currently open, return today's close
    if (isMarketOpen(exchange, timestamp)) {
      const closeTime = getCloseTime(exchange, isoDate);
      const close = parseHHMM(closeTime);
      const open = parseHHMM(exc.regular_hours.open);

      if (open.hours * 60 + open.minutes < close.hours * 60 + close.minutes) {
        // Normal session — close is today
        return dateInTz(isoDate, closeTime, tz);
      } else {
        // Overnight session — close is tomorrow
        const time = toExchangeTime(timestamp, tz);
        const nowMin = time.hours * 60 + time.minutes;
        const closeMin = close.hours * 60 + close.minutes;
        if (nowMin < closeMin) {
          return dateInTz(isoDate, closeTime, tz);
        }
        return dateInTz(addDays(isoDate, 1), closeTime, tz);
      }
    }

    // Market is closed — find next trading day's close
    const openDate = nextOpen(exchange, timestamp);
    return nextClose(exchange, openDate);
  }

  function tradingDaysBetween(exchange: string, from: Date, to: Date): string[] {
    const exc = getExchange(exchange);
    const tz = exc.regular_hours.tz;
    const days: string[] = [];
    let current = toExchangeDate(from, tz);
    const end = toExchangeDate(to, tz);

    while (current <= end) {
      const candidate = new Date(current + "T12:00:00Z");
      if (isTradingDay(exchange, candidate)) {
        days.push(current);
      }
      current = addDays(current, 1);
    }

    return days;
  }

  function hoursSinceLastClose(exchange: string, now: Date = new Date()): number {
    const exc = getExchange(exchange);
    const tz = exc.regular_hours.tz;

    // Walk backwards up to 14 days to find the most recent trading day
    // whose close time is <= now.
    let isoDate = toExchangeDate(now, tz);
    for (let i = 0; i < 14; i++) {
      const candidate = new Date(isoDate + "T12:00:00Z");
      if (isTradingDay(exchange, candidate)) {
        const closeTime = getCloseTime(exchange, isoDate);
        const closeDate = dateInTz(isoDate, closeTime, tz);
        if (closeDate.getTime() <= now.getTime()) {
          return (now.getTime() - closeDate.getTime()) / 3_600_000;
        }
      }
      isoDate = addDays(isoDate, -1);
    }

    return Infinity;
  }

  return {
    isMarketOpen,
    nextOpen,
    nextClose,
    isTradingDay,
    tradingDaysBetween,
    hoursSinceLastClose,
  };
}

// ── Convenience: load from default config path ─────────────────────

export function loadCalendar(configPath?: string): Calendar {
  const path = configPath ?? resolve(process.cwd(), "config/market-calendar.json");
  const raw = readFileSync(path, "utf-8");
  const config: CalendarConfig = JSON.parse(raw);
  return createCalendar(config);
}
