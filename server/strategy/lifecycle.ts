// ── Strategy lifecycle state machine ──────────────────────────────
// Per the design's STATE_META:
//
//   registered → enabled (enable) → running (start)
//                       ↘ registered (disable)
//   running → paused (pause) → running (resume)
//          ↘ halted (halt) ↘ retired (retire)
//                          ↘ enabled  (reenable)
//                          ↘ registered (via retired → reregister)
//
// Transitions are case-sensitive named actions. The server rejects
// any action that isn't legal for the current state. Every accepted
// transition is appended to `history` and emitted as a
// `strategy_update` WS diff.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logger.js";

export type LifecycleState = "registered" | "enabled" | "running" | "paused" | "halted" | "retired";

export type LifecycleAction =
  | "enable"
  | "disable"
  | "start"
  | "pause"
  | "resume"
  | "halt"
  | "reenable"
  | "retire"
  | "reregister";

// Single source of truth — table of (from, action) → to. Tests
// exercise this directly.
export const LIFECYCLE_TRANSITIONS: ReadonlyArray<{
  from: LifecycleState;
  action: LifecycleAction;
  to: LifecycleState;
}> = [
  { from: "registered", action: "enable", to: "enabled" },
  { from: "enabled", action: "disable", to: "registered" },
  { from: "enabled", action: "start", to: "running" },
  { from: "running", action: "pause", to: "paused" },
  { from: "running", action: "halt", to: "halted" },
  { from: "paused", action: "resume", to: "running" },
  { from: "paused", action: "halt", to: "halted" },
  { from: "halted", action: "reenable", to: "enabled" },
  { from: "halted", action: "retire", to: "retired" },
  { from: "retired", action: "reregister", to: "registered" },
];

export class IllegalTransitionError extends Error {
  // Surfaced as 400 by server/index.js's generic error handler.
  public readonly status = 400;
  constructor(
    public readonly from: LifecycleState,
    public readonly action: LifecycleAction,
  ) {
    super(`illegal transition: ${from} → ${action}`);
    this.name = "IllegalTransitionError";
  }
}

class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function nextState(from: LifecycleState, action: LifecycleAction): LifecycleState {
  for (const t of LIFECYCLE_TRANSITIONS) {
    if (t.from === from && t.action === action) return t.to;
  }
  throw new IllegalTransitionError(from, action);
}

export function legalActions(from: LifecycleState): LifecycleAction[] {
  return LIFECYCLE_TRANSITIONS.filter((t) => t.from === from).map((t) => t.action);
}

// ── Strategy record ────────────────────────────────────────────────

export interface TransitionEvent {
  from: LifecycleState;
  to: LifecycleState;
  action: LifecycleAction;
  ts: string; // ISO 8601
  actor: string; // "operator" | "system" | model_id
  reason?: string;
}

// `ParamsProvenance` records which quant-optimizer run validated the
// parameters this strategy is deployed with. Optional during initial
// rollout; a future ticket promotes it to required for the
// `enabled → running` transition.
export interface ParamsProvenance {
  lineage_id: string; // UUID from wfo_results JSON (qo-run descriptor in /api/catalog)
  selected_params: Record<string, unknown>;
  selector_rule: string; // "last_fold" | "median_oos" | "manual" | etc.
  selected_at: string; // ISO 8601
}

// ── QF-351 — exit-rule headroom ──────────────────────────────────────
// Per-armed-rule evaluation snapshot derived from the exit-rule monitor.
// Streamed on strategy_update.data.exit_rules[] after each eval pass.
// headroom_pct ≤ 0 means the rule is tripped.
export interface ExitRuleHeadroom {
  rule: "stop_loss" | "target" | "max_hold" | "max_drawdown";
  threshold: number;
  actual: number;
  headroom_pct: number;
}

export interface Strategy {
  id: string;
  label: string;
  state: LifecycleState;
  manifest_revision?: string | null;
  operator_notes?: string;
  registered_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  history: TransitionEvent[];
  params_provenance?: ParamsProvenance;
  // QF-351 — per-armed-rule headroom, set by the exit-rule monitor after
  // each eval pass. Absent until the first eval completes.
  exit_rules?: ExitRuleHeadroom[];
}

export interface StrategyRegisterInput {
  id: string;
  label: string;
  manifest_revision?: string | null;
  operator_notes?: string;
}

// ── Persistence ────────────────────────────────────────────────────
// data/strategies.json. Atomic write via temp + rename so the file
// is never observed half-written by another reader.

interface PersistedShape {
  version: 1;
  strategies: Record<string, Strategy>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface StrategyStoreOpts {
  path: string;
  logger: Logger;
  now?: () => Date;
  onChange?: (s: Strategy) => void;
  // QF-324 — fires on transitions INTO 'halted' (not on no-op halt of
  // an already-halted strategy). The wired handler iterates the
  // strategy's open envelopes via pending-intents and calls the
  // envelope-revoker for each. Errors are caught at the store boundary
  // and logged; they don't fail the transition.
  onHalt?: (s: Strategy) => void | Promise<void>;
}

export class StrategyStore {
  private map: Map<string, Strategy> = new Map();
  private readonly path: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly onChange?: (s: Strategy) => void;
  private readonly onHalt?: (s: Strategy) => void | Promise<void>;

