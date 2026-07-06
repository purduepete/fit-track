/** Formatting helpers for distance, duration and pace. Pure + unit-tested. */
const MILE_M = 1609.344;
const KM_M = 1000;

export type Unit = "mi" | "km";

export function metersToUnit(meters: number, unit: Unit): number {
  return meters / (unit === "mi" ? MILE_M : KM_M);
}

export function formatDistance(meters: number | null, unit: Unit, digits = 2): string {
  if (meters == null) return "—";
  return `${metersToUnit(meters, unit).toFixed(digits)} ${unit}`;
}

/** Seconds -> "H:MM:SS" (or "M:SS" when under an hour). */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Seconds-per-unit -> "M:SS" pace string. */
export function formatPace(secPerUnit: number | null, unit: Unit): string {
  if (secPerUnit == null || !isFinite(secPerUnit) || secPerUnit <= 0) return "—";
  const m = Math.floor(secPerUnit / 60);
  const s = Math.round(secPerUnit % 60);
  const roll = s === 60 ? { m: m + 1, s: 0 } : { m, s };
  return `${roll.m}:${String(roll.s).padStart(2, "0")}/${unit}`;
}

/** Average pace (seconds per unit) from total distance + duration, or null. */
export function avgPaceSecPerUnit(
  meters: number | null,
  seconds: number | null,
  unit: Unit,
): number | null {
  if (meters == null || seconds == null || meters <= 0) return null;
  return seconds / metersToUnit(meters, unit);
}

/** Parse a naive-UTC / ISO string into a Date (assumes UTC when no offset). */
function toDate(iso: string): Date {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** A "YYYY-MM-DD" (or ISO) date string -> "MM/DD/YYYY".
 *
 * ``local_date`` is already a calendar date (no time zone), so the date part is
 * reformatted directly to avoid any UTC shift. */
export function formatLocalDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = toDate(value);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
}

/** ISO/naive-UTC string -> local date+time label ("MM/DD/YYYY HH:MM", 24-hour). */
export function formatLocalDateTime(iso: string): string {
  const d = toDate(iso);
  const date = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local time-of-day label (24-hour clock). Accepts an ISO string or epoch ms. */
export function formatLocalTime(value: string | number): string {
  const d = typeof value === "number" ? new Date(value) : toDate(value);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function round(n: number | null, digits = 0): string {
  if (n == null) return "—";
  return n.toFixed(digits);
}
