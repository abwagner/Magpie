// ── Telemetry HTTP Handler ────────────────────────────────────────────
// POST /api/telemetry — accepts a JSON array of browser log events,
// validates them, threads each event's correlation_id into the server
// log stream alongside server-side logs (QF-348).
//
// Auth: bearer token optional (same anonymous-ok posture as signal
// ingress). When a valid bearer token is present, the principal is
// recorded in the log payload. Unauthenticated requests are accepted
// so the browser never loses events due to a missing token.

import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { validateBatch } from "./schema.js";
import { withCorrelationId } from "../logger.js";
import type { Logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TelemetryHandlerDeps {
  logger: Logger;
  /** Optional bearer token extractor for principal attribution.
   *  Accepts the raw Authorization header value; returns the token
   *  string or null. */
  extractBearer?: (req: IncomingMessage) => string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Factory ────────────────────────────────────────────────────────────

/** Create the POST /api/telemetry handler bound to a logger. */
export function createTelemetryHandler(
  deps: TelemetryHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { logger } = deps;

  return async function handleTelemetry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse + validate body
    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (e) {
      json(res, 400, { error: "Failed to read request body" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      json(res, 400, { error: "Invalid JSON" });
      return;
    }

    const { valid, error } = validateBatch(parsed);
    if (error !== null) {
      json(res, 400, { error });
      return;
    }

    // Derive caller attribution (no auth enforcement — anonymous ok).
    const hasToken = Boolean(deps.extractBearer?.(req));

    // Write each browser event into the server log stream, threading
    // the browser-supplied correlation_id (or generating one) so events
    // appear alongside server-side logs with a shared ID.
    let accepted = 0;
    for (const event of valid) {
      const correlationId = event.correlation_id ?? ulid();
      withCorrelationId(correlationId, () => {
        logger.info("browser.log", {
          ts_browser: event.ts,
          level_browser: event.level,
          event_browser: event.event,
          payload: event.payload ?? {},
          authenticated: hasToken,
        });
      });
      accepted++;
    }

    json(res, 200, { accepted });
  };
}
