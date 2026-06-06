// ── Cross-component UI types ──────────────────────────────────────
// Shapes used by React components but not by the API surface. Things
// that ARE part of the API surface live in signal.ts/order.ts/etc.

// ── Color palette ─────────────────────────────────────────────────

// Keys mirror the `C` object exported from src/lib/constants.ts.
// Components that take a `color` prop should accept a `ColorToken`
// rather than a free string so typos surface at the call site.
export type ColorToken =
  | "bg"
  | "surface"
  | "surfAlt"
  | "border"
  | "bFocus"
  | "text"
  | "dim"
  | "accent"
  | "aGlow"
  | "green"
  | "gDim"
  | "red"
  | "rDim"
  | "amber"
  | "purple"
  | "cyan";

export type ColorValue = string; // resolved hex / rgba string
export type ColorMap = Record<ColorToken, ColorValue>;

// ── Tabs ──────────────────────────────────────────────────────────

export type TabId =
  | "signals"
  | "chain"
  | "probability"
  | "risk"
  | "orders"
  | "inspector"
  | "history"
  | "catalog"
  | "settings";

// ── Common props ──────────────────────────────────────────────────

import type { CSSProperties } from "react";

// Optional CSS overrides — used by Card/Btn/etc. wrappers.
export type StyleOverride = CSSProperties;
