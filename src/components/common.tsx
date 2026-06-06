import { useState, type ReactNode, type CSSProperties } from "react";
import { C, mono, sans } from "../lib/constants.js";
import type { ColorValue, StyleOverride } from "../types/ui.js";

// ── Pill ──────────────────────────────────────────────────────────

export interface PillProps {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  color?: ColorValue;
  small?: boolean;
}

export function Pill({ children, active, onClick, color, small }: PillProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: small ? "2px 8px" : "4px 12px",
        borderRadius: 5,
        border: `1px solid ${active ? color || C.accent : C.border}`,
        background: active ? `${color || C.accent}22` : "transparent",
        color: active ? color || C.accent : C.dim,
        fontFamily: sans,
        fontSize: small ? 10 : 12,
        fontWeight: 600,
        cursor: "pointer",
        transition: "all .12s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// ── NumIn ─────────────────────────────────────────────────────────

export interface NumInProps {
  value: number;
  onChange: (n: number) => void;
  label?: string;
  step?: number;
  min?: number;
  style?: StyleOverride;
}

export function NumIn({ value, onChange, label, step = 1, min, style = {} }: NumInProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, ...style }}>
      {label && (
        <label
          style={{
            fontSize: 9,
            fontFamily: sans,
            color: C.dim,
            textTransform: "uppercase",
            letterSpacing: 0.8,
          }}
        >
          {label}
        </label>
      )}
      <input
        type="number"
        value={draft !== null ? draft : value}
        step={step}
        min={min}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = parseFloat(raw);
          if (!isNaN(n)) onChange(n);
        }}
        onFocus={(e) => {
          setDraft(null);
          e.target.style.borderColor = C.bFocus;
        }}
        onBlur={(e) => {
          setDraft(null);
          e.target.style.borderColor = C.border;
        }}
        style={{
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 5,
          padding: "5px 8px",
          color: C.text,
          fontFamily: mono,
          fontSize: 12,
          outline: "none",
          width: "100%",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

// ── TxtIn ─────────────────────────────────────────────────────────

export interface TxtInProps {
  value: string;
  onChange: (s: string) => void;
  label?: string;
  placeholder?: string;
  style?: StyleOverride;
  type?: "text" | "password" | "email" | "url";
}

export function TxtIn({
  value,
  onChange,
  label,
  placeholder,
  style = {},
  type = "text",
}: TxtInProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, ...style }}>
      {label && (
        <label
          style={{
            fontSize: 9,
            fontFamily: sans,
            color: C.dim,
            textTransform: "uppercase",
            letterSpacing: 0.8,
          }}
        >
          {label}
        </label>
      )}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 5,
          padding: "5px 8px",
          color: C.text,
          fontFamily: sans,
          fontSize: 12,
          outline: "none",
          width: "100%",
          boxSizing: "border-box",
        }}
        onFocus={(e) => (e.target.style.borderColor = C.bFocus)}
        onBlur={(e) => (e.target.style.borderColor = C.border)}
      />
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────

export interface CardProps {
  children: ReactNode;
  style?: StyleOverride;
  title?: ReactNode;
  actions?: ReactNode;
}

export function Card({ children, style = {}, title, actions }: CardProps) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: 14,
        ...style,
      }}
    >
      {(title || actions) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          {title && (
            <h3
              style={{
                margin: 0,
                fontFamily: sans,
                fontSize: 13,
                fontWeight: 700,
                color: C.text,
                letterSpacing: 0.2,
              }}
            >
              {title}
            </h3>
          )}
          {actions && <div style={{ display: "flex", gap: 6 }}>{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Pnl ───────────────────────────────────────────────────────────

export interface PnlProps {
  value: number;
  prefix?: string;
}

export function Pnl({ value, prefix = "" }: PnlProps) {
  const c = value > 0.005 ? C.green : value < -0.005 ? C.red : C.dim;
  return (
    <span style={{ color: c, fontFamily: mono, fontWeight: 600 }}>
      {prefix}
      {value > 0.005 ? "+" : ""}
      {value.toFixed(2)}
    </span>
  );
}

// ── Btn ───────────────────────────────────────────────────────────

export interface BtnProps {
  children: ReactNode;
  onClick?: () => void;
  color?: ColorValue;
  disabled?: boolean;
  style?: CSSProperties;
}

export function Btn({ children, onClick, color = C.accent, disabled, style = {} }: BtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "5px 14px",
        borderRadius: 6,
        border: `1px solid ${color}`,
        background: `${color}18`,
        color,
        fontFamily: sans,
        fontSize: 11,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
