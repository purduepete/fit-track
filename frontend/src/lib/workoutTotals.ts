import type { WorkoutSummary } from './api';

export interface WorkoutTotals {
    count: number;
    duration: number | null;
    distance: number | null;
    calories: number | null;
    elevation: number | null;
    // Distance and duration from rows that have both, for overall pace.
    paceDistance: number;
    paceDuration: number;
    avgHr: number | null;
    maxHr: number | null;
    avgPower: number | null;
    avgWkg: number | null;
    avgCadence: number | null;
}

type Metric = 'avg_hr' | 'average_watts' | 'watts_per_kg' | 'average_cadence';

function addOptional(total: number | null, value: number | null | undefined): number | null {
    return value == null ? total : (total ?? 0) + value;
}

/** Duration-weighted average over rows that have the metric and a positive duration. */
function weighted(rows: WorkoutSummary[], metric: Metric): number | null {
    let sum = 0;
    let duration = 0;
    for (const row of rows) {
        const value = row[metric];
        if (value != null && row.duration_sec != null && row.duration_sec > 0) {
            sum += value * row.duration_sec;
            duration += row.duration_sec;
        }
    }
    return duration > 0 ? sum / duration : null;
}

export function totalWorkouts(rows: WorkoutSummary[]): WorkoutTotals {
    const totals: WorkoutTotals = {
        count: rows.length,
        duration: null,
        distance: null,
        calories: null,
        elevation: null,
        paceDistance: 0,
        paceDuration: 0,
        avgHr: weighted(rows, 'avg_hr'),
        maxHr: null,
        avgPower: weighted(rows, 'average_watts'),
        avgWkg: weighted(rows, 'watts_per_kg'),
        avgCadence: weighted(rows, 'average_cadence'),
    };
    for (const row of rows) {
        totals.duration = addOptional(totals.duration, row.duration_sec);
        totals.distance = addOptional(totals.distance, row.distance_m);
        totals.calories = addOptional(totals.calories, row.active_energy_kcal);
        totals.elevation = addOptional(totals.elevation, row.elevation_gain_m);
        if (row.max_hr != null) totals.maxHr = Math.max(totals.maxHr ?? row.max_hr, row.max_hr);
        if (row.distance_m != null && row.distance_m > 0 && row.duration_sec != null) {
            totals.paceDistance += row.distance_m;
            totals.paceDuration += row.duration_sec;
        }
    }
    return totals;
}

export interface WorkoutDay {
    date: string;
    rows: WorkoutSummary[];
    subtotals: { type: string; totals: WorkoutTotals }[];
}

/**
 * Group newest-first rows by day, with a subtotal for each type that has 2 or more
 * workouts that day. `partialDate` names a day that may continue on the next page;
 * it gets no subtotals until every row for it is loaded.
 */
export function groupWorkoutDays(rows: WorkoutSummary[], partialDate: string | null): WorkoutDay[] {
    const days: WorkoutDay[] = [];
    for (const row of rows) {
        const last = days[days.length - 1];
        if (last && last.date === row.local_date) last.rows.push(row);
        else days.push({ date: row.local_date, rows: [row], subtotals: [] });
    }
    for (const day of days) {
        if (day.date === partialDate) continue;
        const byType = new Map<string, WorkoutSummary[]>();
        for (const row of day.rows) byType.set(row.workout_type, [...(byType.get(row.workout_type) ?? []), row]);
        for (const [type, typeRows] of byType) {
            if (typeRows.length >= 2) day.subtotals.push({ type, totals: totalWorkouts(typeRows) });
        }
    }
    return days;
}