  constructor(opts: StrategyStoreOpts) {
    this.path = opts.path;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => new Date());
    if (opts.onChange) this.onChange = opts.onChange;
    if (opts.onHalt) this.onHalt = opts.onHalt;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (!parsed.strategies) {
        this.map = new Map();
        return;
      }
      this.map = new Map(Object.entries(parsed.strategies));
      this.logger.debug("strategies loaded", { count: this.map.size });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.map = new Map();
        return;
      }
      throw err;
    }
  }

  list(): Strategy[] {
    return Array.from(this.map.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): Strategy | undefined {
    return this.map.get(id);
  }

  async register(input: StrategyRegisterInput, actor = "operator"): Promise<Strategy> {
    if (!ID_RE.test(input.id)) {
      throw new ValidationError(`invalid strategy id: ${input.id}`);
    }
    if (this.map.has(input.id)) {
      throw new ValidationError(`strategy already registered: ${input.id}`);
    }
    const ts = this.now().toISOString();
    const strategy: Strategy = {
      id: input.id,
      label: input.label,
      state: "registered",
      manifest_revision: input.manifest_revision ?? null,
      operator_notes: input.operator_notes ?? "",
      registered_at: ts,
      updated_at: ts,
      history: [
        {
          from: "registered",
          to: "registered",
          action: "reregister",
          ts,
          actor,
          reason: "initial register",
        },
      ],
    };
    this.map.set(strategy.id, strategy);
    await this.persist();
    this.onChange?.(strategy);
    this.logger.info("strategy registered", { id: strategy.id });
    return strategy;
  }

  async transition(
    id: string,
    action: LifecycleAction,
    actor = "operator",
    reason?: string,
  ): Promise<Strategy> {
    const cur = this.map.get(id);
    if (!cur) {
      const err = new Error(`strategy not found: ${id}`) as Error & { status: number };
      err.status = 404;
      throw err;
    }
    const to = nextState(cur.state, action);
    const ts = this.now().toISOString();
    const event: TransitionEvent = {
      from: cur.state,
      to,
      action,
      ts,
      actor,
      ...(reason !== undefined ? { reason } : {}),
    };
    const next: Strategy = {
      ...cur,
      state: to,
      updated_at: ts,
      history: [...cur.history, event],
    };
    this.map.set(id, next);
    await this.persist();
    this.onChange?.(next);
    this.logger.info("strategy transition", {
      id,
      from: cur.state,
      to,
      action,
      actor,
    });
    // QF-324 — fire the onHalt callback when transitioning INTO halted
    // (regardless of which legal predecessor state). The wired handler
    // (server/strategy/halt-handler.ts) iterates the strategy's open
    // envelopes via pending-intents and calls envelope-revoker for each.
    // Fire-and-forget: the revoke loop runs async; the transition reply
    // doesn't block on it.
    if (to === "halted" && cur.state !== "halted") {
      void Promise.resolve(this.onHalt?.(next)).catch((err) => {
        this.logger.error("strategy onHalt handler threw", {
          id,
          error: String(err),
        });
      });
    }
    return next;
  }

  async setNotes(id: string, notes: string): Promise<Strategy> {
    const cur = this.map.get(id);
    if (!cur) {
      const err = new Error(`strategy not found: ${id}`) as Error & { status: number };
      err.status = 404;
      throw err;
    }
    const next: Strategy = {
      ...cur,
      operator_notes: notes,
      updated_at: this.now().toISOString(),
    };
    this.map.set(id, next);
    await this.persist();
    this.onChange?.(next);
    return next;
  }

  async setParamsProvenance(id: string, provenance: ParamsProvenance): Promise<Strategy> {
    const cur = this.map.get(id);
    if (!cur) {
      const err = new Error(`strategy not found: ${id}`) as Error & { status: number };
      err.status = 404;
      throw err;
    }
    // Validate the shape at the boundary so a malformed PUT body can't
    // poison data/strategies.json.
    if (!provenance.lineage_id || typeof provenance.lineage_id !== "string") {
      throw new ValidationError("params_provenance.lineage_id is required (string)");
    }
    if (typeof provenance.selector_rule !== "string" || provenance.selector_rule.length === 0) {
      throw new ValidationError("params_provenance.selector_rule is required (non-empty string)");
    }
    if (typeof provenance.selected_at !== "string" || provenance.selected_at.length === 0) {
      throw new ValidationError("params_provenance.selected_at is required (ISO 8601 string)");
    }
    if (
      provenance.selected_params == null ||
      typeof provenance.selected_params !== "object" ||
      Array.isArray(provenance.selected_params)
    ) {
      throw new ValidationError("params_provenance.selected_params is required (object)");
    }
    const next: Strategy = {
      ...cur,
      params_provenance: {
        lineage_id: provenance.lineage_id,
        selected_params: { ...provenance.selected_params },
        selector_rule: provenance.selector_rule,
        selected_at: provenance.selected_at,
      },
      updated_at: this.now().toISOString(),
    };
    this.map.set(id, next);
    await this.persist();
    this.onChange?.(next);
    this.logger.info("strategy params_provenance set", {
      id,
      lineage_id: provenance.lineage_id,
      selector_rule: provenance.selector_rule,
    });
    return next;
  }

  // Persist via write-then-rename to keep the file atomic for
  // any process tail-reading it.
  private async persist(): Promise<void> {
    const payload: PersistedShape = {
      version: 1,
      strategies: Object.fromEntries(this.map),
    };
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tmp, this.path);
  }
}
