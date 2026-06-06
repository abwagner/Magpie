// ── Brokers config loader (QF-242 / QF-243) ───────────────────────
// Reads config/brokers.json. The file is small and operator-edited;
// schema is intentionally narrow so a typo doesn't silently disable
// what the operator meant to enable.
//
// QF-243 extended the schema to support N Schwab accounts addressable
// by id. The legacy single-object shape (brokers.schwab.enabled) is
// still accepted and synthesises a synthetic "default" account so
// QF-242 deploys continue to work without an operator edit.
//
// Defined in: docs/tdd/broker-integration.md §2.2 (Schwab) — this is
// the runtime config block that gates the conditional NT-bridge
// wiring in server/index.ts §8.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────

/** A single Schwab account entry in the multi-account config shape. */
export interface SchwabAccountConfig {
  /** Slug-safe identifier: [a-z0-9_-]+. Unique within the file. */
  id: string;
  /** Human-readable label for dashboards/logs. Defaults to id. */
  label: string;
  enabled: boolean;
  submit_timeout_ms?: number;
  query_timeout_ms?: number;
}

/**
 * Top-level Schwab broker config produced by the loader.
 * `accounts` is always present and non-empty after successful load.
 */
export interface SchwabBrokerConfig {
  accounts: SchwabAccountConfig[];
}

export interface BrokersConfig {
  schwab: SchwabBrokerConfig;
}

/** Slim per-portfolio routing hint loaded from portfolios.json. */
export interface PortfolioRoutingEntry {
  /** The portfolio id key from portfolios.json. */
  portfolioId: string;
  /**
   * When set, routes orders to this account id.
   * When absent, falls back to the first enabled account.
   */
  accountId?: string;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_ACCOUNT: SchwabAccountConfig = Object.freeze({
  id: "default",
  label: "default",
  enabled: false,
});

const DEFAULTS: BrokersConfig = Object.freeze({
  schwab: Object.freeze({
    accounts: [DEFAULT_ACCOUNT],
  }),
}) as BrokersConfig;

// ── Slug regex ────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9_-]+$/;

// ── Error class ───────────────────────────────────────────────────

export class BrokersConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokersConfigError";
  }
}

// ── Loader ────────────────────────────────────────────────────────

/**
 * Load + validate `config/brokers.json`. Missing file → defaults
 * (schwab disabled). Malformed file → throw — we'd rather refuse to
 * start than guess what the operator meant to enable.
 *
 * Accepts two shapes for brokers.schwab:
 *   1. New (QF-243): { "accounts": [ { "id": "...", "enabled": true, ... } ] }
 *   2. Legacy (QF-242): { "enabled": false, ... }
 *      → synthesises a single account with id "default" and logs a warning.
 *
 * @param configDir - directory containing brokers.json (and portfolios.json)
 * @param logger - structured logger
 * @param portfolioRouting - optional routing entries from portfolios.json,
 *   used to validate that any account_id references exist in the loaded config
 */
