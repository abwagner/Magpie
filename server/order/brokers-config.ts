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

// ── Market-data fallback policy (QF-341) ──────────────────────────
//
// Optional `marketdata` block in config/brokers.json. Defined in
// docs/tdd/marketdata-fallback.md §2. Governs the opt-in cross-broker
// fallback for read-only marketdata.rpc.* methods. Absent block → no
// fallback (today's behavior). Lives in brokers.json so the policy sits
// next to the broker definitions it references.

/** The four fallback-eligible RPC methods (TDD §1). */
export type MdFallbackMethod = "quote" | "chain" | "expirations" | "candles";

export const MD_FALLBACK_METHODS: readonly MdFallbackMethod[] = Object.freeze([
  "quote",
  "chain",
  "expirations",
  "candles",
]);

/** Per-method override of the global fallback policy (TDD §2.2). */
export interface MdMethodOverride {
  /** When set, overrides the global `fallback_enabled` for this method. */
  fallback_enabled?: boolean;
  /** When set, overrides the global `priority` for this method. */
  priority?: string[];
}

/** Parsed `marketdata` block. Always present after load (synthesised
 *  default when absent). */
export interface MarketDataFallbackConfig {
  /** Master switch. Default false = today's behavior (no fallback). */
  fallback_enabled: boolean;
  /** Global fallback order; first entry is primary. Empty when absent. */
  priority: string[];
  /** Per-method overrides keyed by the four eligible methods. */
  methods: Partial<Record<MdFallbackMethod, MdMethodOverride>>;
  /** Liveness threshold reused by the fallback selector (TDD §3.1). */
  heartbeat_stale_ms: number;
}

export interface BrokersConfig {
  schwab: SchwabBrokerConfig;
  /** MD fallback policy (QF-341). Always present after load. */
  marketdata: MarketDataFallbackConfig;
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

// Default MD fallback policy: disabled, no priority. Absent `marketdata`
// block resolves to this — identical to today's no-fallback behavior.
const DEFAULT_HEARTBEAT_STALE_MS = 30_000;

function defaultMarketDataConfig(): MarketDataFallbackConfig {
  return {
    fallback_enabled: false,
    priority: [],
    methods: {},
    heartbeat_stale_ms: DEFAULT_HEARTBEAT_STALE_MS,
  };
}

const DEFAULTS: BrokersConfig = Object.freeze({
  schwab: Object.freeze({
    accounts: [DEFAULT_ACCOUNT],
  }),
  marketdata: Object.freeze(defaultMarketDataConfig()),
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
  // `marketdata` (QF-341) is a known non-broker block, handled below.
  for (const key of Object.keys(root)) {
    if (key !== "schwab" && key !== "_doc" && key !== "marketdata") {
      logger.warn("brokers.json: unknown broker key ignored", { key });
    }
  }

  const schwab = parseSchwabConfig(root.schwab, logger);
  const marketdata = parseMarketDataConfig(root.marketdata, enabledBrokerIds(root, schwab), logger);
  const config: BrokersConfig = { schwab, marketdata };

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

// ── Market-data fallback parser (QF-341) ──────────────────────────

/**
 * Compute the set of broker ids that are enabled in this config file.
 * A `priority` entry in the marketdata block must name one of these
 * (TDD §2.3 rule 2). Schwab is "enabled" if any of its accounts is.
 * Future top-level broker keys (e.g. "ibkr") with an `enabled: true`
 * field count too, so the rule already works the day IBKR lands.
 */
function enabledBrokerIds(root: Record<string, unknown>, schwab: SchwabBrokerConfig): Set<string> {
  const ids = new Set<string>();
  if (schwab.accounts.some((a) => a.enabled)) ids.add("schwab");
  for (const [key, val] of Object.entries(root)) {
    if (key === "schwab" || key === "_doc" || key === "marketdata") continue;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      if (obj.enabled === true) ids.add(key);
    }
  }
  return ids;
}

/**
 * Parse + validate the optional `marketdata` block. Absent → defaults
 * (fallback disabled). Enforces the TDD §2.3 validation rules. Throws
 * BrokersConfigError on any violation (fail-closed: refuse to start
 * rather than route nowhere).
 */
function parseMarketDataConfig(
  raw: unknown,
  enabled: Set<string>,
  logger: Logger,
): MarketDataFallbackConfig {
  if (raw === undefined) return defaultMarketDataConfig();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BrokersConfigError("brokers.json: marketdata must be an object");
  }
  const obj = raw as Record<string, unknown>;

  // `_doc` mirrors the top-level documentation-comment convention.
  const known = new Set(["_doc", "fallback_enabled", "priority", "methods", "heartbeat_stale_ms"]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new BrokersConfigError(`brokers.json: marketdata: unknown field "${key}"`);
    }
  }

