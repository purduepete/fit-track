import { useState } from 'react';

export type SortKey =
    'date' | 'duration' | 'distance' | 'pace' | 'kcal' | 'hr' | 'maxhr' | 'power' | 'wkg' | 'cadence' | 'elev';
export type SortOrder = 'asc' | 'desc';
export interface WorkoutSort {
    key: SortKey;
    order: SortOrder;
}

// Fastest pace first; largest value first for everything else.
export const DEFAULT_ORDER: Record<SortKey, SortOrder> = {
    date: 'desc',
    duration: 'desc',
    distance: 'desc',
    pace: 'asc',
    kcal: 'desc',
    hr: 'desc',
    maxhr: 'desc',
    power: 'desc',
    wkg: 'desc',
    cadence: 'desc',
    elev: 'desc',
};

const KEY = 'fittrack_workout_sort';
const DEFAULT_SORT: WorkoutSort = { key: 'date', order: 'desc' };

function savedSort(): WorkoutSort {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
        if (value && typeof value === 'object' && 'key' in value && 'order' in value) {
            const { key, order } = value as { key: unknown; order: unknown };
            if (
                typeof key === 'string' &&
                Object.prototype.hasOwnProperty.call(DEFAULT_ORDER, key) &&
                (order === 'asc' || order === 'desc')
            ) {
                return { key: key as SortKey, order };
            }
        }
    } catch {
        // Unavailable or malformed storage falls back to newest first.
    }
    return DEFAULT_SORT;
}

export function useWorkoutSort() {
    const [sort, setSortState] = useState<WorkoutSort>(savedSort);
    const setSort = (next: WorkoutSort) => {
        setSortState(next);
        try {
            localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
            // The choice still applies for this visit.
        }
    };
    return { sort, setSort };
}

type Row = {
    uuid: string;
    start_utc: string;
    duration_sec: number | null;
    distance_m: number | null;
    active_energy_kcal: number | null;
    avg_hr: number | null;
    max_hr: number | null;
    average_watts?: number | null;
    watts_per_kg?: number | null;
    average_cadence?: number | null;
    elevation_gain_m: number | null;
};

function sortValue(row: Row, key: SortKey): number | string | null {
    switch (key) {
        case 'date':
            return row.start_utc;
        case 'duration':
            return row.duration_sec;
        case 'distance':
            return row.distance_m;
        case 'pace':
            return row.distance_m != null && row.distance_m > 0 && row.duration_sec != null
                ? row.duration_sec / row.distance_m
                : null;
        case 'kcal':
            return row.active_energy_kcal;
        case 'hr':
            return row.avg_hr;
        case 'maxhr':
            return row.max_hr;
        case 'power':
            return row.average_watts ?? null;
        case 'wkg':
            return row.watts_per_kg ?? null;
        case 'cadence':
            return row.average_cadence ?? null;
        case 'elev':
            return row.elevation_gain_m;
    }
}

const compare = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);

/** Same order as the server: missing values last, then newest first. */
export function sortWorkouts<T extends Row>(rows: T[], { key, order }: WorkoutSort): T[] {
    const direction = order === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const left = sortValue(a, key);
        const right = sortValue(b, key);
        if (left == null || right == null) {
            if (left != null) return -1;
            if (right != null) return 1;
        } else {
            const result = compare(left, right) * direction;
            if (result) return result;
        }
        return compare(b.start_utc, a.start_utc) || compare(b.uuid, a.uuid);
    });
}
