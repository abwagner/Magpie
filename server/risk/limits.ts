// ── Risk limits config (YAML-backed) ──────────────────────────────
// One file, version-controlled, per the design's
// `config/risk_limits.yaml` callout. Loaded once at boot; the GUI
// can read via GET /api/risk/limits and edit via PUT.
//
// Bootstrap rules:
//   - If config/risk_limits.yaml exists, that's authoritative.
//   - If it doesn't, the loader reads limits from portfolios.json,
//     writes the YAML, and that becomes the source of truth on the
//     next boot. portfolios.json's `limits` block is deprecated and
//     ignored once the YAML is present.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import yaml from "yaml";
import type { Logger } from "../logger.js";
import type { RiskLimits } from "../../src/types/portfolio.js";

export interface RiskLimitsConfig {
  version: 1;
  portfolios: Record<string, RiskLimits>;
}

const NUMERIC_KEYS: (keyof RiskLimits)[] = [
  "max_net_delta",
  "max_net_vega",
  "max_daily_loss",
  "max_symbol_concentration",
  "max_drawdown",
  "max_order_size",
  "max_open_orders",
];

class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "RiskLimitsValidationError";
  }
}

export interface RiskLimitsStoreOpts {
  yamlPath: string;
  logger: Logger;
  fallbackLimits?: Record<string, RiskLimits>;
  onChange?: (cfg: RiskLimitsConfig) => void;
}

export class RiskLimitsStore {
  private cfg: RiskLimitsConfig = { version: 1, portfolios: {} };
  private readonly yamlPath: string;
  private readonly logger: Logger;
  private readonly fallback: Record<string, RiskLimits>;
  private readonly onChange?: (cfg: RiskLimitsConfig) => void;

  constructor(opts: RiskLimitsStoreOpts) {
    this.yamlPath = opts.yamlPath;
    this.logger = opts.logger;
    this.fallback = opts.fallbackLimits ?? {};
    if (opts.onChange) this.onChange = opts.onChange;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.yamlPath, "utf8");
      const parsed = yaml.parse(raw) as Partial<RiskLimitsConfig>;
      this.cfg = normalize(parsed);
      this.logger.info("risk limits loaded from YAML", {
        path: this.yamlPath,
        portfolios: Object.keys(this.cfg.portfolios),
      });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }

    // YAML missing — bootstrap from fallback (portfolios.json) and
    // write it out so subsequent boots are YAML-driven.
    if (Object.keys(this.fallback).length > 0) {
      this.cfg = { version: 1, portfolios: { ...this.fallback } };
      await this.persist();
      this.logger.info("risk limits bootstrapped from fallback", {
        path: this.yamlPath,
        portfolios: Object.keys(this.cfg.portfolios),
      });
    } else {
      this.cfg = { version: 1, portfolios: {} };
      this.logger.warn("risk limits file missing and no fallback provided", {
        path: this.yamlPath,
      });
    }
  }

  get(): RiskLimitsConfig {
    return this.cfg;
  }

  forPortfolio(id: string): RiskLimits | undefined {
    return this.cfg.portfolios[id];
  }

  async setPortfolio(id: string, limits: RiskLimits): Promise<RiskLimitsConfig> {
    validate(limits);
    const next: RiskLimitsConfig = {
      version: 1,
      portfolios: { ...this.cfg.portfolios, [id]: limits },
    };
    this.cfg = next;
    await this.persist();
    this.onChange?.(next);
    this.logger.info("risk limits updated", { portfolio: id });
    return next;
  }

  // Persist via write-then-rename so the YAML is always whole.
  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.yamlPath), { recursive: true });
    const content = yaml.stringify(this.cfg, {
      // pretty + stable key order
      sortMapEntries: false,
    });
    const tmp = `${this.yamlPath}.tmp`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, this.yamlPath);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function normalize(raw: Partial<RiskLimitsConfig>): RiskLimitsConfig {
  if (!raw || typeof raw !== "object") {
    throw new ValidationError("risk_limits.yaml: expected an object");
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new ValidationError(`risk_limits.yaml: unsupported version ${raw.version}`);
  }
  const portfolios: Record<string, RiskLimits> = {};
  for (const [id, lim] of Object.entries(raw.portfolios ?? {})) {
    portfolios[id] = validate(lim as Partial<RiskLimits>);
  }
  return { version: 1, portfolios };
}

function validate(input: Partial<RiskLimits>): RiskLimits {
  const out: Partial<RiskLimits> = {};
  for (const k of NUMERIC_KEYS) {
    const v = input[k];
    if (v === undefined || v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new ValidationError(`${k}: must be a number or null, got ${typeof v}`);
    }
    if (v < 0) {
      throw new ValidationError(`${k}: must be ≥ 0`);
    }
    out[k] = v;
  }
  return out as RiskLimits;
}
