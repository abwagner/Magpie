import type { ColorMap } from "../types/ui.js";

// ── Color palette ─────────────────────────────────────────────────

export const C: ColorMap = {
  bg: "#060a12",
  surface: "#0d1321",
  surfAlt: "#131b2e",
  border: "#1a2340",
  bFocus: "#3b82f6",
  text: "#dfe6f0",
  dim: "#526180",
  accent: "#3b82f6",
  aGlow: "rgba(59,130,246,0.1)",
  green: "#10b981",
  gDim: "rgba(16,185,129,0.08)",
  red: "#ef4444",
  rDim: "rgba(239,68,68,0.08)",
  amber: "#f59e0b",
  purple: "#a78bfa",
  cyan: "#22d3ee",
};

// ── Fonts ─────────────────────────────────────────────────────────

export const mono = "'JetBrains Mono','Fira Code','SF Mono',monospace";
export const sans = "'DM Sans','Instrument Sans',system-ui,sans-serif";

// ── Scenario defaults ─────────────────────────────────────────────

export interface Scenario {
  id: number;
  name: string;
  prob: number;
  priceMove: number;
  iv_shift: number;
}

let _scId = 0;
export const scId = (): number => ++_scId;

export const DFLT_SC: Scenario[] = [
  { id: scId(), name: "Crash", prob: 0.05, priceMove: -0.3, iv_shift: 0.15 },
  { id: scId(), name: "Bear", prob: 0.15, priceMove: -0.12, iv_shift: 0.05 },
  { id: scId(), name: "Flat", prob: 0.4, priceMove: 0, iv_shift: -0.02 },
  { id: scId(), name: "Bull", prob: 0.25, priceMove: 0.1, iv_shift: -0.03 },
  { id: scId(), name: "Spike", prob: 0.15, priceMove: 0.35, iv_shift: 0.1 },
];

// ── Helpers ───────────────────────────────────────────────────────

export function formatAge(ts: number | null | undefined, now: number): string | null {
  if (!ts) return null;
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function pickDefault6mo(dates: string[]): string {
  if (!dates.length) return dates[0] ?? "";
  const target = new Date();
  target.setMonth(target.getMonth() + 6);
  let best = dates[0] ?? "";
  let bestDiff = Infinity;
  for (const d of dates) {
    const diff = Math.abs(new Date(d + "T16:00:00").getTime() - target.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best;
}
