import { afterEach, describe, expect, it } from "vitest";
import {
  clearLegacyLayout,
  LEGACY_LAYOUT_KEY,
  measureTracks,
  MIN_TRACK_PX,
  parseTracks,
  readLegacyLayout,
  resizeTracks,
  resolveTracks,
  serializeTracks,
} from "./panel-resize.js";
import type { WorkspaceTemplate } from "../workspaces/types.js";

const TEMPLATE: WorkspaceTemplate = {
  rows: "210px 1fr 200px",
  cols: "320px 1fr 1fr 360px",
  areas: '"a a a a"',
  cells: [],
};

describe("parseTracks / serializeTracks", () => {
  it("splits and rejoins track strings, collapsing whitespace", () => {
    expect(parseTracks("210px 1fr  200px")).toEqual(["210px", "1fr", "200px"]);
    expect(serializeTracks(["210px", "1fr", "200px"])).toBe("210px 1fr 200px");
  });
});

describe("resolveTracks", () => {
  it("returns the template when there is no override", () => {
    expect(resolveTracks(TEMPLATE, undefined)).toEqual({
      rows: TEMPLATE.rows,
      cols: TEMPLATE.cols,
    });
  });

  it("applies an override with matching track counts", () => {
    const override = { rows: "260px 1fr 160px", cols: "300px 1fr 1fr 400px" };
    expect(resolveTracks(TEMPLATE, override)).toEqual(override);
  });

  it("falls back to the template when the override track count mismatches", () => {
    // Workspace later gained a 4th row; the 3-row override is stale.
    const stale = { rows: "260px 1fr 160px", cols: "300px 1fr" };
    expect(resolveTracks(TEMPLATE, stale)).toEqual({
      rows: TEMPLATE.rows,
      cols: TEMPLATE.cols,
    });
  });

  it("falls back when only the row count matches but the col count differs", () => {
    // Cols match (4), rows differ (override 2 vs template 3): a single
    // axis mismatch must still discard the whole override.
    const override = { rows: "1fr 1fr", cols: "1fr 1fr 1fr 1fr" };
    expect(resolveTracks(TEMPLATE, override)).toEqual({
      rows: TEMPLATE.rows,
      cols: TEMPLATE.cols,
    });
  });

  it("falls back when the template axis is malformed (empty)", () => {
    // A broken template (empty rows) parses to zero tracks; an override
    // with real tracks must not spuriously match it, and an equally
    // broken override must not be applied either.
    const broken: WorkspaceTemplate = { rows: "", cols: "1fr 1fr", areas: "", cells: [] };
    expect(resolveTracks(broken, { rows: "1fr", cols: "1fr 1fr" })).toEqual({
      rows: "",
      cols: "1fr 1fr",
    });
  });
});

describe("measureTracks", () => {
  it("parses a resolved getComputedStyle value into px numbers", () => {
    expect(measureTracks("320px 400px 400px 360px")).toEqual([320, 400, 400, 360]);
  });

  it("tolerates extra and irregular whitespace", () => {
    expect(measureTracks("  320px   400px\t400px  ")).toEqual([320, 400, 400]);
    expect(measureTracks("210.5px 0px")).toEqual([210.5, 0]);
  });

  it("returns null for an empty string", () => {
    expect(measureTracks("")).toBeNull();
    expect(measureTracks("   ")).toBeNull();
  });

  it("returns null for non-px / malformed tokens rather than partial data", () => {
    // calc()/fr/% never appear in a resolved computed value, but if a
    // browser surprises us we must reject the whole result so sizesPx
    // stays aligned with the tracks array.
    expect(measureTracks("320px 1fr")).toBeNull();
    expect(measureTracks("calc(50% - 10px) 400px")).toBeNull();
    expect(measureTracks("320 400")).toBeNull(); // missing units
    expect(measureTracks("12foopx")).toBeNull();
    expect(measureTracks("auto 400px")).toBeNull();
  });
});

describe("resizeTracks", () => {
  const tracks = ["320px", "1fr", "1fr", "360px"];
  const sizes = [320, 400, 400, 360];

  it("shifts size from the right track into the left one", () => {
    const next = resizeTracks(tracks, sizes, 0, 40);
    expect(next[0]).toBe("360px");
    expect(next[1]).toBe("360px");
    expect(next[2]).toBe("1fr"); // untouched tracks stay as-is
    expect(next[3]).toBe("360px");
  });

  it("clamps so the shrinking track never drops below the minimum", () => {
    const next = resizeTracks(tracks, sizes, 0, 10_000);
    // track[1] starts at 400px; cannot fall below MIN_TRACK_PX.
    expect(next[1]).toBe(`${MIN_TRACK_PX}px`);
    expect(next[0]).toBe(`${320 + (400 - MIN_TRACK_PX)}px`);
  });

  it("clamps a negative drag so the left track keeps the minimum", () => {
    const next = resizeTracks(tracks, sizes, 0, -10_000);
    expect(next[0]).toBe(`${MIN_TRACK_PX}px`);
    expect(next[1]).toBe(`${400 + (320 - MIN_TRACK_PX)}px`);
  });

  it("is a no-op for an out-of-range gutter index", () => {
    expect(resizeTracks(tracks, sizes, 3, 40)).toBe(tracks);
    expect(resizeTracks(tracks, sizes, -1, 40)).toBe(tracks);
  });
});

describe("legacy layout migration", () => {
  afterEach(() => localStorage.clear());

  it("returns undefined when there is no legacy entry", () => {
    expect(readLegacyLayout("operate")).toBeUndefined();
  });

  it("reads a per-workspace legacy override", () => {
    localStorage.setItem(
      LEGACY_LAYOUT_KEY,
      JSON.stringify({ operate: { rows: "1fr", cols: "1fr 1fr" } }),
    );
    expect(readLegacyLayout("operate")).toEqual({ rows: "1fr", cols: "1fr 1fr" });
    expect(readLegacyLayout("build")).toBeUndefined();
  });

  it("ignores a malformed legacy entry", () => {
    localStorage.setItem(LEGACY_LAYOUT_KEY, "{not json");
    expect(readLegacyLayout("operate")).toBeUndefined();
    localStorage.setItem(LEGACY_LAYOUT_KEY, JSON.stringify({ operate: { rows: 3 } }));
    expect(readLegacyLayout("operate")).toBeUndefined();
  });

  it("clears one workspace and removes the key when empty", () => {
    localStorage.setItem(
      LEGACY_LAYOUT_KEY,
      JSON.stringify({
        operate: { rows: "1fr", cols: "1fr" },
        build: { rows: "1fr", cols: "1fr" },
      }),
    );
    clearLegacyLayout("operate");
    expect(readLegacyLayout("operate")).toBeUndefined();
    expect(readLegacyLayout("build")).toBeDefined();

    clearLegacyLayout("build");
    expect(localStorage.getItem(LEGACY_LAYOUT_KEY)).toBeNull();
  });
});
