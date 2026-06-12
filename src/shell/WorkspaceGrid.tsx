import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { PANEL_REGISTRY } from "../panels/registry.js";
import type { WorkspaceDef } from "../workspaces/types.js";
import { useWorkspaceLayouts } from "../state/StateProvider.js";
import { setWorkspaceLayout } from "../lib/api.js";
import { log } from "../lib/log.js";
import {
  clearLegacyLayout,
  measureTracks,
  parseTracks,
  readLegacyLayout,
  resizeTracks,
  resolveTracks,
  serializeTracks,
} from "./panel-resize.js";

export interface WorkspaceGridProps {
  workspace: WorkspaceDef;
}

export function WorkspaceGrid({ workspace }: WorkspaceGridProps) {
  const t = workspace.template;
  const layouts = useWorkspaceLayouts();

  if (!t) {
    return (
      <div style={{ padding: 24, color: "var(--text-3)", fontSize: 12 }}>
        No template defined for workspace <code>{workspace.id}</code> — this workspace renders a
        full screen (lands in a later phase).
      </div>
    );
  }

  const override = layouts?.layouts[workspace.id];
  const base = resolveTracks(t, override);

  return (
    <ResizableGrid
      workspace={workspace}
      baseRows={base.rows}
      baseCols={base.cols}
      hasServerOverride={override !== undefined}
      serverSynced={layouts !== null}
    >
      {t.cells.map((cell, i) => {
        const Comp = PANEL_REGISTRY[cell.panel];
        return (
          <div key={`${cell.area}-${i}`} style={{ gridArea: cell.area, minWidth: 0, minHeight: 0 }}>
            <Comp />
          </div>
        );
      })}
    </ResizableGrid>
  );
}

// ── Resizable grid shell ──────────────────────────────────────────
// Renders the CSS-grid canvas plus an overlay of drag handles, one per
// internal row/column boundary. A handle drag re-sizes the two tracks
// it straddles and, on release, persists the new track strings to the
// server (which broadcasts them to the operator's other devices).

interface ResizableGridProps {
  workspace: WorkspaceDef;
  baseRows: string;
  baseCols: string;
  // Whether the server already holds an override for this workspace.
  hasServerOverride: boolean;
  // Whether the layout snapshot has arrived (null = not yet synced, so
  // we hold off the legacy migration until we know the server state).
  serverSynced: boolean;
  children: React.ReactNode;
}

