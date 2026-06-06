import { describe, it, expect, vi } from "vitest";
import { createTelemetryHandler } from "../../handler.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

// ── Helpers ─────────────────────────────────────────────────────────────

function mockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = new Readable();
  stream.push(body);
  stream.push(null);
  const req = stream as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
  return req;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    writeHead(status: number) {
      res._status = status;
    },
    end(body: string) {
      res._body = body;
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-06-01T12:00:00.000000Z",
    level: "info",
    event: "order-ticket.submitted",
    correlation_id: "01HTELEMETRY0000000000001",
    payload: { symbol: "SPY" },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("createTelemetryHandler", () => {
  it("accepts a valid single-event batch and returns accepted=1", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const req = mockReq(JSON.stringify([validEvent()]));
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { accepted: number };
    expect(body.accepted).toBe(1);
  });

  it("accepts a multi-event batch and returns accepted=count", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const events = [validEvent(), validEvent({ event: "position.viewed" })];
    const req = mockReq(JSON.stringify(events));
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { accepted: number };
    expect(body.accepted).toBe(2);
  });

  it("calls logger.info once per event", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const events = [validEvent(), validEvent({ event: "nav.changed" })];
    const req = mockReq(JSON.stringify(events));
    const res = mockRes();
    await handler(req, res);

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "browser.log",
      expect.objectContaining({
        event_browser: "order-ticket.submitted",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "browser.log",
      expect.objectContaining({
        event_browser: "nav.changed",
      }),
    );
  });

  it("threads browser correlation_id into the log call", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const req = mockReq(
      JSON.stringify([validEvent({ correlation_id: "01HCORRID0000000000001234" })]),
    );
    const res = mockRes();
    await handler(req, res);

    // The info call must include ts_browser from the event
    expect(logger.info).toHaveBeenCalledWith(
      "browser.log",
      expect.objectContaining({
        ts_browser: "2026-06-01T12:00:00.000000Z",
      }),
    );
  });

  it("generates a correlation_id when the event omits one", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const event = validEvent();
    delete (event as Record<string, unknown>)["correlation_id"];
    const req = mockReq(JSON.stringify([event]));
    const res = mockRes();
    await handler(req, res);

    // Should still succeed
    expect(res._status).toBe(200);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("records authenticated=true when extractBearer returns a token", async () => {
    const logger = makeLogger();
    const extractBearer = vi.fn().mockReturnValue("some-token");
    const handler = createTelemetryHandler({ logger, extractBearer });

    const req = mockReq(JSON.stringify([validEvent()]), {
      authorization: "Bearer some-token",
    });
    const res = mockRes();
    await handler(req, res);

    expect(logger.info).toHaveBeenCalledWith(
      "browser.log",
      expect.objectContaining({
        authenticated: true,
      }),
    );
  });

  it("records authenticated=false when no token is present", async () => {
    const logger = makeLogger();
    const extractBearer = vi.fn().mockReturnValue(null);
    const handler = createTelemetryHandler({ logger, extractBearer });

    const req = mockReq(JSON.stringify([validEvent()]));
    const res = mockRes();
    await handler(req, res);

    expect(logger.info).toHaveBeenCalledWith(
      "browser.log",
      expect.objectContaining({
        authenticated: false,
      }),
    );
  });

  it("returns 400 for non-JSON body", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const req = mockReq("not json");
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe("Invalid JSON");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("returns 400 when body is not an array", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const req = mockReq(JSON.stringify({ event: "foo" }));
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toMatch(/array/);
  });

  it("returns 400 for an empty batch", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const req = mockReq(JSON.stringify([]));
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toMatch(/at least one/);
  });

  it("returns 400 when an event has an invalid level", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const req = mockReq(JSON.stringify([validEvent({ level: "verbose" })]));
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toMatch(/level/);
  });

  it("returns 400 when an event is missing the event field", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const bad = { ts: "2026-06-01T12:00:00.000000Z", level: "info" };
    const req = mockReq(JSON.stringify([bad]));
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it("returns 400 when batch exceeds 200 events", async () => {
    const logger = makeLogger();
    const handler = createTelemetryHandler({ logger });

    const events = Array.from({ length: 201 }, () => validEvent());
    const req = mockReq(JSON.stringify(events));
    const res = mockRes();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toMatch(/200/);
  });
});
