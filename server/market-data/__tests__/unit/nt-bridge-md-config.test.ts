// Unit tests for the nt_bridge config sub-block parser (QF-255).

import { describe, it, expect } from "vitest";
import { NtBridgeMdConfigError, parseNtBridgeMdConfig } from "../../nt-bridge-md-config.js";
import { createTestLogger } from "../../../__tests__/helpers/test-logger.js";

describe("parseNtBridgeMdConfig", () => {
  const logger = createTestLogger();

  it("returns defaults when the block is missing", () => {
    const cfg = parseNtBridgeMdConfig(undefined, logger);
    expect(cfg.enabled).toBe(false);
    expect(cfg.brokers).toEqual([]);
    expect(cfg.mode).toBe("observe");
  });

  it("returns defaults when the block is null", () => {
    const cfg = parseNtBridgeMdConfig(null, logger);
    expect(cfg.enabled).toBe(false);
  });

  it("parses a minimal enabled observe-mode block", () => {
    const cfg = parseNtBridgeMdConfig(
      { enabled: true, brokers: ["schwab"], mode: "observe" },
      logger,
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.brokers).toEqual(["schwab"]);
    expect(cfg.mode).toBe("observe");
  });

  it("parses both brokers + first-priority mode + custom timeouts", () => {
    const cfg = parseNtBridgeMdConfig(
      {
        enabled: true,
        brokers: ["schwab", "ibkr"],
        mode: "first",
        timeouts: { quote_ms: 1500, chain_ms: 4000 },
        heartbeat_stale_ms: 45_000,
      },
      logger,
    );
    expect(cfg.brokers).toEqual(["schwab", "ibkr"]);
    expect(cfg.mode).toBe("first");
    expect(cfg.timeouts?.quote_ms).toBe(1500);
    expect(cfg.timeouts?.chain_ms).toBe(4000);
    expect(cfg.heartbeat_stale_ms).toBe(45_000);
  });

  it("dedupes brokers list", () => {
    const cfg = parseNtBridgeMdConfig(
      { enabled: true, brokers: ["schwab", "schwab"], mode: "observe" },
      logger,
    );
    expect(cfg.brokers).toEqual(["schwab"]);
  });

  it("throws on enabled=true with empty brokers list", () => {
    expect(() =>
      parseNtBridgeMdConfig({ enabled: true, brokers: [], mode: "observe" }, logger),
    ).toThrow(/brokers list is empty/);
  });

  it("throws on unknown top-level field (typo guard)", () => {
    expect(() =>
      parseNtBridgeMdConfig(
        {
          enabled: true,
          brokers: ["schwab"],
          mode: "observe",
          ebnaled: true, // typo
        },
        logger,
      ),
    ).toThrow(/unknown field "ebnaled"/);
  });

  it("throws on unknown broker name", () => {
    expect(() =>
      parseNtBridgeMdConfig({ enabled: true, brokers: ["lighty"], mode: "observe" }, logger),
    ).toThrow(NtBridgeMdConfigError);
  });

  it("throws on unknown mode", () => {
    expect(() =>
      parseNtBridgeMdConfig({ enabled: true, brokers: ["schwab"], mode: "preferred" }, logger),
    ).toThrow(/mode must be one of/);
  });

  it("throws on unknown timeout field (typo guard)", () => {
    expect(() =>
      parseNtBridgeMdConfig(
        {
          enabled: true,
          brokers: ["schwab"],
          mode: "observe",
          timeouts: { quoet_ms: 1000 },
        },
        logger,
      ),
    ).toThrow(/timeouts: unknown field "quoet_ms"/);
  });

  it("throws on non-positive timeouts", () => {
    expect(() =>
      parseNtBridgeMdConfig(
        {
          enabled: true,
          brokers: ["schwab"],
          mode: "observe",
          timeouts: { quote_ms: 0 },
        },
        logger,
      ),
    ).toThrow(/positive number/);
  });

  it("throws when enabled is not a boolean", () => {
    expect(() => parseNtBridgeMdConfig({ enabled: "yes", brokers: ["schwab"] }, logger)).toThrow(
      /must be a boolean/,
    );
  });

  it("throws when brokers isn't an array", () => {
    expect(() =>
      parseNtBridgeMdConfig({ enabled: true, brokers: "schwab", mode: "observe" }, logger),
    ).toThrow(/brokers must be an array/);
  });

  it("throws when top-level isn't an object", () => {
    expect(() => parseNtBridgeMdConfig("nt_bridge", logger)).toThrow(/must be an object/);
    expect(() => parseNtBridgeMdConfig([1, 2], logger)).toThrow(/must be an object/);
  });
});
