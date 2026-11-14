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
