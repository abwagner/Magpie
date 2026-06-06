import { useState, useMemo } from "react";
import { C, mono, sans } from "../lib/constants.js";
import { NumIn, Btn } from "./common.js";

export interface BulkLoadModalProps {
  exps: string[];
  symbol: string;
  // Original prop accepted but unused — kept for call-site parity.
  now?: number;
  onClose: () => void;
  onStart: (selected: string[], strikeLimit: number) => void;
}

export default function BulkLoadModal({ exps, onClose, onStart }: BulkLoadModalProps) {
  const cutoff6mo = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 6);
    return d;
  }, []);
  const defaultExps = useMemo(
    () => exps.filter((d) => new Date(d + "T16:00:00").getTime() <= cutoff6mo.getTime()),
    [exps, cutoff6mo],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultExps));
  const [bulkStrikes, setBulkStrikes] = useState<number>(30);

  const toggle = (exp: string) =>
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(exp)) s.delete(exp);
      else s.add(exp);
      return s;
    });
  const selectAll = () => setSelected(new Set(defaultExps));
  const selectNone = () => setSelected(new Set());
  const selectUncached = () => setSelected(new Set(defaultExps));

  const totalContracts = selected.size * bulkStrikes * 2;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.6)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: 20,
          maxWidth: 520,
          width: "100%",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontFamily: sans, fontSize: 15, fontWeight: 700, color: C.text }}>
            Bulk Load Chains
          </h3>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: C.dim,
              fontSize: 18,
              cursor: "pointer",
              padding: "0 4px",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <NumIn
            value={bulkStrikes}
            onChange={setBulkStrikes}
            label="Strike Limit"
            step={5}
            min={5}
            style={{ width: 90 }}
          />
          <div style={{ fontSize: 10, color: C.dim, fontFamily: mono, alignSelf: "center" }}>
            ~{totalContracts} credits for {selected.size} dates
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn onClick={selectAll} color={C.accent}>
            All 6mo
          </Btn>
          <Btn onClick={selectNone} color={C.dim}>
            None
          </Btn>
          <Btn onClick={selectUncached} color={C.amber}>
            Uncached Only
          </Btn>
        </div>

        <div
          style={{
            overflowY: "auto",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            minHeight: 0,
          }}
        >
          {defaultExps.map((exp) => {
            const checked = selected.has(exp);
            const dte = Math.max(
              0,
              Math.round((new Date(exp + "T16:00:00").getTime() - Date.now()) / 86400000),
            );
            return (
              <label
                key={exp}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 8px",
                  borderRadius: 5,
                  background: checked ? `${C.accent}12` : C.bg,
                  border: `1px solid ${checked ? C.accent + "44" : C.border}`,
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: mono,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(exp)}
                  style={{ accentColor: C.accent }}
                />
                <span style={{ color: C.text, flex: 1 }}>{exp}</span>
                <span style={{ color: C.dim, fontSize: 10 }}>{dte}d</span>
              </label>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            borderTop: `1px solid ${C.border}`,
            paddingTop: 12,
          }}
        >
          <Btn onClick={onClose} color={C.dim}>
            Cancel
          </Btn>
          <Btn
            onClick={() => onStart([...selected].sort(), bulkStrikes)}
            disabled={!selected.size}
            color={C.purple}
          >
            Load {selected.size} Chains
          </Btn>
        </div>
      </div>
    </div>
  );
}
