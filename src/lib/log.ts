// ── Client-side logger + telemetry forwarder ──────────────────────────
// Replaces src/lib/log.js (QF-348). Drop-in replacement — same
// `log(level, msg)` + `useLog()` surface; adds batched forwarding of
// events to POST /api/telemetry so browser-side logs are aggregated
// alongside server-side logs.
//
// Correlation ID: a ULID is generated once per page session and
// attached to every forwarded event so the full browser-session
// timeline can be reconstructed via a single correlation_id query.

import { useState, useEffect } from "react";

// ── Types ──────────────────────────────────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

// ── Telemetry batch event shape ────────────────────────────────────────

interface TelemetryEvent {
  ts: string;
  level: LogLevel;
  event: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}

// ── Session correlation ID ─────────────────────────────────────────────
// Lightweight ULID-style monotonic ID: timestamp prefix + random suffix.
// Stays within the 26-char crockford-base32 envelope the framework uses.

function generateSessionId(): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const now = Date.now();
  // 10-char time component (48-bit ms, base32)
  let t = now;
  let timeStr = "";
  for (let i = 0; i < 10; i++) {
    timeStr = (chars[t & 31] ?? "0") + timeStr;
    t = Math.floor(t / 32);
  }
  // 16-char random component
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr += chars[Math.floor(Math.random() * 32)] ?? "0";
  }
  return timeStr + randStr;
}

const SESSION_CORRELATION_ID = generateSessionId();

// ── In-memory ring buffer + listeners ────────────────────────────────

const _listeners = new Set<(entries: LogEntry[]) => void>();
const _entries: LogEntry[] = [];

// ── Telemetry forwarding queue ────────────────────────────────────────

const TELEMETRY_ENDPOINT = "/api/telemetry";
const FLUSH_INTERVAL_MS = 3000;
const MAX_QUEUE = 200;

const _queue: TelemetryEvent[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTelemetryFlush(): void {
  if (_flushTimer !== null) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void flushTelemetry();
  }, FLUSH_INTERVAL_MS);
}

async function flushTelemetry(): Promise<void> {
  if (_queue.length === 0) return;
  const batch = _queue.splice(0, _queue.length);
  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      // keepalive allows the request to outlive page unload
      keepalive: true,
    });
  } catch {
    // Network failure — drop silently rather than spamming console.
    // In production a retry queue or navigator.sendBeacon could be
    // used; for now dropping is preferable to creating infinite loops.
  }
}

// ── Public API ────────────────────────────────────────────────────────

export const log = (level: LogLevel, msg: string): void => {
  const ts = Date.now();
  const entry: LogEntry = { ts, level, msg };
  _entries.push(entry);
  if (_entries.length > 500) _entries.shift();
  _listeners.forEach((fn) => fn([..._entries]));

  // Forward to server telemetry stream (skip trace in production to
  // keep credit usage down; trace is kept in the ring buffer).
  if (level !== "trace") {
    if (_queue.length < MAX_QUEUE) {
      _queue.push({
        ts: new Date(ts).toISOString().replace("Z", "000Z"),
        level,
        event: `browser.${level}`,
        correlation_id: SESSION_CORRELATION_ID,
        payload: { message: msg },
      });
    }
    scheduleTelemetryFlush();
  }

  // Mirror to devtools console as before.
  if (level === "error") console.error(`[Magpie] ${msg}`);
  else if (level === "warn") console.warn(`[Magpie] ${msg}`);
  else console.log(`[Magpie] ${msg}`);
};

export function useLog(): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>(() => [..._entries]);
  useEffect(() => {
    _listeners.add(setEntries);
    return () => {
      _listeners.delete(setEntries);
    };
  }, []);
  return entries;
}

// ── Exported for testing ──────────────────────────────────────────────

export { SESSION_CORRELATION_ID };
