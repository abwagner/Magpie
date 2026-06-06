import type { ReactNode, CSSProperties } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface PanelProps {
  title?: ReactNode;
  badge?: ReactNode;
  count?: number;
  actions?: IconName[];
  onAction?: (name: IconName) => void;
  headerExtra?: ReactNode;
  dense?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Panel({
  title,
  badge,
  count,
  actions,
  onAction,
  headerExtra,
  dense,
  children,
  style,
  className,
}: PanelProps) {
  return (
    <section className={`panel${className ? " " + className : ""}`} style={style}>
      {(title || actions || headerExtra) && (
        <header className={`panel-header${dense ? " dense" : ""}`}>
          <div className="panel-title">
            {title && <span className="panel-title-text">{title}</span>}
            {typeof count === "number" && <span className="dim2">{count}</span>}
            {badge}
          </div>
          <div className="panel-actions">
            {headerExtra}
            {actions?.map((a) => (
              <button key={a} type="button" aria-label={a} onClick={() => onAction?.(a)}>
                <Icon name={a} size={12} />
              </button>
            ))}
          </div>
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
