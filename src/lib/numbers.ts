// Magpie-spec number formatters. Emit the typographic minus
// (U+2212) and keep tabular widths stable. Mirrors the `fmt` object
// in docs/design_handoff_magpie/primitives.jsx.
//
// Note: src/lib/format.ts has older formatters (fmtNum returns
// "1.5K"); those stay because DataCatalog and other legacy panels
// rely on them. New panels should pull from here.

const MINUS = "−";

export function num(v: number, dp = 2): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

export function usd(v: number, dp = 2): string {
  return (
    (v < 0 ? MINUS : "") +
    "$" +
    Math.abs(v).toLocaleString("en-US", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    })
  );
}

export function signed(v: number, dp = 2): string {
  return (
    (v >= 0 ? "+" : MINUS) +
    Math.abs(v).toLocaleString("en-US", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    })
  );
}

export function pct(v: number, dp = 2): string {
  return (v >= 0 ? "+" : MINUS) + Math.abs(v).toFixed(dp) + "%";
}

export function short(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(0);
}

// "14:32:08" — fixed-width wall-clock.
export function clock(d: Date | string | number): string {
  const date = typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  return date.toLocaleTimeString("en-US", { hour12: false });
}

// "12s" / "2m" — relative age in seconds.
export function ageSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function pnlClass(v: number): "pos" | "neg" | "" {
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "";
}