function ResizableGrid({
  workspace,
  baseRows,
  baseCols,
  hasServerOverride,
  serverSynced,
  children,
}: ResizableGridProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  // Local track strings drive the live drag; they re-seed from the
  // server-resolved base whenever it changes (snapshot / WS push).
  const [rows, setRows] = useState(baseRows);
  const [cols, setCols] = useState(baseCols);
  useEffect(() => setRows(baseRows), [baseRows]);
  useEffect(() => setCols(baseCols), [baseCols]);

  // Mirror the live track strings into refs so onResize always reads the
  // current values rather than a stale closure. A server layout push
  // (another device, mid-drag) re-seeds `rows`/`cols` via the effects
  // above; without these refs an in-flight drag would measure a grid
  // already painted with the new server tracks but apply the delta to
  // the *old* parsed tracks it captured at closure-creation time —
  // misaligning sizesPx against the tracks array and corrupting sizes.
  const rowsRef = useRef(rows);
  const colsRef = useRef(cols);
  useEffect(() => {
    rowsRef.current = rows;
    colsRef.current = cols;
  }, [rows, cols]);

  const persist = useCallback(
    (nextRows: string, nextCols: string) => {
      setWorkspaceLayout(workspace.id, { rows: nextRows, cols: nextCols }).catch((e) => {
        log("warn", `workspace layout persist failed for ${workspace.id}: ${asMessage(e)}`);
      });
    },
    [workspace.id],
  );

  // One-shot localStorage → server migration. Runs only once the
  // snapshot is in and the server has no override for this workspace.
  // `migratedRef` makes it idempotent within a mount: the legacy entry
  // is cleared on the first run, but if `persist` rejects (logged, not
  // re-thrown) a later re-render with the same deps must not re-fire and
  // clobber newer server state. We mark the workspace migrated *before*
  // touching the server so a synchronous re-render can't double-migrate.
  const migratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!serverSynced || hasServerOverride) return;
    if (migratedRef.current === workspace.id) return;
    const legacy = readLegacyLayout(workspace.id);
    if (!legacy) return;
    migratedRef.current = workspace.id;
    persist(legacy.rows, legacy.cols);
    clearLegacyLayout(workspace.id);
  }, [serverSynced, hasServerOverride, workspace.id, persist]);

  const onResize = useCallback(
    (axis: "row" | "col", index: number, deltaPx: number, commit: boolean) => {
      const el = canvasRef.current;
      if (!el) return;
      const cs = getComputedStyle(el);
      // Read the live track strings from refs, not closure: a server
      // push mid-drag re-seeds rows/cols and we must parse the tracks
      // that match what the DOM is currently painting.
      const curRows = rowsRef.current;
      const curCols = colsRef.current;
      const tracks = parseTracks(axis === "row" ? curRows : curCols);
      const sizes = measureTracks(axis === "row" ? cs.gridTemplateRows : cs.gridTemplateColumns);
      // measureTracks returns null on an unparseable computed value (or
      // a count that no longer matches the tracks) — skip rather than
      // resize against misaligned sizes.
      if (!sizes || sizes.length !== tracks.length) return;
      const next = serializeTracks(resizeTracks(tracks, sizes, index, deltaPx));
      if (axis === "row") setRows(next);
      else setCols(next);
      if (commit) persist(axis === "row" ? next : curRows, axis === "row" ? curCols : next);
    },
    [persist],
  );

  const style: CSSProperties = {
    gridTemplateRows: rows,
    gridTemplateColumns: cols,
    gridTemplateAreas: workspace.template!.areas,
    position: "relative",
  };

  const rowCount = parseTracks(rows).length;
  const colCount = parseTracks(cols).length;

  return (
    <section
      ref={canvasRef}
      className="ws-canvas"
      style={style}
      aria-label={`workspace ${workspace.label}`}
    >
      {children}
      {Array.from({ length: colCount - 1 }, (_, i) => (
        <ResizeHandle key={`col-${i}`} axis="col" index={i} onResize={onResize} />
      ))}
      {Array.from({ length: rowCount - 1 }, (_, i) => (
        <ResizeHandle key={`row-${i}`} axis="row" index={i} onResize={onResize} />
      ))}
    </section>
  );
}

// ── Resize handle ─────────────────────────────────────────────────
// A thin pointer target spanning the gap between two tracks. It sits
// on the grid line via grid-column/row placement so it tracks the
// resolved track sizes without manual offset math.

interface ResizeHandleProps {
  axis: "row" | "col";
  index: number;
  onResize: (axis: "row" | "col", index: number, deltaPx: number, commit: boolean) => void;
}

function ResizeHandle({ axis, index, onResize }: ResizeHandleProps) {
  const startRef = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = axis === "col" ? e.clientX : e.clientY;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const pos = axis === "col" ? e.clientX : e.clientY;
    onResize(axis, index, pos - startRef.current, false);
    startRef.current = pos;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onResize(axis, index, 0, true);
  };

  // Place the handle on the grid line between track `index` and the
  // next one, spanning the full extent of the other axis.
  const style: CSSProperties =
    axis === "col"
      ? { gridColumn: index + 2, gridRow: "1 / -1", cursor: "col-resize" }
      : { gridRow: index + 2, gridColumn: "1 / -1", cursor: "row-resize" };

  return (
    <div
      className={`ws-resize ws-resize-${axis}`}
      style={style}
      role="separator"
      aria-orientation={axis === "col" ? "vertical" : "horizontal"}
      aria-label={`resize ${axis === "col" ? "columns" : "rows"} ${index + 1}/${index + 2}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
