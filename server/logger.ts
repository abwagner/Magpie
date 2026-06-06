// ── Structured Logger ──────────────────────────────────────────────
// Emits JSON conforming to the common log schema in
// docs/tdd/observability.md §3. Propagates a correlation ID via
// AsyncLocalStorage so it survives across `await` boundaries — match
// the Python helper's ContextVar behaviour and the Rust helper's
// thread-local (sync-only) backing.
//
// Pretty/colored output for dev (human-scannable); JSON for production
// (machine-parseable). Mode controlled by LOG_FORMAT=pretty|json
// (default: pretty when stdout is a TTY, json otherwise).
//
// Optional file transport: set LOG_FILE=/path/to/server.log to append
// newline-delimited JSON in addition to stdout/stderr.
//
// Caller API is unchanged from the pre-framework logger:
//
//     const log = createLogger("signal-ingress");
//     log.info("signal.received", { signal_id, model_id });
//     await withCorrelationId(req.headers["x-correlation-id"] ?? newUlid(), async () => {
//       log.info("event.name", { fields });  // correlation_id is auto-attached
//     });
//
// Only the *output JSON shape* changed. The first positional argument
// becomes the `event` field; the second-argument fields are bundled
// under `payload`. The `service` argument to createLogger names the
// emitting component. Existing call sites (logger.info / warn / error
// with a string + fields object) keep working unmodified.

import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

// ── Correlation-ID propagation (AsyncLocalStorage) ─────────────────

const correlationIdStorage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `correlationId` bound on the current async context.
 * Restores the prior value (if any) on return. Survives `await` boundaries.
 *
 * Use at every external entry point (HTTP handler, NATS subscriber,
 * scheduled job) per docs/tdd/observability.md §4.3. Outbound calls
 * (NATS publish, HTTP fetch) should read the current value via
 * `currentCorrelationId()` and propagate it on the wire.
 */
export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationIdStorage.run(correlationId, fn);
}

/**
 * Read the correlation ID bound by an enclosing `withCorrelationId`,
 * or `undefined` if none is active.
 */
export function currentCorrelationId(): string | undefined {
  return correlationIdStorage.getStore();
}

// ── Levels ─────────────────────────────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// ── JSON entry schema ──────────────────────────────────────────────

interface LogEntry {
  ts: string;
  level: LogLevel;
  service: string;
  correlation_id?: string;
  event: string;
  payload: Record<string, unknown>;
  error?: Record<string, unknown>;
}

// ── Output formatting / transports ─────────────────────────────────

const FORMAT_ENV = (process.env.LOG_FORMAT ?? "").toLowerCase();
const PRETTY =
  FORMAT_ENV === "pretty" || (FORMAT_ENV !== "json" && process.env.NODE_ENV !== "production");
const COLOR = PRETTY && (process.stdout.isTTY || process.env.FORCE_COLOR === "1");

let fileStream: WriteStream | null = null;
let fileStreamInitialized = false;

function getFileStream(): WriteStream | null {
  if (fileStreamInitialized) return fileStream;
  fileStreamInitialized = true;
  const logFile = process.env.LOG_FILE;
  if (!logFile) return null;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    fileStream = createWriteStream(logFile, { flags: "a" });
    fileStream.on("error", (err) => {
      process.stderr.write(`[logger] file transport error: ${err.message}\n`);
    });
  } catch (err) {
    process.stderr.write(`[logger] failed to open LOG_FILE: ${String(err)}\n`);
    fileStream = null;
  }
  return fileStream;
}

const C = COLOR
  ? {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      magenta: "\x1b[35m",
      cyan: "\x1b[36m",
    }
  : {
      reset: "",
      dim: "",
      red: "",
      green: "",
      yellow: "",
      blue: "",
      magenta: "",
      cyan: "",
    };

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: C.dim,
  debug: C.dim,
  info: C.green,
  warn: C.yellow,
  error: C.red,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

