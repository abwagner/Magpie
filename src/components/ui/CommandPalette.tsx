import { useEffect, useMemo, useRef, useState } from "react";

export interface CommandItem {
  id: string;
  label: string;
  kind: string;
  shortcut?: string;
  onRun: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
  placeholder?: string;
}

export function CommandPalette({
  open,
  onClose,
  items,
  placeholder = "Search workspaces, panels, actions, symbols…",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) => it.label.toLowerCase().includes(q) || it.kind.toLowerCase().includes(q),
    );
  }, [query, items]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [active, filtered.length]);

  if (!open) return null;

  const groups = new Map<string, CommandItem[]>();
  for (const it of filtered) {
    const arr = groups.get(it.kind) ?? [];
    arr.push(it);
    groups.set(it.kind, arr);
  }

  const flat = filtered;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(0, flat.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = flat[active];
      if (it) {
        it.onRun();
        onClose();
      }
    }
  }

  return (
    <div className="cmdk-overlay" onClick={onClose} role="presentation">
      <div
        className="cmdk"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label="command palette"
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="cmdk-list" role="listbox">
          {flat.length === 0 && (
            <div className="cmdk-section" style={{ padding: "16px 14px" }}>
              No matches
            </div>
          )}
          {Array.from(groups.entries()).map(([kind, group]) => (
            <div key={kind}>
              <div className="cmdk-section">{kind}</div>
              {group.map((it) => {
                const idx = flat.indexOf(it);
                return (
                  <button
                    type="button"
                    key={it.id}
                    role="option"
                    aria-selected={idx === active}
                    className={`cmdk-item${idx === active ? " active" : ""}`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => {
                      it.onRun();
                      onClose();
                    }}
                  >
                    <span>{it.label}</span>
                    <span className="cmdk-kind">{it.kind}</span>
                    {it.shortcut && <span className="cmdk-shortcut">{it.shortcut}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
