import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

import {
  backupObservabilityHandler,
  buildArgs,
  redactArgs,
} from "../../handlers/backup-observability.js";
import type { HandlerContext, ProgressSink } from "../../types.js";

// A fake child process: EventEmitter with stdout/stderr sub-emitters,
// matching the surface the handler subscribes to.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function fakeCtx(): { ctx: HandlerContext; progress: ReturnType<typeof vi.fn> } {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const progress = vi.fn();
  return {
    ctx: { actor: "test", jobId: "job-1", logger },
    progress,
  };
}

describe("backup-observability handler", () => {
  const validate = backupObservabilityHandler.validate!;

  it("declares the canonical kind name", () => {
    expect(backupObservabilityHandler.kind).toBe("backup-observability");
  });

  it("accepts an empty params object", () => {
    expect(validate({})).toEqual([]);
  });

  it("rejects non-object params", () => {
    expect(validate(null).length).toBeGreaterThan(0);
    expect(validate("oops").length).toBeGreaterThan(0);
  });

  it("accepts string bucket / endpoint_url / region", () => {
    expect(
      validate({
        bucket: "obs-backups",
        endpoint_url: "https://s3.example.com",
        region: "us-east-1",
      }),
    ).toEqual([]);
  });

  it("rejects non-string bucket", () => {
    const errs = validate({ bucket: 42 });
    expect(errs.some((e) => e.includes("bucket"))).toBe(true);
  });

  it("rejects a structurally invalid bucket name", () => {
    expect(validate({ bucket: "Has_Caps_And_Underscores" }).length).toBeGreaterThan(0);
    expect(validate({ bucket: "-leading-hyphen" }).length).toBeGreaterThan(0);
    expect(validate({ bucket: "ab" }).length).toBeGreaterThan(0); // too short
    expect(validate({ bucket: "a;rm -rf /" }).length).toBeGreaterThan(0);
  });

  it("rejects a non-http(s) or unparseable endpoint_url", () => {
    expect(validate({ endpoint_url: "ftp://s3.example.com" }).length).toBeGreaterThan(0);
    expect(validate({ endpoint_url: "file:///etc/passwd" }).length).toBeGreaterThan(0);
    expect(validate({ endpoint_url: "not a url" }).length).toBeGreaterThan(0);
  });

  it("accepts a plain http endpoint_url", () => {
    expect(validate({ endpoint_url: "http://localhost:9000" })).toEqual([]);
  });

  it("accepts a positive integer retention_days", () => {
    expect(validate({ retention_days: 30 })).toEqual([]);
  });

  it("rejects a non-positive or non-integer retention_days", () => {
    expect(validate({ retention_days: 0 }).length).toBeGreaterThan(0);
    expect(validate({ retention_days: -7 }).length).toBeGreaterThan(0);
    expect(validate({ retention_days: 1.5 }).length).toBeGreaterThan(0);
    expect(validate({ retention_days: "30" }).length).toBeGreaterThan(0);
  });

  it("accepts a boolean dry_run", () => {
    expect(validate({ dry_run: true })).toEqual([]);
  });

  it("rejects a non-boolean dry_run", () => {
    expect(validate({ dry_run: "yes" }).length).toBeGreaterThan(0);
  });
});

describe("buildArgs", () => {
  it("returns just the impl script for empty params", () => {
    const args = buildArgs({});
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/_backup-observability-impl\.ts$/);
  });

  it("maps each param to its flag and value", () => {
    const args = buildArgs({
      bucket: "obs-backups",
      endpoint_url: "https://s3.example.com",
      region: "us-west-2",
      retention_days: 7,
      dry_run: true,
    });
    expect(args.slice(1)).toEqual([
      "--bucket",
      "obs-backups",
      "--endpoint-url",
      "https://s3.example.com",
      "--region",
      "us-west-2",
      "--retention-days",
      "7",
      "--dry-run",
    ]);
  });

  it("omits retention_days when undefined", () => {
    expect(buildArgs({ bucket: "b" })).not.toContain("--retention-days");
  });

  it("includes --retention-days when explicitly set", () => {
    expect(buildArgs({ retention_days: 14 })).toContain("--retention-days");
  });

  it("omits --dry-run when false and includes it when true", () => {
    expect(buildArgs({ dry_run: false })).not.toContain("--dry-run");
    expect(buildArgs({ dry_run: true })).toContain("--dry-run");
  });
});

describe("redactArgs", () => {
  it("masks bucket / endpoint-url / region values but keeps the flags", () => {
    const args = buildArgs({
      bucket: "secret-bucket",
      endpoint_url: "https://internal.example.com",
      region: "eu-central-1",
    });
    const red = redactArgs(args);
    expect(red).toContain("--bucket");
    expect(red).toContain("--endpoint-url");
    expect(red).toContain("--region");
    expect(red).not.toContain("secret-bucket");
    expect(red).not.toContain("https://internal.example.com");
    expect(red).not.toContain("eu-central-1");
    expect(red.filter((a) => a === "***")).toHaveLength(3);
  });

  it("leaves non-sensitive args untouched", () => {
    const red = redactArgs(buildArgs({ retention_days: 7, dry_run: true }));
    expect(red).toContain("7");
    expect(red).toContain("--dry-run");
  });
});

describe("run", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with empty output_paths on exit 0", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const { ctx, progress } = fakeCtx();

    const promise = backupObservabilityHandler.run({}, progress as ProgressSink, ctx);
    child.stdout.emit("data", Buffer.from("Done.\n"));
    child.emit("exit", 0);

    await expect(promise).resolves.toEqual({ output_paths: [] });
    expect(progress).toHaveBeenCalledWith(0, null, "spawning");
  });

  it("rejects with exit code and stderr tail on non-zero exit", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const { ctx, progress } = fakeCtx();

    const promise = backupObservabilityHandler.run({}, progress as ProgressSink, ctx);
    child.stderr.emit("data", Buffer.from("boom: bucket missing\n"));
    child.emit("exit", 2);

    await expect(promise).rejects.toThrow(/exited 2/);
    await expect(promise).rejects.toThrow(/boom: bucket missing/);
  });

  it("rejects when the child emits an error event", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const { ctx, progress } = fakeCtx();

    const promise = backupObservabilityHandler.run({}, progress as ProgressSink, ctx);
    child.emit("error", new Error("spawn ENOENT"));

    await expect(promise).rejects.toThrow(/ENOENT/);
  });
});
