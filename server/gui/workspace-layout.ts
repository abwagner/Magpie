// ── Workspace layout store (data/workspace-layouts.json) ──────────
// QF-346. Server-side persistence for drag-resized panel layouts so a
// layout follows the operator across devices (open desktop + laptop,
// see the same grid). Today the system is single-operator: one file,
// keyed by workspace id, holds the operator's track-size overrides.
//
// Only the grid-track sizes are stored — never the template areas or
// the panel→cell mapping. That keeps the override forward-compatible
// with workspace shape changes: if a stored override no longer fits a
// workspace's track count, the client falls back to the static
// template (see src/shell/use-panel-resize.ts).
//
// Persisted atomically via write-then-rename so a concurrent reader
// never observes a half-written file. The store fires `onChange` after
// every successful write; the server wires that to a `workspace_layout`
// WebSocket push so other connected devices update live.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logger.js";

// Per-workspace track-size override. `rows` / `cols` mirror the
// CSS-grid template strings (e.g. "210px 1fr 200px") but reflect the
// operator's drag-resized sizes rather than the static template.
export interface WorkspaceLayoutOverride {
  rows: string;
  cols: string;
}

// Map of workspace id → override. Workspaces with no stored override
// are simply absent; the client renders the static template for them.
export type WorkspaceLayouts = Record<string, WorkspaceLayoutOverride>;

export interface WorkspaceLayoutsConfig {
  version: 1;
  layouts: WorkspaceLayouts;
}

class ValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLayoutValidationError";
  }
}

export interface WorkspaceLayoutStoreOpts {
  path: string;
  logger: Logger;
  onChange?: (cfg: WorkspaceLayoutsConfig) => void;
}

export class WorkspaceLayoutStore {
  private cfg: WorkspaceLayoutsConfig = { version: 1, layouts: {} };
  private readonly path: string;
  private readonly logger: Logger;
  private readonly onChange?: (cfg: WorkspaceLayoutsConfig) => void;

  constructor(opts: WorkspaceLayoutStoreOpts) {
    this.path = opts.path;
    this.logger = opts.logger;
    if (opts.onChange) this.onChange = opts.onChange;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkspaceLayoutsConfig>;
      this.cfg = normalize(parsed);
      this.logger.debug("workspace layouts loaded", {
        path: this.path,
        workspaces: Object.keys(this.cfg.layouts),
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.cfg = { version: 1, layouts: {} };
        return;
      }
      throw err;
    }
  }

  get(): WorkspaceLayoutsConfig {
    return this.cfg;
  }

  forWorkspace(id: string): WorkspaceLayoutOverride | undefined {
    return this.cfg.layouts[id];
  }

  async setLayout(id: string, override: WorkspaceLayoutOverride): Promise<WorkspaceLayoutsConfig> {
    validateId(id);
    const next: WorkspaceLayoutsConfig = {
      version: 1,
      layouts: { ...this.cfg.layouts, [id]: validateOverride(override) },
    };
    this.cfg = next;
    await this.persist();
    this.onChange?.(next);
    this.logger.info("workspace layout updated", { workspace: id });
    return next;
  }

  // Persist via write-then-rename so the file is never half-written.
  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.cfg, null, 2), "utf8");
    await fs.rename(tmp, this.path);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Bound the number of tracks a single override may declare. Only the
// grid-track *sizes* are operator-editable and a real workspace has a
// handful of rows/cols, so a generous cap still rejects a hostile
// `repeat(999999, 1fr)`-equivalent (expanded or otherwise) before it
// reaches the DOM of every connected device.
const MAX_TRACKS = 64;

// A single CSS grid track value we accept: a length/percentage/flex
// unit, `auto`, `min-content`/`max-content`, or a `minmax(...)` /
// `fit-content(...)` whose arguments are themselves simple values. This
// is deliberately a whitelist — anything outside it (calc(), repeat(),
// var(), url(), arbitrary functions) is rejected rather than persisted
// and broadcast to clients that apply it straight to the DOM.
const SIMPLE_TRACK = String.raw`(?:\d+(?:\.\d+)?(?:px|fr|%|em|rem|vh|vw|ch)|0|auto|min-content|max-content)`;
// One whole track, including functional notation that may carry its own
// internal whitespace (`minmax(80px, 1fr)`). Used with the `g` flag to
// consume tracks left-to-right; anything left over after matching is a
// rejected token.
const TRACK_TOKEN = new RegExp(
  String.raw`${SIMPLE_TRACK}|minmax\(\s*${SIMPLE_TRACK}\s*,\s*${SIMPLE_TRACK}\s*\)|fit-content\(\s*${SIMPLE_TRACK}\s*\)`,
  "g",
);

// Validate a `grid-template-rows`/`columns` string is a whitespace-
// separated list of whitelisted track values. Returns a normalized,
// single-space-collapsed string; throws ValidationError otherwise.
function validateTrackString(field: "rows" | "cols", value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ValidationError(`layout override: ${field} must be a non-empty string`);
  }
  // Walk the string consuming one whitelisted track at a time, requiring
  // only whitespace between tracks. Any gap that is not whitespace (a
  // non-whitelisted token like `calc(...)`/`repeat(...)`) is rejected.
  const tracks: string[] = [];
  let cursor = 0;
  TRACK_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRACK_TOKEN.exec(trimmed)) !== null) {
    if (trimmed.slice(cursor, m.index).trim() !== "") break;
    tracks.push(
      m[0]
        .replace(/\s*,\s*/g, ", ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")"),
    );
    cursor = m.index + m[0].length;
  }
  if (cursor === 0 || trimmed.slice(cursor).trim() !== "") {
    throw new ValidationError(`layout override: ${field} has an invalid grid track value`);
  }
  if (tracks.length > MAX_TRACKS) {
    throw new ValidationError(`layout override: ${field} has too many tracks (max ${MAX_TRACKS})`);
  }
  return tracks.join(" ");
}

function normalize(raw: Partial<WorkspaceLayoutsConfig>): WorkspaceLayoutsConfig {
  if (!raw || typeof raw !== "object") {
    throw new ValidationError("workspace-layouts.json: expected an object");
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new ValidationError(`workspace-layouts.json: unsupported version ${raw.version}`);
  }
  const layouts: WorkspaceLayouts = {};
  for (const [id, override] of Object.entries(raw.layouts ?? {})) {
    validateId(id);
    layouts[id] = validateOverride(override as Partial<WorkspaceLayoutOverride>);
  }
  return { version: 1, layouts };
}

function validateId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new ValidationError(`invalid workspace id: ${id}`);
  }
}

function validateOverride(input: Partial<WorkspaceLayoutOverride>): WorkspaceLayoutOverride {
  if (!input || typeof input !== "object") {
    throw new ValidationError("layout override must be an object");
  }
  const rows = input.rows;
  const cols = input.cols;
  if (typeof rows !== "string" || rows.trim() === "") {
    throw new ValidationError("layout override: rows must be a non-empty string");
  }
  if (typeof cols !== "string" || cols.trim() === "") {
    throw new ValidationError("layout override: cols must be a non-empty string");
  }
  return { rows: validateTrackString("rows", rows), cols: validateTrackString("cols", cols) };
}
