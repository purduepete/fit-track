/** Formatting helpers for distance, duration and pace. Pure + unit-tested. */
const MILE_M = 1609.344;
const KM_M = 1000;

export type Unit = 'mi' | 'km';

export function metersToUnit(meters: number, unit: Unit): number {
    return meters / (unit === 'mi' ? MILE_M : KM_M);
}

export function formatDistance(meters: number | null, unit: Unit, digits = 2): string {
    if (meters == null) return '—';
    return `${round(metersToUnit(meters, unit), digits)} ${unit}`;
}

const FEET_PER_METER = 3.28084;

/** Meters in the elevation unit that goes with the distance unit: feet for mi, meters for km. */
export function metersToElevation(meters: number, unit: Unit): number {
    return unit === 'mi' ? meters * FEET_PER_METER : meters;
}

export function elevationUnit(unit: Unit): 'ft' | 'm' {
    return unit === 'mi' ? 'ft' : 'm';
}

export function formatElevation(meters: number | null, unit: Unit): string {
    if (meters == null || !isFinite(meters)) return '—';
    return `${round(metersToElevation(meters, unit))} ${elevationUnit(unit)}`;
}

/** Seconds -> "H:MM:SS" (or "M:SS" when under an hour). */
export function formatDuration(seconds: number | null): string {
    if (seconds == null) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Seconds -> labeled "Hh Mm Ss" (e.g. 3725 -> "1h 2m 5s", 90 -> "1m 30s", 45 -> "45s").
 *
 * Preferred format for durations so time-related data reads as hours/minutes/seconds
 * rather than decimal values. */
export function formatHms(seconds: number | null): string {
    if (seconds == null || !isFinite(seconds)) return '—';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (sec > 0 || parts.length === 0) parts.push(`${sec}s`);
    return parts.join(' ');
}

/** Decimal minutes -> labeled "Hh Mm Ss" (see ``formatHms``). */
export function formatMinutesHms(minutes: number | null): string {
    if (minutes == null || !isFinite(minutes)) return '—';
    return formatHms(minutes * 60);
}

/** Seconds-per-unit -> "M:SS" pace string. */
export function formatPace(secPerUnit: number | null, unit: Unit): string {
    if (secPerUnit == null || !isFinite(secPerUnit) || secPerUnit <= 0) return '—';
    const m = Math.floor(secPerUnit / 60);
    const s = Math.round(secPerUnit % 60);
    const roll = s === 60 ? { m: m + 1, s: 0 } : { m, s };
    return `${roll.m}:${String(roll.s).padStart(2, '0')}/${unit}`;
}

/** Average pace (seconds per unit) from total distance + duration, or null. */
export function avgPaceSecPerUnit(meters: number | null, seconds: number | null, unit: Unit): number | null {
    if (meters == null || seconds == null || meters <= 0) return null;
    return seconds / metersToUnit(meters, unit);
}

/** Parse a naive-UTC / ISO string into a Date (assumes UTC when no offset). */
function toDate(iso: string): Date {
    return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/** Inclusive Monday-Sunday calendar dates in Pacific time, including DST. */
export function currentPacificWeek(now = new Date()): { dateFrom: string; dateTo: string } {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)!.value;
    // Use UTC only for calendar arithmetic so the browser's zone and DST cannot shift a day.
    const day = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    const dateFrom = day.toISOString().slice(0, 10);
    day.setUTCDate(day.getUTCDate() + 6);
    return { dateFrom, dateTo: day.toISOString().slice(0, 10) };
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
    const d = typeof value === 'number' ? new Date(value) : toDate(value);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function round(n: number | null, digits = 0): string {
    if (n == null) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Whole-number step count with thousands separators (e.g. 12500 -> "12,500"). */
export function formatSteps(n: number | null): string {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString();
}

/** Decimal hours -> "Hh Mm" (e.g. 6.311 -> "6h 19m", 7 -> "7h", 0.5 -> "30m"). */
export function formatHoursMinutes(hours: number | null): string {
    if (hours == null || !isFinite(hours)) return '—';
    const totalMin = Math.round(hours * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

/** ISO/naive-UTC string -> coarse "time ago" label ("just now", "5m ago", "3d ago").
 *
 * ``now`` is injectable so the output is testable. A future timestamp (clock skew
 * between server and browser) reads as "just now" rather than a negative age. */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
    if (!iso) return '—';
    const then = toDate(iso).getTime();
    if (!isFinite(then)) return '—';
    const sec = Math.round((now - then) / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}