export function loadBrokersConfig(
  configDir: string,
  logger: Logger,
  portfolioRouting?: PortfolioRoutingEntry[],
): BrokersConfig {
  const path = resolve(configDir, "brokers.json");
  if (!existsSync(path)) {
    logger.info("brokers config not found; using defaults (all disabled)", { path });
    return DEFAULTS;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new BrokersConfigError(`brokers.json: malformed JSON: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BrokersConfigError("brokers.json: top-level must be an object");
  }
  const root = raw as Record<string, unknown>;

  // Forward-compat: log + skip unknown brokers (e.g. "ibkr" landing later).
  for (const key of Object.keys(root)) {
    if (key !== "schwab" && key !== "_doc") {
      logger.warn("brokers.json: unknown broker key ignored", { key });
    }
  }

  const schwab = parseSchwabConfig(root.schwab, logger);
  const config: BrokersConfig = { schwab };

  // Validate portfolio→account references when routing hints are provided.
  if (portfolioRouting && portfolioRouting.length > 0) {
    validatePortfolioRouting(portfolioRouting, config);
  }

  return config;
}

// ── Resolver ──────────────────────────────────────────────────────

/**
 * Resolve the Schwab account to use for a given portfolio.
 *
 * Resolution order:
 *   1. If `accountId` is provided and matches an enabled account → return it.
 *   2. Fall back to the first enabled account in the config.
 *   3. Return null if no enabled account exists.
 *
 * Callers (M12-3, M12-4, M12-6) should treat a null return as a
 * hard-stop — no enabled account means order routing cannot proceed.
 */
export function resolveAccountForPortfolio(
  config: BrokersConfig,
  accountId: string | undefined,
): SchwabAccountConfig | null {
  const { accounts } = config.schwab;

  if (accountId !== undefined) {
    const match = accounts.find((a) => a.id === accountId && a.enabled);
    if (match !== undefined) return match;
    // Specified account exists but is disabled or missing → fall through
    // to first-enabled. Callers that need strict routing should check the
    // return value and decide whether to abort.
  }

  return accounts.find((a) => a.enabled) ?? null;
}

// ── Internal parsers ──────────────────────────────────────────────

function parseSchwabConfig(raw: unknown, logger: Logger): SchwabBrokerConfig {
  if (raw === undefined) return { accounts: [{ ...DEFAULT_ACCOUNT }] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BrokersConfigError("brokers.json: schwab must be an object");
  }
  const obj = raw as Record<string, unknown>;

  // ── Legacy shape detection ───────────────────────────────────────
  // If `accounts` is absent but `enabled` is present, this is a QF-242
  // legacy config. Synthesise a single "default" account and warn.
  if (obj.accounts === undefined && obj.enabled !== undefined) {
    logger.warn(
      "brokers.json: schwab uses the legacy single-account shape; " +
        "please migrate to { accounts: [ { id, label, enabled, ... } ] }",
    );
    const account = parseLegacySchwabAccount(obj);
    return { accounts: [account] };
  }

  // ── New multi-account shape ──────────────────────────────────────
  if (obj.accounts !== undefined) {
    // Reject any fields alongside "accounts" that don't belong.
    const knownTopLevel = new Set(["accounts"]);
    for (const key of Object.keys(obj)) {
      if (!knownTopLevel.has(key)) {
        throw new BrokersConfigError(
          `brokers.json: schwab: unexpected field "${key}" alongside accounts[]`,
        );
      }
    }
    return { accounts: parseAccountsArray(obj.accounts) };
  }

  // Neither legacy nor new shape — treat as empty/defaults.
  return { accounts: [{ ...DEFAULT_ACCOUNT }] };
}

function parseLegacySchwabAccount(obj: Record<string, unknown>): SchwabAccountConfig {
  const account: SchwabAccountConfig = {
    id: "default",
    label: "default",
    enabled: false,
  };

  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new BrokersConfigError("brokers.json: schwab.enabled must be a boolean");
    }
    account.enabled = obj.enabled;
  }

  if (obj.submit_timeout_ms !== undefined) {
    account.submit_timeout_ms = parsePositiveNumber(
      obj.submit_timeout_ms,
      "schwab.submit_timeout_ms",
    );
  }
  if (obj.query_timeout_ms !== undefined) {
    account.query_timeout_ms = parsePositiveNumber(obj.query_timeout_ms, "schwab.query_timeout_ms");
  }

  const knownLegacyFields = new Set(["enabled", "submit_timeout_ms", "query_timeout_ms"]);
  for (const key of Object.keys(obj)) {
    if (!knownLegacyFields.has(key)) {
      throw new BrokersConfigError(`brokers.json: schwab: unknown field "${key}"`);
    }
  }

  return account;
}

function parseAccountsArray(raw: unknown): SchwabAccountConfig[] {
  if (!Array.isArray(raw)) {
    throw new BrokersConfigError("brokers.json: schwab.accounts must be an array");
  }
  if (raw.length === 0) {
    throw new BrokersConfigError("brokers.json: schwab.accounts must not be empty");
  }

  const accounts: SchwabAccountConfig[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new BrokersConfigError(`brokers.json: schwab.accounts[${i}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    accounts.push(parseAccountEntry(obj, i, seenIds));
  }

  // An all-disabled accounts array is a valid paper-only config — consistent
  // with the missing-file and legacy enabled=false shapes. index.ts selects
  // the first enabled account (or falls back to the paper adapter when none
  // is), so we do not force one to be enabled here.

  return accounts;
}

function parseAccountEntry(
  obj: Record<string, unknown>,
  idx: number,
  seenIds: Set<string>,
): SchwabAccountConfig {
  const prefix = `brokers.json: schwab.accounts[${idx}]`;

  // id: required, non-empty, slug-safe, unique
  if (obj.id === undefined || obj.id === null) {
    throw new BrokersConfigError(`${prefix}: missing required field "id"`);
  }
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new BrokersConfigError(`${prefix}: "id" must be a non-empty string`);
  }
  if (!SLUG_RE.test(obj.id)) {
    throw new BrokersConfigError(`${prefix}: "id" must match [a-z0-9_-]+ (got "${obj.id}")`);
  }
  if (seenIds.has(obj.id)) {
    throw new BrokersConfigError(`${prefix}: duplicate account id "${obj.id}"`);
  }
  seenIds.add(obj.id);

  // enabled: required boolean
  if (obj.enabled === undefined) {
    throw new BrokersConfigError(`${prefix}: missing required field "enabled"`);
  }
  if (typeof obj.enabled !== "boolean") {
    throw new BrokersConfigError(`${prefix}: "enabled" must be a boolean`);
  }

  // label: optional string, defaults to id
  let label: string = obj.id;
  if (obj.label !== undefined) {
    if (typeof obj.label !== "string" || obj.label.length === 0) {
      throw new BrokersConfigError(`${prefix}: "label" must be a non-empty string`);
    }
    label = obj.label;
  }

  const account: SchwabAccountConfig = {
    id: obj.id,
    label,
    enabled: obj.enabled,
  };

  // Optional timeouts
  if (obj.submit_timeout_ms !== undefined) {
    account.submit_timeout_ms = parsePositiveNumber(
      obj.submit_timeout_ms,
      `schwab.accounts[${idx}].submit_timeout_ms`,
    );
  }
  if (obj.query_timeout_ms !== undefined) {
    account.query_timeout_ms = parsePositiveNumber(
      obj.query_timeout_ms,
      `schwab.accounts[${idx}].query_timeout_ms`,
    );
  }

  // Reject unknown fields
  const knownFields = new Set(["id", "label", "enabled", "submit_timeout_ms", "query_timeout_ms"]);
  for (const key of Object.keys(obj)) {
    if (!knownFields.has(key)) {
      throw new BrokersConfigError(`${prefix}: unknown field "${key}"`);
    }
  }

  return account;
}

function validatePortfolioRouting(routing: PortfolioRoutingEntry[], config: BrokersConfig): void {
  const knownIds = new Set(config.schwab.accounts.map((a) => a.id));
  for (const entry of routing) {
    if (entry.accountId !== undefined && !knownIds.has(entry.accountId)) {
      throw new BrokersConfigError(
        `portfolios.json: portfolio "${entry.portfolioId}" references unknown account_id "${entry.accountId}"`,
      );
    }
  }
}

function parsePositiveNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new BrokersConfigError(`brokers.json: ${name} must be a positive number`);
  }
  return v;
}
