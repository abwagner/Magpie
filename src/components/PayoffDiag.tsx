import { useMemo } from "react";
import { BS } from "../lib/bs.js";
import { C, mono, sans } from "../lib/constants.js";
import type { Scenario } from "../lib/constants.js";

// Payoff curve at a future hold horizon. The leg shape here is the
// chain-builder/staging shape (with strike / DTE / IV / premium),
// not the live PortfolioState.Position shape — the chain workflow
// in Build builds intent legs that don't yet have order_id /
// position_id, so PayoffLeg stays local and structural.

export type LegType = "Call" | "Put" | "Future";
export type LegDirection = "Long" | "Short";

export interface PayoffLeg {
  type: LegType;
  direction: LegDirection;
  qty: number;
  multiplier: number;
  // Options
  strike?: number;
  dte?: number;
  iv?: number;
  premium?: number;
  // Futures
  entryPrice?: number;
}

export interface PayoffDiagProps {
  positions: PayoffLeg[];
  spotPrice: number;
  scenarios: Scenario[];
  rfr?: number;
  hold?: number;
  width?: number;
  height?: number;
}

interface CurvePoint {
  x: number;
  y: number;
}

export default function PayoffDiag({
  positions,
  spotPrice: S,
  scenarios,
  rfr = 0.05,
  hold = 0,
  width: W = 700,
  height: H = 260,
}: PayoffDiagProps) {
  const p = { t: 18, r: 16, b: 32, l: 55 };
  const w = W - p.l - p.r;
  const h = H - p.t - p.b;

  const { pts, mn, mx, xLo, xHi } = useMemo(() => {
    const lo = S * 0.5;
    const hi = S * 1.5;
    const buf: CurvePoint[] = [];
    for (let i = 0; i <= 200; i++) {
      const pr = lo + ((hi - lo) * i) / 200;
      let t = 0;
      for (const q of positions) {
        const d = q.direction === "Long" ? 1 : -1;
        const n = q.qty * q.multiplier;
        if (q.type === "Future") {
          t += d * n * (pr - (q.entryPrice ?? 0));
        } else {
          const T = Math.max(((q.dte ?? 0) - hold) / 365, 0);
          const strike = q.strike ?? 0;
          const iv = q.iv ?? 0;
          const premium = q.premium ?? 0;
          const val =
            T <= 0
              ? q.type === "Call"
                ? Math.max(0, pr - strike)
                : Math.max(0, strike - pr)
              : (q.type === "Call" ? BS.call : BS.put)(pr, strike, rfr, T, iv);
          t += d * n * (val - premium);
        }
      }
      buf.push({ x: pr, y: t });
    }
    const ys = buf.map((q) => q.y);
    return {
      pts: buf,
      mn: Math.min(...ys),
      mx: Math.max(...ys),
      xLo: lo,
      xHi: hi,
    };
  }, [positions, S, rfr, hold]);

  const rng = mx - mn || 1;
  const xS = (x: number): number => p.l + ((x - xLo) / (xHi - xLo)) * w;
  const yS = (y: number): number => p.t + h - ((y - mn) / rng) * h;
  const pathD = pts
    .map((pt, i) => `${i === 0 ? "M" : "L"}${xS(pt.x).toFixed(1)},${yS(pt.y).toFixed(1)}`)
    .join(" ");
  const zY = yS(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxHeight: H }}>
      <defs>
        <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.green} stopOpacity={0.12} />
          <stop offset="50%" stopColor={C.green} stopOpacity={0.01} />
          <stop offset="50%" stopColor={C.red} stopOpacity={0.01} />
          <stop offset="100%" stopColor={C.red} stopOpacity={0.12} />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const t = mn + (rng / 5) * i;
        return (
          <g key={i}>
            <line x1={p.l} x2={W - p.r} y1={yS(t)} y2={yS(t)} stroke={C.border} strokeWidth={0.5} />
            <text
              x={p.l - 6}
              y={yS(t) + 3}
              fill={C.dim}
              fontSize={9}
              fontFamily={mono}
              textAnchor="end"
            >
              {t >= 1e3 || t <= -1e3 ? `${(t / 1e3).toFixed(1)}k` : t.toFixed(0)}
            </text>
          </g>
        );
      })}
      <line
        x1={p.l}
        x2={W - p.r}
        y1={zY}
        y2={zY}
        stroke={C.dim}
        strokeWidth={0.8}
        strokeDasharray="4,3"
      />
      <path
        d={
          pathD +
          ` L${xS(xHi).toFixed(1)},${zY.toFixed(1)} L${xS(xLo).toFixed(1)},${zY.toFixed(1)} Z`
        }
        fill="url(#pg)"
      />
      <path d={pathD} fill="none" stroke={C.accent} strokeWidth={2} />
      <line
        x1={xS(S)}
        x2={xS(S)}
        y1={p.t}
        y2={p.t + h}
        stroke={C.amber}
        strokeWidth={1}
        strokeDasharray="3,3"
      />
      <text x={xS(S)} y={p.t - 3} fill={C.amber} fontSize={9} fontFamily={mono} textAnchor="middle">
        SPOT
      </text>
      {scenarios.map((sc, i) => {
        const sp = S * (1 + sc.priceMove);
        if (sp < xLo || sp > xHi) return null;
        const seed = pts[0];
        if (!seed) return null;
        const cl = pts.reduce<CurvePoint>(
          (b, pt) => (Math.abs(pt.x - sp) < Math.abs(b.x - sp) ? pt : b),
          seed,
        );
        return (
          <g key={i}>
            <circle cx={xS(sp)} cy={yS(cl.y)} r={4} fill={C.purple} stroke={C.bg} strokeWidth={2} />
            <text
              x={xS(sp)}
              y={yS(cl.y) - 8}
              fill={C.purple}
              fontSize={8}
              fontFamily={sans}
              textAnchor="middle"
              fontWeight={600}
            >
              {sc.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
