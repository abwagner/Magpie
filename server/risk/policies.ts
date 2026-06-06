// ── Risk Policies (YAML-backed) ────────────────────────────────────
//
// Named bundles of risk parameters that an operator can apply to a
// portfolio in one click — e.g. "Standard", "Tight overnight",
// "Earnings week". Stored in config/risk_policies.yaml. Applying a
// policy copies its `limits` block into config/risk_limits.yaml for
// the selected portfolio via the existing RiskLimitsStore.
//
// Scope note: the original spec also calls for bundling execution_mode
// + kill-switch sensitivity into each policy. Those values live in
// config/portfolios.json today (loaded once at boot with no mutation
// API) — wiring them through is a separate refactor (followup ticket
// when needed). Today's v1 = limits-only bundles; the yaml schema
// accepts but ignores the extra fields so a later upgrade is purely
// additive.
//
// YAML shape:
//
//   version: 1
//   policies:
//     standard:
//       name: "Standard"
//       description: "Default day-trading limits."
//       limits:
//         max_net_delta: 50
//         max_net_vega: 100
//         max_daily_loss: 5000
//         max_symbol_concentration: 20
//         max_drawdown: 10000
//         max_order_size: 10
//         max_open_orders: 20

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import yaml from "yaml";
import type { Logger } from "../logger.js";
import type { RiskLimits } from "../../src/types/portfolio.js";
import type { RiskLimitsStore } from "./limits.js";

export interface RiskPolicy {
  /** Display name shown in the UI. Required. */
  name: string;
  /** Free-form short description. Optional. */
  description?: string;
  /** Limits applied to the target portfolio on apply(). */
  limits: RiskLimits;
}

export interface RiskPoliciesConfig {
  version: 1;
  policies: Record<string, RiskPolicy>;
}

const NUMERIC_LIMIT_KEYS: (keyof RiskLimits)[] = [
  "max_net_delta",
  "max_net_vega",
  "max_daily_loss",
  "max_symbol_concentration",
  "max_drawdown",
  "max_order_size",
  "max_open_orders",
];

const EMPTY: RiskPoliciesConfig = { version: 1, policies: {} };

// ── Validation ─────────────────────────────────────────────────────

class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "RiskPoliciesValidationError";
  }
}

function validateLimits(input: unknown, ctx: string): RiskLimits {
  if (!input || typeof input !== "object") {
    throw new ValidationError(`${ctx}: limits must be an object`);
  }
  const obj = input as Record<string, unknown>;
  const out: Partial<RiskLimits> = {};
  for (const k of NUMERIC_LIMIT_KEYS) {
    const v = obj[k];
    if (v === undefined || v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new ValidationError(`${ctx}.limits.${k}: must be number or null`);
    }
    if (v < 0) {
      throw new ValidationError(`${ctx}.limits.${k}: must be ≥ 0`);
    }
    out[k] = v;
  }
  return out as RiskLimits;
}

function validatePolicy(id: string, input: unknown): RiskPolicy {
  if (!input || typeof input !== "object") {
    throw new ValidationError(`policy ${id}: expected an object`);
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new ValidationError(`policy ${id}: name is required`);
  }
  const result: RiskPolicy = {
    name: obj.name.trim(),
    limits: validateLimits(obj.limits, `policy ${id}`),
  };
  if (obj.description !== undefined) {
    if (typeof obj.description !== "string") {
      throw new ValidationError(`policy ${id}: description must be a string`);
    }
    result.description = obj.description;
  }
  return result;
}

function normalize(raw: unknown): RiskPoliciesConfig {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Partial<RiskPoliciesConfig>;
  if (r.version !== undefined && r.version !== 1) {
    throw new ValidationError(`unsupported version ${String(r.version)}`);
  }
  const policies: Record<string, RiskPolicy> = {};
  for (const [id, p] of Object.entries(r.policies ?? {})) {
    policies[id] = validatePolicy(id, p);
  }
  return { version: 1, policies };
}

// ── Store ──────────────────────────────────────────────────────────

export interface RiskPoliciesStoreOpts {
  yamlPath: string;
  logger: Logger;
  /**
   * Used by apply(): the live RiskLimitsStore the policy writes into.
   * Injected rather than imported so unit tests can pass a mock.
   */
  riskLimitsStore: RiskLimitsStore;
}

export class RiskPoliciesStore {
  private cfg: RiskPoliciesConfig = EMPTY;
  private readonly yamlPath: string;
  private readonly logger: Logger;
  private readonly riskLimitsStore: RiskLimitsStore;

  constructor(opts: RiskPoliciesStoreOpts) {
    this.yamlPath = opts.yamlPath;
    this.logger = opts.logger;
    this.riskLimitsStore = opts.riskLimitsStore;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.yamlPath, "utf8");
      const parsed = yaml.parse(raw) as unknown;
      this.cfg = normalize(parsed);
      this.logger.info("risk policies loaded from YAML", {
        path: this.yamlPath,
        policies: Object.keys(this.cfg.policies),
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
      this.cfg = EMPTY;
      this.logger.info("risk policies file missing — starting empty", {
        path: this.yamlPath,
      });
    }
  }

  get(): RiskPoliciesConfig {
    return this.cfg;
  }

  async upsert(id: string, policy: RiskPolicy): Promise<RiskPoliciesConfig> {
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new ValidationError("policy id must be non-empty and contain only [A-Za-z0-9_-]");
    }
    const validated = validatePolicy(id, policy);
    const next: RiskPoliciesConfig = {
      version: 1,
      policies: { ...this.cfg.policies, [id]: validated },
    };
    this.cfg = next;
    await this.persist();
    this.logger.info("risk policy upserted", { id });
    return next;
  }

  async remove(id: string): Promise<RiskPoliciesConfig> {
    if (!(id in this.cfg.policies)) {
      throw new ValidationError(`unknown policy: ${id}`);
    }
    const { [id]: _, ...rest } = this.cfg.policies;
    void _; // satisfy no-unused-vars
    const next: RiskPoliciesConfig = { version: 1, policies: rest };
    this.cfg = next;
    await this.persist();
    this.logger.info("risk policy removed", { id });
    return next;
  }

  /**
   * Apply `policy.limits` to the named portfolio via the live
   * RiskLimitsStore. Throws if either the policy or the portfolio is
   * unknown — both checks happen before any write so a typo can't
   * leave the system in an inconsistent state.
   */
  async apply(policyId: string, portfolioId: string): Promise<{ applied: RiskLimits }> {
    const policy = this.cfg.policies[policyId];
    if (!policy) {
      throw new ValidationError(`unknown policy: ${policyId}`);
    }
    // The current RiskLimitsStore doesn't expose a "portfolio exists?"
    // probe directly; pull the whole config and check.
    const limitsCfg = this.riskLimitsStore.get();
    if (!(portfolioId in limitsCfg.portfolios)) {
      throw new ValidationError(`unknown portfolio: ${portfolioId}`);
    }
    await this.riskLimitsStore.setPortfolio(portfolioId, policy.limits);
    this.logger.info("risk policy applied", { policy_id: policyId, portfolio_id: portfolioId });
    return { applied: policy.limits };
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.yamlPath), { recursive: true });
    const content = yaml.stringify(this.cfg, { sortMapEntries: false });
    const tmp = `${this.yamlPath}.tmp`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, this.yamlPath);
  }
}
