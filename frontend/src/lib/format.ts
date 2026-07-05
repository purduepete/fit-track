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

/** ISO/naive-UTC string -> local date+time label. */
export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function round(n: number | null, digits = 0): string {
  if (n == null) return "—";
  return n.toFixed(digits);
}