function formatField(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") {
    return value.includes(" ") || value.includes("\n") ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function prettyFormat(entry: LogEntry): string {
  const time = entry.ts.slice(11, 19);
  const lvl = `${LEVEL_COLOR[entry.level]}${LEVEL_LABEL[entry.level]}${C.reset}`;
  const svc = `${C.cyan}${entry.service}${C.reset}`;
  const cid = entry.correlation_id
    ? ` ${C.dim}[${entry.correlation_id.slice(0, 10)}]${C.reset}`
    : "";

  const fieldStrs: string[] = [];
  for (const [k, v] of Object.entries(entry.payload)) {
    fieldStrs.push(`${C.dim}${k}=${C.reset}${formatField(v)}`);
  }
  const fields = fieldStrs.length > 0 ? "  " + fieldStrs.join(" ") : "";

  return `${C.dim}${time}${C.reset} ${lvl} ${svc}${cid} ${entry.event}${fields}`;
}

// RFC 3339 UTC with microsecond precision. Node's Date only has
// millisecond resolution; pad with three zeros to match the Rust and
// Python harnesses' wire format ("...123456Z"). Operators reading the
// timestamp won't notice; the byte-for-byte parity test does.
function nowRfc3339Micros(): string {
  return new Date().toISOString().replace("Z", "000Z");
}

// ── Public factory ─────────────────────────────────────────────────

export interface Logger {
  trace(event: string, payload?: Record<string, unknown>): void;
  debug(event: string, payload?: Record<string, unknown>): void;
  info(event: string, payload?: Record<string, unknown>): void;
  warn(event: string, payload?: Record<string, unknown>): void;
  error(event: string, payload?: Record<string, unknown>): void;
  child(suffix: string): Logger;
}

/**
 * Create a Logger bound to a kebab-case service name (e.g.
 * "signal-ingress", "portfolio-risk-engine"). One service per emitting
 * process per the framework spec.
 *
 * @param service - kebab-case service identifier
 * @param minLevel - minimum level to emit; defaults to "info"
 */
export function createLogger(service: string, minLevel: LogLevel = "info"): Logger {
  const minPriority = LEVEL_PRIORITY[minLevel];

  function emit(level: LogLevel, event: string, payload?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    // Build the entry with framework field order: ts, level, service,
    // correlation_id (if set), event, payload. Object property iteration
    // order in V8 follows insertion order for string keys, so a literal
    // built in this order JSON.stringifies in this order — that's what
    // the parity test relies on.
    const cid = currentCorrelationId();
    const entry: LogEntry =
      cid !== undefined
        ? {
            ts: nowRfc3339Micros(),
            level,
            service,
            correlation_id: cid,
            event,
            payload: payload ?? {},
          }
        : {
            ts: nowRfc3339Micros(),
            level,
            service,
            event,
            payload: payload ?? {},
          };

    const line = PRETTY ? prettyFormat(entry) : JSON.stringify(entry);
    if (entry.level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
    const fs = getFileStream();
    if (fs) fs.write(JSON.stringify(entry) + "\n");
  }

  return {
    trace: (event, payload) => emit("trace", event, payload),
    debug: (event, payload) => emit("debug", event, payload),
    info: (event, payload) => emit("info", event, payload),
    warn: (event, payload) => emit("warn", event, payload),
    error: (event, payload) => emit("error", event, payload),
    child: (suffix) => createLogger(`${service}.${suffix}`, minLevel),
  };
}

/**
 * Create a Logger that routes ALL levels to stderr (not stdout).
 * Use this when stdout is reserved for a protocol channel (e.g. the
 * gate-evaluator-cli NDJSON wire, docs/tdd/backtest-gate.md §3.2).
 * The emitted JSON shape is identical to createLogger — only the
 * destination stream differs.
 *
 * @param service  - kebab-case service identifier
 * @param minLevel - minimum level to emit; defaults to "info"
 */
export function createStderrLogger(service: string, minLevel: LogLevel = "info"): Logger {
  const minPriority = LEVEL_PRIORITY[minLevel];

  function emit(level: LogLevel, event: string, payload?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const cid = currentCorrelationId();
    const entry: LogEntry =
      cid !== undefined
        ? {
            ts: nowRfc3339Micros(),
            level,
            service,
            correlation_id: cid,
            event,
            payload: payload ?? {},
          }
        : { ts: nowRfc3339Micros(), level, service, event, payload: payload ?? {} };

    const line = PRETTY ? prettyFormat(entry) : JSON.stringify(entry);
    process.stderr.write(line + "\n");
    const fs = getFileStream();
    if (fs) fs.write(JSON.stringify(entry) + "\n");
  }

  return {
    trace: (event, payload) => emit("trace", event, payload),
    debug: (event, payload) => emit("debug", event, payload),
    info: (event, payload) => emit("info", event, payload),
    warn: (event, payload) => emit("warn", event, payload),
    error: (event, payload) => emit("error", event, payload),
    child: (suffix) => createStderrLogger(`${service}.${suffix}`, minLevel),
  };
}
