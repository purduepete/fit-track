import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, clearToken } from '../lib/api';
import type { WorkoutSummary } from '../lib/api';
import { FilterSelect } from '../components/FilterSelect';
import { UnitSelector } from '../components/UnitSelector';
import { useUnit } from '../lib/useUnit';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { WeightField } from '../components/WeightField';
import { sortWorkouts, useWorkoutSort, type WorkoutSort } from '../lib/workoutSort';
import { WorkoutsTable } from '../components/WorkoutsTable';
import { groupWorkoutDays, totalWorkouts } from '../lib/workoutTotals';
import { useFirstLoad } from '../lib/firstLoad';
import { usePageRefresh } from '../lib/refresh';
import { currentPacificWeek, formatLocalDate } from '../lib/format';

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
    const { unit, setUnit, saveError } = useUnit();
    const [range, setRange] = useState('week');
    const { sort, setSort } = useWorkoutSort();
    const sortRef = useRef(sort);
    sortRef.current = sort;
    // Bumped when a new order needs rows that aren't loaded yet.
    const [sortRequest, setSortRequest] = useState(0);
    // Order the server returned the loaded rows in; it decides which day may continue on the next page.
    const [loadedSortKey, setLoadedSortKey] = useState(sort.key);
    const byDate = sort.key === 'date';
    const [search, setSearch] = useState('');
    const [types, setTypes] = useState<string[]>([]);
    const [typesReady, setTypesReady] = useState(false);
    const [items, setItems] = useState<WorkoutSummary[]>([]);
    const [total, setTotal] = useState(0);
    const [pending, setPending] = useState<'list' | 'revalidate' | 'more' | null>('list');
    const loadedKey = useRef<string | null>(null);
    const loading = pending !== null;
    const [loaded, setLoaded] = useState(false);
    const showMoreSpinner = useDelayedLoading(pending === 'more');
    const showListRefresh = useDelayedLoading(pending === 'list');
    const [error, setError] = useState<string | null>(null);
    useFirstLoad(loaded && typesReady, Boolean(error), active);
    const [revision, setRevision] = useState(0);
    const refresh = useCallback(() => setRevision((value) => value + 1), []);
    usePageRefresh(refresh, loading, active);

    const { dateFrom, dateTo } = dateParam
        ? { dateFrom: dateParam, dateTo: dateParam }
        : range === 'week'
          ? currentPacificWeek()
          : { dateFrom: rangeToDateFrom(range), dateTo: undefined };

    const query = () => ({
        type: type || undefined,
        dateFrom,
        dateTo,
        sort: sortRef.current.key,
        order: sortRef.current.order,
    });

    // A deep-linked date must not be hidden by a leftover client-side search term.
    useEffect(() => {
        if (dateParam) setSearch('');
    }, [dateParam]);

    useEffect(() => {
        if (!active) return;
        api.workoutTypes()
            .then(setTypes)
            .catch(() => {
                setTypes([]);
                setError('Unable to load workout types.');
            })
            .finally(() => setTypesReady(true));
    }, [revision, active]);

    // Reload from the start on a server-side filter change, refresh, return to the view or a
    // sort that needs unloaded rows. Only a filter change (rows no longer match) swaps the
    // table for the spinner; the others keep the current rows on screen.
    useEffect(() => {
        if (!active) return;
        let live = true;
        const key = JSON.stringify([type, dateFrom, dateTo]);
        setPending(key === loadedKey.current ? 'revalidate' : 'list');
        setError(null);
        const requested = query();
        api.workouts({ ...requested, limit: PAGE_SIZE, offset: 0 })
            .then((res) => {
                if (!live) return;
                setItems(res.items);
                setLoadedSortKey(requested.sort);
                setTotal(res.total);
                loadedKey.current = key;
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
                if (!live) return;
                setPending(null);
                setLoaded(true);
            });
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, dateFrom, dateTo, sortRequest, revision, active]);

    function loadMore() {
        setPending('more');
        api.workouts({ ...query(), limit: PAGE_SIZE, offset: items.length })
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
            .finally(() => setPending(null));
    }

    // Sorting reorders the loaded rows at once; the server is asked only when more remain.
    function changeSort(next: WorkoutSort) {
        setSort(next);
        if (items.length < total) setSortRequest((value) => value + 1);
    }

    // Client-side text search over the loaded rows (matches type or date).
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        const rows = sortWorkouts(items, sort);
        if (!q) return rows;
        return rows.filter(
            (w) => w.workout_type.toLowerCase().includes(q) || formatLocalDate(w.local_date).includes(q)
        );
    }, [items, search, sort]);

    const summary = useMemo(() => totalWorkouts(filtered), [filtered]);

    // Rows arrive in date order, so only the last loaded day can continue on the next page.
    // Until rows in date order arrive, an incomplete list gets no daily subtotals.
    const complete = items.length >= total;
    const partialDate = complete || items.length === 0 ? null : items[items.length - 1].local_date;
    const groups = useMemo(() => {
        if (!byDate) return [];
        const days = groupWorkoutDays(filtered, partialDate);
        return complete || loadedSortKey === 'date' ? days : days.map((day) => ({ ...day, subtotals: [] }));
    }, [byDate, filtered, partialDate, complete, loadedSortKey]);
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

    if (error && !loaded) return <p className="error">{error}</p>;
    if (!loaded) {
        return (
            <>
                <h1 className="page-title">Workouts</h1>
                <div className="loading-region workouts-loading">
                    <LoadingSpinner label="Loading workouts" />
                </div>
            </>
        );
    }

    return (
        <>
            <div className="page-head">
                <h1 className="page-title">Workouts</h1>
                <div className="page-head-controls">
                    <WeightField />
                    <UnitSelector unit={unit} onChange={setUnit} saveError={saveError} />
                </div>
            </div>
            <div className="data-enter">
                <div className="toolbar">
                    <FilterSelect ariaLabel="Workout type" options={typeOptions} value={type} onChange={setType} />
                    <FilterSelect
                        ariaLabel="Date range"
                        options={rangeOptions}
                        value={range}
                        onChange={setRange}
                        disabled={!!dateParam}
                        title={dateParam ? 'Showing a single day. Clear the day filter to use ranges.' : undefined}
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

                {filtered.some((workout) => workout.point_exclusion_warning) && (
                    <p className="error" role="alert">
                        Adjusted distance or splits are unavailable for some workouts. Open a workout for details.
                    </p>
                )}

                {showListRefresh ? (
                    <div className="loading-region workouts-loading">
                        <LoadingSpinner label="Loading workouts" show />
                    </div>
                ) : (
                    <div className="data-enter">
                        <div className="card workouts-card" style={{ padding: 0 }} aria-busy={loading}>
                            <WorkoutsTable
                                rows={filtered}
                                groups={byDate ? groups : null}
                                summary={summary}
                                unit={unit}
                                sort={sort}
                                onSort={changeSort}
                                emptyMessage={
                                    loading
                                        ? null
                                        : items.length === 0
                                          ? 'No workouts in this range. Try a wider date range or ingest an export.'
                                          : 'No loaded workouts match your search.'
                                }
                                onOpen={(uuid) => nav(`/workouts/${uuid}`)}
                            />
                        </div>

                        <div className="workouts-footer">
                            <span className="muted">
                                Showing {filtered.length} of {total}
                            </span>
                            {hasMore && (
                                <button
                                    className="btn load-more-button"
                                    onClick={loadMore}
                                    disabled={loading}
                                    aria-label={showMoreSpinner ? 'Loading workouts' : undefined}
                                    aria-busy={pending === 'more'}
                                >
                                    <span className={showMoreSpinner ? 'load-more-label--hidden' : undefined}>
                                        Load more
                                    </span>
                                    {showMoreSpinner && <LoadingSpinner label="Loading workouts" small show />}
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