  const fallback_enabled = parseMdBoolean(obj.fallback_enabled, "marketdata.fallback_enabled");
  // The enabled-broker membership check (rule 2/4) only matters when
  // fallback will actually route. A disabled block is documentation of
  // intent and may name brokers that aren't enabled yet (the ratified
  // default ships fallback_enabled:false + priority:["ibkr","schwab"]
  // before either broker is enabled). Shape rules (array, slug, unique)
  // always apply; the membership rule is gated on fallback_enabled.
  const priority =
    obj.priority === undefined
      ? []
      : parsePriority(obj.priority, "marketdata.priority", fallback_enabled ? enabled : null);
  const heartbeat_stale_ms =
    obj.heartbeat_stale_ms === undefined
      ? DEFAULT_HEARTBEAT_STALE_MS
      : parsePositiveNumber(obj.heartbeat_stale_ms, "marketdata.heartbeat_stale_ms");
  const methods = parseMethods(obj.methods, enabled, fallback_enabled);

  // Rule 5: enabled + single-element global priority can never fall back.
  if (fallback_enabled && priority.length === 1) {
    logger.warn(
      "brokers.json: marketdata.fallback_enabled=true with a single-element priority " +
        "can never fall back (documents intent only)",
      { priority },
    );
  }

  return { fallback_enabled, priority, methods, heartbeat_stale_ms };
}

function parseMdBoolean(v: unknown, name: string): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") {
    throw new BrokersConfigError(`brokers.json: ${name} must be a boolean`);
  }
  return v;
}

/**
 * Validate a priority array (TDD §2.3 rule 2 / rule 4): non-empty array
 * of unique, slug-safe broker ids, each naming an enabled broker.
 */
function parsePriority(v: unknown, name: string, enabled: Set<string> | null): string[] {
  if (!Array.isArray(v)) {
    throw new BrokersConfigError(`brokers.json: ${name} must be an array`);
  }
  if (v.length === 0) {
    throw new BrokersConfigError(`brokers.json: ${name} must be a non-empty array`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string" || entry.length === 0 || !SLUG_RE.test(entry)) {
      throw new BrokersConfigError(
        `brokers.json: ${name} entries must be slug-safe broker ids (got ${JSON.stringify(entry)})`,
      );
    }
    if (seen.has(entry)) {
      throw new BrokersConfigError(`brokers.json: ${name} has duplicate broker id "${entry}"`);
    }
    if (enabled !== null && !enabled.has(entry)) {
      throw new BrokersConfigError(
        `brokers.json: ${name} entry "${entry}" is not an enabled broker in this file`,
      );
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Parse the per-method override map (TDD §2.3 rule 3 / rule 4). Keys are
 * restricted to the four eligible methods; unknown method keys (incl.
 * historical_chain / orders.*) are rejected.
 */
function parseMethods(
  v: unknown,
  enabled: Set<string>,
  globalFallbackEnabled: boolean,
): Partial<Record<MdFallbackMethod, MdMethodOverride>> {
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new BrokersConfigError("brokers.json: marketdata.methods must be an object");
  }
  const obj = v as Record<string, unknown>;
  const allowed = new Set<string>(MD_FALLBACK_METHODS);
  const out: Partial<Record<MdFallbackMethod, MdMethodOverride>> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!allowed.has(key)) {
      throw new BrokersConfigError(
        `brokers.json: marketdata.methods: "${key}" is not a fallback-eligible method ` +
          `(allowed: ${MD_FALLBACK_METHODS.join(", ")})`,
      );
    }
    out[key as MdFallbackMethod] = parseMethodOverride(val, key, enabled, globalFallbackEnabled);
  }
  return out;
}

function parseMethodOverride(
  v: unknown,
  method: string,
  enabled: Set<string>,
  globalFallbackEnabled: boolean,
): MdMethodOverride {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new BrokersConfigError(`brokers.json: marketdata.methods.${method} must be an object`);
  }
  const obj = v as Record<string, unknown>;
  const known = new Set(["fallback_enabled", "priority"]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new BrokersConfigError(
        `brokers.json: marketdata.methods.${method}: unknown field "${key}"`,
      );
    }
  }
  const out: MdMethodOverride = {};
  if (obj.fallback_enabled !== undefined) {
    out.fallback_enabled = parseMdBoolean(
      obj.fallback_enabled,
      `marketdata.methods.${method}.fallback_enabled`,
    );
  }
  // Membership check applies when this method's effective fallback is on
  // (its own override, or the inherited global). Shape rules always apply.
  const effectiveEnabled = out.fallback_enabled ?? globalFallbackEnabled;
  if (obj.priority !== undefined) {
    out.priority = parsePriority(
      obj.priority,
      `marketdata.methods.${method}.priority`,
      effectiveEnabled ? enabled : null,
    );
  }
  return out;
}
