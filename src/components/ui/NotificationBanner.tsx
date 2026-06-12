import type { ReactNode } from "react";

// Generic full-width notification banner. Both the QF-228
// quote-unavailable warning and the QF-322 exit-rule close render with
// the same three-section layout (label · detail · action) and only
// differ in their data source, copy, and color variant. This component
// owns the shared structure so those banners stay thin wrappers around
// their hooks.

export type BannerVariant = "warn" | "neg";

export interface NotificationBannerProps {
  variant: BannerVariant;
  label: ReactNode;
  detail: ReactNode;
  actionLabel: ReactNode;
  onAction: () => void;
}

export function NotificationBanner({
  variant,
  label,
  detail,
  actionLabel,
  onAction,
}: NotificationBannerProps) {
  return (
    <div className={`banner-base banner--${variant}`} role="status">
      <span>{label}</span>
      <span className="banner-detail">{detail}</span>
      <button type="button" className="banner-action" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

// Shared "lead + more" helper for collapsing a list of concurrent
// events into a single banner. Returns the most-recent item plus a
// pluralized "N more …" suffix so each banner doesn't reimplement the
// count/pluralization logic.
export interface BannerLead<T> {
  lead: T;
  more: number;
}

export function bannerLead<T>(items: readonly T[]): BannerLead<T> | null {
  const lead = items[0];
  if (lead === undefined) return null;
  return { lead, more: items.length - 1 };
}

export function moreSuffix(more: number, noun: string, verb: string): string {
  if (more <= 0) return "";
  return ` · ${more} more ${noun}${more === 1 ? "" : "s"} ${verb}`;
}
