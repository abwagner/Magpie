// ── Strategy config store (portfolios.json-backed) ────────────────
// Owns the read/write path for the per-strategy `config` slice of
// `config/portfolios.json`. Surfaced via /api/strategies/:id/config so
// the GUI's Settings → Models → Strategies screen can edit the knobs
// (cooldown timers, signal-staleness, strategy-specific params) the
// live runner consumes at boot.
//
// QF-59. The original ticket flagged hot-reload as "the tricky part";
// at v1 the runner isn't wired into the server yet, so changes take
// effect at next supervisor / runner start — no cached config to
// invalidate. When the runner does land, it reads portfolios.json on
// start; document the "save → restart to apply" semantics in the GUI.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────
// Mirror the on-disk shape rather than re-stating it as a typed
// portfolio model; the store stays loose so future portfolio fields
// pass through untouched.

export interface StrategyConfigEntry {
  module: string;
  config: Record<string, unknown>;
  signal_interests: string[];
  signal_staleness_seconds: number;
}

export interface StrategySummary {
  portfolio: string;
  id: string;
  module: string;
  signal_interests: string[];
  signal_staleness_seconds: number;
  // Surfaced so the GUI can render a compact preview without a
  // second roundtrip; full edit happens against the GET endpoint.
  config_keys: string[];
}

export class StrategyConfigError extends Error {
  public readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "StrategyConfigError";
  }
}

// ── Store ─────────────────────────────────────────────────────────

export interface StrategyConfigStoreOpts {
  portfoliosJsonPath: string;
  logger: Logger;
  /** Optional change hook — fires after a successful PUT. */
  onChange?: (portfolio: string, strategyId: string) => void;
}

interface PortfoliosFile {
  portfolios: Record<string, PortfolioEntry>;
}

interface PortfolioEntry {
  strategies?: Record<string, Partial<StrategyConfigEntry>>;
  [k: string]: unknown;
}

export class StrategyConfigStore {
  private readonly path: string;
  private readonly logger: Logger;
  private readonly onChange?: (portfolio: string, strategyId: string) => void;

  constructor(opts: StrategyConfigStoreOpts) {
    this.path = opts.portfoliosJsonPath;
    this.logger = opts.logger;
    if (opts.onChange) this.onChange = opts.onChange;
  }

  async list(): Promise<StrategySummary[]> {
    const file = await this.readFile();
    const out: StrategySummary[] = [];
    for (const [portfolio, entry] of Object.entries(file.portfolios ?? {})) {
      for (const [strategyId, cfg] of Object.entries(entry.strategies ?? {})) {
        out.push({
          portfolio,
          id: strategyId,
          module: cfg.module ?? "",
          signal_interests: Array.isArray(cfg.signal_interests) ? cfg.signal_interests : [],
          signal_staleness_seconds:
            typeof cfg.signal_staleness_seconds === "number" ? cfg.signal_staleness_seconds : 0,
          config_keys: Object.keys(cfg.config ?? {}),
        });
      }
    }
    return out;
  }

  async get(portfolio: string, strategyId: string): Promise<StrategyConfigEntry> {
    const file = await this.readFile();
    const entry = file.portfolios?.[portfolio];
    if (!entry) {
      throw new StrategyConfigError(`portfolio not found: ${portfolio}`, 404);
    }
    const cfg = entry.strategies?.[strategyId];
    if (!cfg) {
      throw new StrategyConfigError(
        `strategy not found in portfolio ${portfolio}: ${strategyId}`,
        404,
      );
    }
    return {
      module: cfg.module ?? "",
      config: (cfg.config as Record<string, unknown>) ?? {},
      signal_interests: Array.isArray(cfg.signal_interests) ? cfg.signal_interests : [],
      signal_staleness_seconds:
        typeof cfg.signal_staleness_seconds === "number" ? cfg.signal_staleness_seconds : 0,
    };
  }

