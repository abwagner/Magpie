import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Logger reads LOG_FILE at first use and caches the stream, so each test
// resets the module cache via vi.resetModules() before importing fresh.

describe("logger", () => {
  let tmpDir: string;
  const origLogFile = process.env.LOG_FILE;
  const origLogFormat = process.env.LOG_FORMAT;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
    process.env.LOG_FORMAT = "json";
    vi.resetModules();
  });

  afterEach(() => {
    if (origLogFile === undefined) delete process.env.LOG_FILE;
    else process.env.LOG_FILE = origLogFile;
    if (origLogFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = origLogFormat;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes newline-delimited JSON in framework schema to LOG_FILE", async () => {
    const logFile = join(tmpDir, "server.log");
    process.env.LOG_FILE = logFile;

    const { createLogger } = await import("../../logger.js");
    const log = createLogger("test", "debug");
    log.info("hello.event", { n: 1 });
    log.warn("careful.event", { code: "X" });
    log.error("boom.event", { reason: "oops" });

    await new Promise((r) => setTimeout(r, 50));

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({
      level: "info",
      service: "test",
      event: "hello.event",
      payload: { n: 1 },
    });
    expect(parsed[1]).toMatchObject({
      level: "warn",
      event: "careful.event",
      payload: { code: "X" },
    });
    expect(parsed[2]).toMatchObject({
      level: "error",
      event: "boom.event",
      payload: { reason: "oops" },
    });
    for (const entry of parsed) {
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(entry.correlation_id).toBeUndefined(); // no context active
    }
  });

  it("emits correlation_id when set via withCorrelationId", async () => {
    const logFile = join(tmpDir, "cid.log");
    process.env.LOG_FILE = logFile;

    const { createLogger, withCorrelationId } = await import("../../logger.js");
    const log = createLogger("test", "debug");

    withCorrelationId("01TESTCORRELATION12345ABCD", () => {
      log.info("bound.event", { k: "v" });
    });
    log.info("unbound.event"); // no correlation_id

    await new Promise((r) => setTimeout(r, 50));
    const [bound, unbound] = readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(bound.correlation_id).toBe("01TESTCORRELATION12345ABCD");
    expect(unbound.correlation_id).toBeUndefined();
  });

  it("currentCorrelationId reads the active context", async () => {
    const { withCorrelationId, currentCorrelationId } = await import("../../logger.js");
    expect(currentCorrelationId()).toBeUndefined();
    withCorrelationId("01ABC", () => {
      expect(currentCorrelationId()).toBe("01ABC");
      withCorrelationId("01DEF", () => {
        expect(currentCorrelationId()).toBe("01DEF");
      });
      expect(currentCorrelationId()).toBe("01ABC");
    });
    expect(currentCorrelationId()).toBeUndefined();
  });

  it("correlation_id survives await boundaries", async () => {
    const { withCorrelationId, currentCorrelationId } = await import("../../logger.js");
    const inner = async (): Promise<string | undefined> => {
      await new Promise((r) => setTimeout(r, 5));
      return currentCorrelationId();
    };
    const cid = await new Promise<string | undefined>((resolve) => {
      withCorrelationId("01ASYNC", () => {
        inner().then(resolve);
      });
    });
    expect(cid).toBe("01ASYNC");
  });

  it("child loggers share the same file and inherit the service prefix", async () => {
    const logFile = join(tmpDir, "child.log");
    process.env.LOG_FILE = logFile;

    const { createLogger } = await import("../../logger.js");
    const parent = createLogger("parent", "debug");
    const child = parent.child("sub");
    parent.info("p.event");
    child.info("c.event");

    await new Promise((r) => setTimeout(r, 50));

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const [p, c] = lines.map((l) => JSON.parse(l));
    expect(p.service).toBe("parent");
    expect(c.service).toBe("parent.sub");
  });

  it("respects level filtering", async () => {
    const logFile = join(tmpDir, "level.log");
    process.env.LOG_FILE = logFile;

    const { createLogger } = await import("../../logger.js");
    const log = createLogger("test", "warn");
    log.trace("dropped.event");
    log.debug("dropped.event");
    log.info("dropped.event");
    log.warn("kept.event");

    await new Promise((r) => setTimeout(r, 50));

    const content = readFileSync(logFile, "utf-8").trim();
    const lines = content ? content.split("\n") : [];
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe("kept.event");
  });

  it("emits fields in framework order", async () => {
    const logFile = join(tmpDir, "order.log");
    process.env.LOG_FILE = logFile;

    const { createLogger, withCorrelationId } = await import("../../logger.js");
    const log = createLogger("test", "debug");

    withCorrelationId("01ORDER", () => {
      log.info("ordered.event", { k: "v" });
    });

    await new Promise((r) => setTimeout(r, 50));
    const line = readFileSync(logFile, "utf-8").trim();
    // Stringified JSON should have keys in framework order:
    // ts, level, service, correlation_id, event, payload.
    expect(line).toMatch(
      /^\{"ts":".+?","level":"info","service":"test","correlation_id":"01ORDER","event":"ordered.event","payload":\{"k":"v"\}\}$/,
    );
  });
});
