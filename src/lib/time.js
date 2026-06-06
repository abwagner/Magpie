// ── Timestamp formatting in a fixed display timezone ─────────────
// All UI timestamps render in the zone set by VITE_APP_TIMEZONE
// (defaults to America/New_York), so server UTC timestamps show as
// Eastern Time regardless of the viewer's browser locale.

const TZ = import.meta.env?.VITE_APP_TIMEZONE || "America/New_York";

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: TZ,
});

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: TZ,
});

const dateTimeFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: TZ,
});

function toDate(iso) {
  if (!iso) return null;
  if (iso instanceof Date) return iso;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function formatTime(iso) {
  const d = toDate(iso);
  if (!d) return "";
  // Intl formatter renders "24:02:45" at midnight in some locales; normalize.
  return timeFmt.format(d).replace(/^24:/, "00:");
}

export function formatDate(iso) {
  const d = toDate(iso);
  return d ? dateFmt.format(d) : "";
}

export function formatDateTime(iso) {
  const d = toDate(iso);
  if (!d) return "";
  // en-CA emits "YYYY-MM-DD, HH:MM:SS" — strip the comma for compactness.
  return dateTimeFmt.format(d).replace(", ", " ");
}

export const APP_TIMEZONE = TZ;
