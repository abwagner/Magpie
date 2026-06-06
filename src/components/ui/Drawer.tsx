import { useEffect, type ReactNode } from "react";
import { Icon } from "./Icon.js";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  width?: number;
}

export function Drawer({ open, onClose, title, footer, children, width = 380 }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} role="presentation" />
      <aside className="drawer" style={{ width }} role="dialog" aria-modal="true">
        <header className="drawer-header">
          <span>{title}</span>
          <button
            type="button"
            aria-label="close"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-3)",
              cursor: "pointer",
              padding: 4,
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </aside>
    </>
  );
}
