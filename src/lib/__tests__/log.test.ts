import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── log.ts unit tests ─────────────────────────────────────────────────────
// The log module maintains global state (ring buffer, queue, session ID).
// We re-import between tests by resetting module cache via vi.resetModules().

describe("log module", () => {
  beforeEach(() => {
    vi.resetModules();
    // Stub global fetch so network calls never go out in tests.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    // Stub timers to control flush scheduling.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("exports a log function and useLog hook", async () => {
    const mod = await import("../log.js");
    expect(typeof mod.log).toBe("function");
    expect(typeof mod.useLog).toBe("function");
  });

  it("exports SESSION_CORRELATION_ID as a 26-char string", async () => {
    const { SESSION_CORRELATION_ID } = await import("../log.js");
    expect(typeof SESSION_CORRELATION_ID).toBe("string");
    expect(SESSION_CORRELATION_ID.length).toBe(26);
  });

  it("does not call fetch on trace events", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { log } = await import("../log.js");
    log("trace", "trace message");

    // Advance past the flush timer
    await vi.runAllTimersAsync();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls fetch with the correct endpoint for non-trace events", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { log } = await import("../log.js");
    log("info", "hello server");

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/telemetry",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("batches multiple events in a single fetch call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { log } = await import("../log.js");
    log("info", "event 1");
    log("warn", "event 2");
    log("error", "event 3");

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call0 = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(call0[1].body) as Array<{ level: string }>;
    expect(body).toHaveLength(3);
  });

  it("includes the session correlation_id on every forwarded event", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { log, SESSION_CORRELATION_ID } = await import("../log.js");
    log("info", "corr test");

    await vi.runAllTimersAsync();

    const call0 = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(call0[1].body) as Array<{ correlation_id: string }>;
    expect(body[0]?.correlation_id).toBe(SESSION_CORRELATION_ID);
  });

  it("sets event_browser to browser.<level>", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { log } = await import("../log.js");
    log("warn", "warning message");

    await vi.runAllTimersAsync();

    const call0 = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(call0[1].body) as Array<{
      event: string;
      payload: { message: string };
    }>;
    expect(body[0]?.event).toBe("browser.warn");
    expect(body[0]?.payload.message).toBe("warning message");
  });

  it("does not throw when fetch rejects (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { log } = await import("../log.js");
    expect(() => log("error", "network error test")).not.toThrow();

    // Advance timers — flush should silently swallow the error.
    await vi.runAllTimersAsync();
  });
});
