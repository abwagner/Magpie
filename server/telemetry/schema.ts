// ── Telemetry Schema ──────────────────────────────────────────────────
// Types and validation for browser-side log events forwarded to the
// server via POST /api/telemetry (QF-348).
//
// Log levels and schema mirror the common framework log schema at
// docs/tdd/observability.md §3, with browser-specific additions.

// ── Types ─────────────────────────────────────────────────────────────

export type TelemetryLevel = "trace" | "debug" | "info" | "warn" | "error";

/** A single browser log event as submitted by the client-side helper. */
export interface BrowserLogEvent {
  /** RFC 3339 UTC timestamp emitted by the browser. */
  ts: string;
  /** Severity level matching the framework log schema. */
  level: TelemetryLevel;
  /** Dot-namespaced event name, e.g. "order-ticket.submitted". */
  event: string;
  /** Browser-supplied correlation ID (ULID or UUID). When absent the
   *  server generates one for this event. */
  correlation_id?: string;
  /** Arbitrary event-specific payload (snake_case keys per §6.3). */
  payload?: Record<string, unknown>;
}

/** Request body: one or more events submitted as a JSON array. */
export type TelemetryBatch = BrowserLogEvent[];

// ── Validation ────────────────────────────────────────────────────────

const VALID_LEVELS = new Set<string>(["trace", "debug", "info", "warn", "error"]);

/** Validate a single raw event object. Returns an error string on
 *  failure, or `null` when the event is well-formed. */
export function validateEvent(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "event must be an object";
  }
  const e = raw as Record<string, unknown>;

  if (typeof e["ts"] !== "string" || e["ts"].length === 0) {
    return "event.ts must be a non-empty string";
  }
  if (typeof e["level"] !== "string" || !VALID_LEVELS.has(e["level"])) {
    return `event.level must be one of: ${[...VALID_LEVELS].join(", ")}`;
  }
  if (typeof e["event"] !== "string" || e["event"].length === 0) {
    return "event.event must be a non-empty string";
  }
  if (
    e["correlation_id"] !== undefined &&
    (typeof e["correlation_id"] !== "string" || e["correlation_id"].length === 0)
  ) {
    return "event.correlation_id must be a non-empty string when present";
  }
  if (
    e["payload"] !== undefined &&
    (typeof e["payload"] !== "object" || Array.isArray(e["payload"]))
  ) {
    return "event.payload must be an object when present";
  }
  return null;
}

/** Validate a raw request body as a TelemetryBatch. Returns a tuple of
 *  [validEvents, errors]. When `errors` is non-empty the caller should
 *  reject the whole request. */
export function validateBatch(raw: unknown): { valid: BrowserLogEvent[]; error: string | null } {
  if (!Array.isArray(raw)) {
    return { valid: [], error: "request body must be a JSON array" };
  }
  if (raw.length === 0) {
    return { valid: [], error: "batch must contain at least one event" };
  }
  if (raw.length > 200) {
    return { valid: [], error: "batch exceeds maximum size of 200 events" };
  }

  const valid: BrowserLogEvent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const err = validateEvent(raw[i]);
    if (err !== null) {
      return { valid: [], error: `event[${i}]: ${err}` };
    }
    valid.push(raw[i] as BrowserLogEvent);
  }
  return { valid, error: null };
}
