import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, clearToken } from '../lib/api';
import type { WorkoutSummary } from '../lib/api';
import { FilterSelect } from '../components/FilterSelect';
import { usePageRefresh } from '../lib/refresh';
import {
    avgPaceSecPerUnit,
    currentPacificWeek,
    formatDistance,
    formatHms,
    formatLocalDate,
    formatLocalTime,
    formatPace,
    round,
} from '../lib/format';

const PAGE_SIZE = 25;

// Week uses both bounds; other presets keep their existing lower-bound behavior.
const RANGES = [
    { key: 'week', label: 'Current week' },
    { key: '7', label: 'Last 7 days' },
    { key: '30', label: 'Last 30 days' },
    { key: '90', label: 'Last 90 days' },
    { key: '365', label: 'Last year' },
    { key: 'year', label: 'This year' },
    { key: 'all', label: 'All time' },
];

function rangeToDateFrom(key: string): string | undefined {
    if (key === 'all') return undefined;
    if (key === 'year') return `${new Date().getFullYear()}-01-01`;
    const d = new Date();
    d.setDate(d.getDate() - Number(key));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function Workouts({ onAuthError, active = true }: { onAuthError: () => void; active?: boolean }) {
    const nav = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    // Deep-link support: `/workouts?date=YYYY-MM-DD` scopes the list to a single
    // day (used by the Dashboard steps chart's workout bars). Ignore a malformed
    // value rather than forwarding it to the API.
    const rawDate = searchParams.get('date');
    const dateParam = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    const [type, setType] = useState('');
    const [range, setRange] = useState('week');
    const [search, setSearch] = useState('');
    const [types, setTypes] = useState<string[]>([]);
    const [items, setItems] = useState<WorkoutSummary[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);
    const refresh = useCallback(() => setRevision((value) => value + 1), []);
    usePageRefresh(refresh, loading, active);

    const { dateFrom, dateTo } = dateParam
        ? { dateFrom: dateParam, dateTo: dateParam }
        : range === 'week'
          ? currentPacificWeek()
          : { dateFrom: rangeToDateFrom(range), dateTo: undefined };

    // A deep-linked date must not be hidden by a leftover client-side search term.
    useEffect(() => {
        if (dateParam) setSearch('');
    }, [dateParam]);

    useEffect(() => {
        if (!active) return;
        api.workoutTypes()
            .then(setTypes)
            .catch(() => setTypes([]));
    }, [revision, active]);

    // (Re)load from the start whenever a server-side filter (type/range/day) changes.
    useEffect(() => {
        if (!active) return;
        let live = true;
        setLoading(true);
        setError(null);
        api.workouts({ type: type || undefined, dateFrom, dateTo, limit: PAGE_SIZE, offset: 0 })
            .then((res) => {
                if (!live) return;
                setItems(res.items);
                setTotal(res.total);
            })
            .catch((e) => {
                if (!live) return;
                if (e instanceof ApiError && e.status === 401) {
                    clearToken();
                    onAuthError();
                } else {
                    setError(String(e));
                }
            })
            .finally(() => {
                if (live) setLoading(false);
            });
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, dateFrom, dateTo, revision, active]);

    function loadMore() {
        setLoading(true);
        api.workouts({ type: type || undefined, dateFrom, dateTo, limit: PAGE_SIZE, offset: items.length })
            .then((res) => {
                setItems((prev) => [...prev, ...res.items]);
                setTotal(res.total);
            })
            .catch((e) => {
                if (e instanceof ApiError && e.status === 401) {
                    clearToken();
                    onAuthError();
                } else {
                    setError(String(e));
                }
            })
            .finally(() => setLoading(false));
    }

    // Client-side text search over the loaded rows (matches type or date).
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return items;
        return items.filter(
            (w) => w.workout_type.toLowerCase().includes(q) || formatLocalDate(w.local_date).includes(q)
        );
    }, [items, search]);

    const summary = useMemo(() => {
        let duration: number | null = null;
        let distance: number | null = null;
        let calories: number | null = null;
        let maxHr: number | null = null;
        let paceDuration = 0;
        let paceDistance = 0;
        let hrDuration = 0;
        let hrTotal = 0;
        for (const workout of filtered) {
            if (workout.duration_sec != null) duration = (duration ?? 0) + workout.duration_sec;
            if (workout.distance_m != null) distance = (distance ?? 0) + workout.distance_m;
            if (workout.active_energy_kcal != null) calories = (calories ?? 0) + workout.active_energy_kcal;
            if (workout.max_hr != null) maxHr = Math.max(maxHr ?? workout.max_hr, workout.max_hr);
            // Only pair known distance/duration values when deriving pace.
            if (workout.distance_m != null && workout.distance_m > 0 && workout.duration_sec != null) {
                paceDuration += workout.duration_sec;
                paceDistance += workout.distance_m;
            }
            if (workout.avg_hr != null && workout.duration_sec != null && workout.duration_sec > 0) {
                hrTotal += workout.avg_hr * workout.duration_sec;
                hrDuration += workout.duration_sec;
            }
        }
        return {
            duration,
            distance,
            calories,
            pace: avgPaceSecPerUnit(paceDistance, paceDuration, 'mi'),
            avgHr: hrDuration > 0 ? hrTotal / hrDuration : null,
            maxHr,
        };
    }, [filtered]);

    // Group consecutive rows by day (the list is already newest-first).
    const groups = useMemo(() => {
        const out: { date: string; rows: WorkoutSummary[] }[] = [];
        for (const w of filtered) {
            const last = out[out.length - 1];
            if (last && last.date === w.local_date) last.rows.push(w);
            else out.push({ date: w.local_date, rows: [w] });
        }
        return out;
    }, [filtered]);

    const hasMore = items.length < total && !search;

    const typeOptions = useMemo(
        () => [{ value: '', label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))],
        [types]
    );
    const rangeOptions = useMemo(() => RANGES.map((r) => ({ value: r.key, label: r.label })), []);

    function clearDate() {
        const next = new URLSearchParams(searchParams);
        next.delete('date');
        setSearchParams(next);
    }

    return (
        <>
            <h1 className="page-title">Workouts</h1>

            <div className="toolbar">
                <FilterSelect ariaLabel="Workout type" options={typeOptions} value={type} onChange={setType} />
                <FilterSelect
                    ariaLabel="Date range"
                    options={rangeOptions}
                    value={range}
                    onChange={setRange}
                    disabled={!!dateParam}
                    title={dateParam ? 'Showing a single day — clear the day filter to use ranges' : undefined}
                />
                <input
                    type="search"
                    placeholder="Search loaded…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search workouts"
                />
            </div>

            {dateParam && (
                <div className="active-filter">
                    <span>
                        Showing workouts on <strong>{formatLocalDate(dateParam)}</strong>
                    </span>
                    <button type="button" className="active-filter-clear" onClick={clearDate}>
                        Clear
                    </button>
                </div>
            )}

            {error && <p className="error">{error}</p>}

            <div className="card" style={{ padding: 0 }}>
                <table className="stack-table">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Type</th>
                            <th>Duration</th>
                            <th>Distance</th>
                            <th>Avg pace</th>
                            <th>Active kcal</th>
                            <th>Avg HR</th>
                            <th>Max HR</th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map((g) => (
                            <Fragment key={g.date}>
                                <tr className="group-row">
                                    <td colSpan={8}>
                                        {formatLocalDate(g.date)}
                                        <span className="group-count">
                                            {g.rows.length} {g.rows.length === 1 ? 'workout' : 'workouts'}
                                        </span>
                                    </td>
                                </tr>
                                {g.rows.map((w) => (
                                    <tr key={w.uuid} onClick={() => nav(`/workouts/${w.uuid}`)}>
                                        <td data-label="Time">{formatLocalTime(w.start_utc)}</td>
                                        <td data-label="Type">
                                            <span className="chip">{w.workout_type}</span>
                                        </td>
                                        <td data-label="Duration">{formatHms(w.duration_sec)}</td>
                                        <td data-label="Distance">{formatDistance(w.distance_m, 'mi')}</td>
                                        <td data-label="Avg pace">
                                            {formatPace(avgPaceSecPerUnit(w.distance_m, w.duration_sec, 'mi'), 'mi')}
                                        </td>
                                        <td data-label="Active kcal">{round(w.active_energy_kcal)}</td>
                                        <td data-label="Avg HR">{round(w.avg_hr)}</td>
                                        <td data-label="Max HR">{round(w.max_hr)}</td>
                                    </tr>
                                ))}
                            </Fragment>
                        ))}
                        {!loading && filtered.length === 0 && (
                            <tr>
                                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 32 }}>
                                    {items.length === 0
                                        ? 'No workouts in this range. Try a wider date range or ingest an export.'
                                        : 'No loaded workouts match your search.'}
                                </td>
                            </tr>
                        )}
                    </tbody>
                    {filtered.length > 0 && (
                        <tfoot>
                            <tr className="summary-row">
                                <td data-label="Summary">Visible totals</td>
                                <td data-label="Workouts">
                                    {filtered.length} {filtered.length === 1 ? 'workout' : 'workouts'}
                                </td>
                                <td data-label="Duration">{formatHms(summary.duration)}</td>
                                <td data-label="Distance">{formatDistance(summary.distance, 'mi')}</td>
                                <td data-label="Avg pace" title="Total duration / distance for rides with both values">
                                    {formatPace(summary.pace, 'mi')}
                                </td>
                                <td data-label="Active kcal">{round(summary.calories)}</td>
                                <td
                                    data-label="Avg HR"
                                    title="Duration-weighted average of available workout heart rates"
                                >
                                    {round(summary.avgHr)}
                                </td>
                                <td data-label="Max HR">{round(summary.maxHr)}</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>

            <div className="workouts-footer">
                <span className="muted">
                    Showing {filtered.length} of {total}
                </span>
                {hasMore && (
                    <button className="btn" onClick={loadMore} disabled={loading}>
                        {loading ? 'Loading…' : 'Load more'}
                    </button>
                )}
            </div>
        </>
    );
}
