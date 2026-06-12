// ── Panel drag-resize math + persistence helpers (QF-346) ─────────
// Pure helpers for turning a CSS-grid template string into resizable
// pixel tracks and back. WorkspaceGrid renders a gutter between each
// pair of adjacent tracks; dragging a gutter calls resizeTracks() to
// shift size between the two tracks it straddles.
//
// The grid renderer keeps the template's `areas` + panel mapping
// untouched — only the row/column track *sizes* are operator-editable
// and persisted. That keeps a stored override forward-compatible: if a
// workspace later changes its track count, the override no longer
// matches and the renderer falls back to the static template.

import type { WorkspaceLayoutOverride } from "../types/ws.js";
import type { WorkspaceTemplate } from "../workspaces/types.js";

// Minimum track size in px. A drag can never collapse a panel below
// this — keeps a panel from disappearing behind its neighbour.
export const MIN_TRACK_PX = 80;

// Legacy localStorage key. Before server-side persistence (QF-346) a
// resized layout — if it had ever shipped client-side — would have
// lived here. The migration reads it once to seed the server.
export const LEGACY_LAYOUT_KEY = "qf-layout";

// ── Legacy localStorage migration ────────────────────────────────
// Before QF-346, layout lived only in the browser. A page that still
// holds a `qf-layout` entry seeds the server once on first load, then
// drops the local copy so the server becomes the source of truth.

type LegacyLayouts = Record<string, WorkspaceLayoutOverride>;

function readLegacyStore(): LegacyLayouts {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return isLegacyLayouts(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readLegacyLayout(workspaceId: string): WorkspaceLayoutOverride | undefined {
  return readLegacyStore()[workspaceId];
}

export function clearLegacyLayout(workspaceId: string): void {
  if (typeof localStorage === "undefined") return;
  const store = readLegacyStore();
  if (!(workspaceId in store)) return;
  delete store[workspaceId];
  try {
    if (Object.keys(store).length === 0) localStorage.removeItem(LEGACY_LAYOUT_KEY);
    else localStorage.setItem(LEGACY_LAYOUT_KEY, JSON.stringify(store));
  } catch {
    // Best-effort cleanup; a failed write just retries the migration
    // next load (idempotent — the server already holds the layout).
  }
}

function isLegacyLayouts(v: unknown): v is LegacyLayouts {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every(
    (o) =>
      !!o &&
      typeof o === "object" &&
      typeof (o as WorkspaceLayoutOverride).rows === "string" &&
      typeof (o as WorkspaceLayoutOverride).cols === "string",
  );
}

// Split a CSS-grid template (`"210px 1fr 200px"`) into its tracks.
export function parseTracks(template: string): string[] {
  return template.trim().split(/\s+/).filter(Boolean);
}

// Parse a *resolved* `grid-template-*` value from getComputedStyle
// ("320px 400px 400px 360px") into pixel numbers. getComputedStyle
// always resolves tracks to absolute `px` lengths, but a defensive
// parse guards against the surprises (calc(), `none`, malformed
// strings) that vary across browsers: any token that does not parse to
// a finite px length yields `null` for the whole result, and the caller
// skips the resize rather than corrupting track sizes with NaN. A
// `null` return (rather than a partial array) keeps sizesPx aligned
// with the tracks array — a partial/misaligned array would silently
// resize the wrong track.
export function measureTracks(resolved: string): number[] | null {
  const tokens = resolved.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const sizes: number[] = [];
  for (const tok of tokens) {
    // Only bare `<number>px` tokens are accepted. `parseFloat` would
    // happily read "calc(50%" as NaN and "12foo" as 12, so match the
    // exact shape first.
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(tok);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    sizes.push(n);
  }
  return sizes;
}

export function serializeTracks(tracks: string[]): string {
  return tracks.join(" ");
}

// Resolve the track strings the renderer should apply: the override if
// it has the same track counts as the template, else the template
// itself. Guards against a stale override after a workspace reshape.
export function resolveTracks(
  template: WorkspaceTemplate,
  override: WorkspaceLayoutOverride | undefined,
): { rows: string; cols: string } {
  if (!override) return { rows: template.rows, cols: template.cols };
  const rowsOk = parseTracks(override.rows).length === parseTracks(template.rows).length;
  const colsOk = parseTracks(override.cols).length === parseTracks(template.cols).length;
  if (!rowsOk || !colsOk) return { rows: template.rows, cols: template.cols };
  return { rows: override.rows, cols: override.cols };
}

// Shift `deltaPx` of size from track `index+1` into track `index`
// (the gutter between them was dragged). `sizesPx` are the measured
// pixel sizes of every track; the result is a new track-string with
// the two affected tracks pinned to px and the rest left as-is.
export function resizeTracks(
  tracks: string[],
  sizesPx: number[],
  index: number,
  deltaPx: number,
): string[] {
  if (index < 0 || index + 1 >= tracks.length) return tracks;
  const a = sizesPx[index];
  const b = sizesPx[index + 1];
  if (a === undefined || b === undefined) return tracks;
  const clamped = clampDelta(a, b, deltaPx);
  const next = [...tracks];
  next[index] = `${Math.round(a + clamped)}px`;
  next[index + 1] = `${Math.round(b - clamped)}px`;
  return next;
}

// Clamp the drag so neither neighbouring track drops below MIN_TRACK_PX.
function clampDelta(a: number, b: number, deltaPx: number): number {
  const lo = MIN_TRACK_PX - a; // most we can shrink track a (negative)
  const hi = b - MIN_TRACK_PX; // most we can grow track a (positive)
  return Math.max(lo, Math.min(hi, deltaPx));
}