  /**
   * Replace a strategy's `config`, `signal_interests`, and
   * `signal_staleness_seconds`. `module` is NOT writable here —
   * the module path is structural and changing it via the GUI would
   * silently break the runner's import path on next boot.
   */
  async update(
    portfolio: string,
    strategyId: string,
    patch: Partial<Omit<StrategyConfigEntry, "module">>,
  ): Promise<StrategyConfigEntry> {
    validatePatch(patch);

    const file = await this.readFile();
    const entry = file.portfolios?.[portfolio];
    if (!entry) {
      throw new StrategyConfigError(`portfolio not found: ${portfolio}`, 404);
    }
    if (!entry.strategies) {
      throw new StrategyConfigError(
        `strategy not found in portfolio ${portfolio}: ${strategyId}`,
        404,
      );
    }
    const existing = entry.strategies[strategyId];
    if (!existing) {
      throw new StrategyConfigError(
        `strategy not found in portfolio ${portfolio}: ${strategyId}`,
        404,
      );
    }

    const merged: Partial<StrategyConfigEntry> = {
      module: existing.module,
      config:
        patch.config !== undefined
          ? patch.config
          : ((existing.config as Record<string, unknown>) ?? {}),
      signal_interests:
        patch.signal_interests !== undefined
          ? patch.signal_interests
          : Array.isArray(existing.signal_interests)
            ? existing.signal_interests
            : [],
      signal_staleness_seconds:
        patch.signal_staleness_seconds !== undefined
          ? patch.signal_staleness_seconds
          : typeof existing.signal_staleness_seconds === "number"
            ? existing.signal_staleness_seconds
            : 0,
    };
    entry.strategies[strategyId] = merged;

    await this.persist(file);
    this.onChange?.(portfolio, strategyId);
    this.logger.info("strategy config updated", { portfolio, strategy: strategyId });

    return merged as StrategyConfigEntry;
  }

  /**
   * Pin (or re-pin) the drift baseline QO archive URL for a strategy.
   * Writes `drift.baseline_qo_run` into the strategy's `config` block
   * so the slow-tier can read it from DriftSpec.baseline_qo_run.
   * Operator-only; baseline promotion is a risk decision (drift-detector.md §4).
   *
   * @throws StrategyConfigError (404) when the portfolio or strategy is not found.
   */
  async pinDriftBaseline(
    portfolio: string,
    strategyId: string,
    baselineQoRun: string,
  ): Promise<{ strategy_id: string; portfolio: string; baseline_qo_run: string }> {
    const file = await this.readFile();
    const entry = file.portfolios?.[portfolio];
    if (!entry) {
      throw new StrategyConfigError(`portfolio not found: ${portfolio}`, 404);
    }
    if (!entry.strategies?.[strategyId]) {
      throw new StrategyConfigError(
        `strategy not found in portfolio ${portfolio}: ${strategyId}`,
        404,
      );
    }
    const existing = entry.strategies[strategyId]!;
    const existingConfig = (existing.config as Record<string, unknown>) ?? {};
    const existingDrift = (existingConfig.drift as Record<string, unknown>) ?? {};
    existing.config = {
      ...existingConfig,
      drift: { ...existingDrift, baseline_qo_run: baselineQoRun },
    };

    await this.persist(file);
    this.onChange?.(portfolio, strategyId);
    this.logger.info("strategy.drift-baseline-pinned", {
      portfolio,
      strategy_id: strategyId,
      baseline_qo_run: baselineQoRun,
    });

    return { strategy_id: strategyId, portfolio, baseline_qo_run: baselineQoRun };
  }

  private async readFile(): Promise<PortfoliosFile> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as PortfoliosFile;
      if (!parsed || typeof parsed !== "object" || typeof parsed.portfolios !== "object") {
        throw new StrategyConfigError("portfolios.json: expected { portfolios: { ... } }", 500);
      }
      return parsed;
    } catch (e) {
      if (e instanceof StrategyConfigError) throw e;
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new StrategyConfigError(`portfolios.json not found at ${this.path}`, 500);
      }
      throw new StrategyConfigError(`portfolios.json: parse error (${err.message})`, 500);
    }
  }

  private async persist(file: PortfoliosFile): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const content = JSON.stringify(file, null, 2) + "\n";
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, this.path);
  }
}

// ── Validation ────────────────────────────────────────────────────

function validatePatch(patch: Partial<Omit<StrategyConfigEntry, "module">>): void {
  if (patch.config !== undefined) {
    if (typeof patch.config !== "object" || patch.config === null || Array.isArray(patch.config)) {
      throw new StrategyConfigError("config must be an object");
    }
  }
  if (patch.signal_interests !== undefined) {
    if (!Array.isArray(patch.signal_interests)) {
      throw new StrategyConfigError("signal_interests must be an array of NATS subject strings");
    }
    for (const s of patch.signal_interests) {
      if (typeof s !== "string" || s.length === 0) {
        throw new StrategyConfigError("signal_interests entries must be non-empty strings");
      }
    }
  }
  if (patch.signal_staleness_seconds !== undefined) {
    if (
      typeof patch.signal_staleness_seconds !== "number" ||
      patch.signal_staleness_seconds < 0 ||
      !Number.isFinite(patch.signal_staleness_seconds)
    ) {
      throw new StrategyConfigError(
        "signal_staleness_seconds must be a non-negative finite number",
      );
    }
  }
}
