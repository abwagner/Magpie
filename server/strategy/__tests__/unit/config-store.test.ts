// Coverage for StrategyConfigStore: list, get, update (with validation),
// atomic write semantics, and error mapping (404 / 400 surfaces).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrategyConfigError, StrategyConfigStore } from "../../config-store.js";

const FIXTURE = {
  portfolios: {
    main: {
      mode: "paper_local",
      strategies: {
        "short-straddle-spy": {
          module: "src/lib/strategies/short-straddle.js",
          config: { minDTE: 25, maxDTE: 60, rollDTE: 21, maxOpen: 1 },
          signal_interests: ["signals.vol-forecast-spy-1d.EQ.SPY"],
          signal_staleness_seconds: 300,
        },
      },
    },
  },
};

function fakeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    child: () => fakeLogger(),
  };
}

describe("StrategyConfigStore", () => {
  let tmp: string;
  let path: string;
  let store: StrategyConfigStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qf-59-"));
    path = join(tmp, "portfolios.json");
    writeFileSync(path, JSON.stringify(FIXTURE, null, 2));
    store = new StrategyConfigStore({
      portfoliosJsonPath: path,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: fakeLogger() as any,
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("list", () => {
    it("returns a summary per (portfolio, strategy)", async () => {
      const out = await store.list();
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        portfolio: "main",
        id: "short-straddle-spy",
        module: "src/lib/strategies/short-straddle.js",
        signal_staleness_seconds: 300,
      });
      expect(out[0]!.config_keys.sort()).toEqual(["maxDTE", "maxOpen", "minDTE", "rollDTE"]);
    });

    it("returns empty when no portfolios", async () => {
      writeFileSync(path, JSON.stringify({ portfolios: {} }));
      expect(await store.list()).toEqual([]);
    });
  });

  describe("get", () => {
    it("returns the full strategy entry", async () => {
      const e = await store.get("main", "short-straddle-spy");
      expect(e.module).toBe("src/lib/strategies/short-straddle.js");
      expect(e.config).toEqual({ minDTE: 25, maxDTE: 60, rollDTE: 21, maxOpen: 1 });
      expect(e.signal_interests).toEqual(["signals.vol-forecast-spy-1d.EQ.SPY"]);
      expect(e.signal_staleness_seconds).toBe(300);
    });

    it("throws 404 for unknown portfolio", async () => {
      await expect(store.get("nope", "short-straddle-spy")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("throws 404 for unknown strategy id", async () => {
      await expect(store.get("main", "nope")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("update", () => {
    it("writes a config patch and persists it atomically", async () => {
      const out = await store.update("main", "short-straddle-spy", {
        config: { minDTE: 30, maxDTE: 45, rollDTE: 21, maxOpen: 2 },
      });
      expect(out.config.minDTE).toBe(30);
      // File on disk reflects the change.
      const onDisk = JSON.parse(readFileSync(path, "utf-8"));
      expect(onDisk.portfolios.main.strategies["short-straddle-spy"].config.minDTE).toBe(30);
      // Untouched fields preserved.
      expect(onDisk.portfolios.main.strategies["short-straddle-spy"].signal_staleness_seconds).toBe(
        300,
      );
      // Other top-level portfolio fields untouched.
      expect(onDisk.portfolios.main.mode).toBe("paper_local");
    });

    it("supports patching signal_interests + signal_staleness_seconds alone", async () => {
      const out = await store.update("main", "short-straddle-spy", {
        signal_interests: ["signals.new.EQ.SPY"],
        signal_staleness_seconds: 60,
      });
      expect(out.signal_interests).toEqual(["signals.new.EQ.SPY"]);
      expect(out.signal_staleness_seconds).toBe(60);
      // config preserved.
      expect(out.config).toEqual({ minDTE: 25, maxDTE: 60, rollDTE: 21, maxOpen: 1 });
    });

    it("rejects non-object config", async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.update("main", "short-straddle-spy", { config: ["bad"] as any }),
      ).rejects.toBeInstanceOf(StrategyConfigError);
    });

    it("rejects non-array signal_interests", async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.update("main", "short-straddle-spy", { signal_interests: "single" as any }),
      ).rejects.toBeInstanceOf(StrategyConfigError);
    });

    it("rejects non-string signal_interests entries", async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.update("main", "short-straddle-spy", { signal_interests: ["", "ok"] as any }),
      ).rejects.toBeInstanceOf(StrategyConfigError);
    });

    it("rejects negative signal_staleness_seconds", async () => {
      await expect(
        store.update("main", "short-straddle-spy", { signal_staleness_seconds: -1 }),
      ).rejects.toBeInstanceOf(StrategyConfigError);
    });

    it("throws 404 for unknown strategy id", async () => {
      await expect(
        store.update("main", "nope", { signal_staleness_seconds: 60 }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("fires onChange with (portfolio, strategy)", async () => {
      const calls: [string, string][] = [];
      const s = new StrategyConfigStore({
        portfoliosJsonPath: path,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: fakeLogger() as any,
        onChange: (p, id) => {
          calls.push([p, id]);
        },
      });
      await s.update("main", "short-straddle-spy", { signal_staleness_seconds: 60 });
      expect(calls).toEqual([["main", "short-straddle-spy"]]);
    });
  });

  describe("error mapping", () => {
    it("surfaces ENOENT on missing portfolios.json as 500", async () => {
      const s = new StrategyConfigStore({
        portfoliosJsonPath: join(tmp, "nope.json"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: fakeLogger() as any,
      });
      await expect(s.list()).rejects.toMatchObject({ status: 500 });
    });

    it("surfaces parse-error JSON as 500", async () => {
      writeFileSync(path, "{ not json");
      await expect(store.list()).rejects.toMatchObject({ status: 500 });
    });
  });
});
