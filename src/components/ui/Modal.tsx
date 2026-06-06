import { useEffect, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  body?: ReactNode;
  footer?: ReactNode;
  danger?: boolean;
  children?: ReactNode;
}

export function Modal({ open, onClose, title, body, footer, danger, children }: ModalProps) {
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
    <div
      className={`modal-overlay${danger ? " danger" : ""}`}
      onClick={onClose}
      role="presentation"
    >
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {title && <div className="modal-header">{title}</div>}
        {body !== undefined ? <div className="modal-body">{body}</div> : null}
        {children}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
