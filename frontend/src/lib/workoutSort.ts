import { useState } from 'react';
import { api } from './api';

export type SortKey =
    'date' | 'duration' | 'distance' | 'pace' | 'kcal' | 'hr' | 'maxhr' | 'power' | 'wkg' | 'cadence' | 'elev';
export type SortOrder = 'asc' | 'desc';
export interface WorkoutSort {
    key: SortKey;
    order: SortOrder;
}

/** Column sets for the Workouts table; Time, Type and Duration always show. */
export type WorkoutView = 'ride' | 'power' | 'all';
export type MetricKey = Exclude<SortKey, 'date' | 'duration'>;
export const VIEW_COLUMNS: Record<WorkoutView, MetricKey[]> = {
    ride: ['distance', 'pace', 'kcal', 'hr'],
    power: ['power', 'wkg', 'cadence', 'elev'],
    all: ['distance', 'pace', 'kcal', 'hr', 'maxhr', 'power', 'wkg', 'cadence', 'elev'],
};
export const VIEWS: { key: WorkoutView; label: string }[] = [
    { key: 'ride', label: 'Ride' },
    { key: 'power', label: 'Power' },
    { key: 'all', label: 'All' },
];
export const SORT_LABELS: Record<SortKey, string> = {
    date: 'Date',
    duration: 'Duration',
    distance: 'Distance',
    pace: 'Avg pace',
    kcal: 'Active kcal',
    hr: 'Avg HR',
    maxhr: 'Max HR',
    power: 'Avg power',
    wkg: 'Avg W/kg',
    cadence: 'Cadence',
    elev: 'Elev gain',
};

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
const VIEW_KEY = 'fittrack_workout_view';
const DEFAULT_SORT: WorkoutSort = { key: 'date', order: 'desc' };
const DEFAULT_VIEW: WorkoutView = 'ride';

function cookie(name: string): string | undefined {
    return document.cookie
        .split('; ')
        .find((value) => value.startsWith(`${name}=`))
        ?.slice(name.length + 1);
}

function parseSort(value: unknown): WorkoutSort | null {
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
    return null;
}

// Local storage first, then the server-set cookie that survives Safari's storage purge.
function savedSort(): WorkoutSort {
    try {
        const stored = parseSort(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
        if (stored) return stored;
    } catch {
        // Fall through to the cookie.
    }
    const [key, order] = (cookie(KEY) ?? '').split('.');
    return parseSort({ key, order }) ?? DEFAULT_SORT;
}

const isView = (value: unknown): value is WorkoutView => value === 'ride' || value === 'power' || value === 'all';

function savedView(): WorkoutView {
    try {
        const stored = localStorage.getItem(VIEW_KEY);
        if (isView(stored)) return stored;
    } catch {
        // Fall through to the cookie.
    }
    const fromCookie = cookie(VIEW_KEY);
    return isView(fromCookie) ? fromCookie : DEFAULT_VIEW;
}

let cookieSave: Promise<unknown> = Promise.resolve();

function persist(view: WorkoutView, sort: WorkoutSort) {
    try {
        localStorage.setItem(KEY, JSON.stringify(sort));
        localStorage.setItem(VIEW_KEY, view);
    } catch {
        // The cookie still records the choice.
    }
    // Saves run in order so the cookie keeps the last choice; a failed save leaves local storage in charge.
    const save = () => api.saveWorkoutTable({ view, sort: sort.key, order: sort.order });
    cookieSave = cookieSave.then(save, save).catch(() => undefined);
}

export function useWorkoutTable() {
    const [sort, setSortState] = useState<WorkoutSort>(savedSort);
    const [view, setViewState] = useState<WorkoutView>(savedView);
    const setSort = (next: WorkoutSort) => {
        setSortState(next);
        persist(view, next);
    };
    const setView = (next: WorkoutView) => {
        setViewState(next);
        persist(next, sort);
    };
    return { sort, setSort, view, setView };
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
