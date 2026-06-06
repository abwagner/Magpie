import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "yaml";
import { RiskLimitsStore } from "../../limits.js";
import { createLogger } from "../../../logger.js";
import type { RiskLimits } from "../../../../src/types/portfolio.js";

const silent = createLogger("test", "warn");

const SAMPLE: RiskLimits = {
  max_net_delta: 50,
  max_net_vega: 100,
  max_daily_loss: 5000,
  max_symbol_concentration: 20,
  max_drawdown: 10000,
  max_order_size: 10,
  max_open_orders: 20,
};

describe("RiskLimitsStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qf-risk-"));
    path = join(dir, "risk_limits.yaml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("bootstraps from fallback when YAML missing and writes the file", async () => {
    const store = new RiskLimitsStore({
      yamlPath: path,
      logger: silent,
      fallbackLimits: { main: SAMPLE },
    });
    await store.load();
    expect(store.forPortfolio("main")).toEqual(SAMPLE);

    const raw = await readFile(path, "utf8");
    const parsed = yaml.parse(raw);
    expect(parsed).toMatchObject({
      version: 1,
      portfolios: { main: { max_daily_loss: 5000 } },
    });
  });

  it("loads from existing YAML in preference to fallback", async () => {
    const explicit = { ...SAMPLE, max_daily_loss: 999 };
    await writeFile(path, yaml.stringify({ version: 1, portfolios: { main: explicit } }), "utf8");

    const store = new RiskLimitsStore({
      yamlPath: path,
      logger: silent,
      fallbackLimits: { main: SAMPLE },
    });
    await store.load();
    expect(store.forPortfolio("main")?.max_daily_loss).toBe(999);
  });

  it("PUT setPortfolio validates and persists", async () => {
    const store = new RiskLimitsStore({ yamlPath: path, logger: silent });
    await store.load();

    await store.setPortfolio("main", SAMPLE);
    expect(store.forPortfolio("main")).toEqual(SAMPLE);

    // Round-trip
    const fresh = new RiskLimitsStore({ yamlPath: path, logger: silent });
    await fresh.load();
    expect(fresh.forPortfolio("main")).toEqual(SAMPLE);
  });

  it("rejects negative or non-numeric values", async () => {
    const store = new RiskLimitsStore({ yamlPath: path, logger: silent });
    await store.load();
    await expect(store.setPortfolio("main", { ...SAMPLE, max_daily_loss: -1 })).rejects.toThrow(
      /≥ 0/,
    );
    await expect(
      store.setPortfolio("main", { ...SAMPLE, max_daily_loss: "lots" as unknown as number }),
    ).rejects.toThrow(/must be a number/);
  });

  it("rejects unsupported version", async () => {
    await writeFile(path, yaml.stringify({ version: 2, portfolios: {} }), "utf8");
    const store = new RiskLimitsStore({ yamlPath: path, logger: silent });
    await expect(store.load()).rejects.toThrow(/unsupported version 2/);
  });

  it("emits onChange after setPortfolio", async () => {
    const events: string[] = [];
    const store = new RiskLimitsStore({
      yamlPath: path,
      logger: silent,
      onChange: (cfg) => events.push(Object.keys(cfg.portfolios).join(",")),
    });
    await store.load();
    await store.setPortfolio("main", SAMPLE);
    await store.setPortfolio("alt", SAMPLE);
    expect(events).toEqual(["main", "main,alt"]);
  });
});
