import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, clearToken } from '../lib/api';
import type { WorkoutSummary } from '../lib/api';
import { FilterSelect } from '../components/FilterSelect';
import { UnitSelector } from '../components/UnitSelector';
import { useUnit } from '../lib/useUnit';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { WeightField } from '../components/WeightField';
import { groupWorkoutDays, totalWorkouts, type WorkoutTotals } from '../lib/workoutTotals';
import { useFirstLoad } from '../lib/firstLoad';
import { usePageRefresh } from '../lib/refresh';
import {
    avgPaceSecPerUnit,
    currentPacificWeek,
    formatDistance,
    formatElevation,
    formatHms,
    formatLocalDate,
    formatLocalTime,
    formatPace,
    round,
    type Unit,
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
    const { unit, setUnit, saveError } = useUnit();
    const [range, setRange] = useState('week');
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

    // Reload from the start on a server-side filter change, refresh, or return to the view.
    // Returning to the view or refreshing keeps the current rows on screen; only a
    // filter change (rows no longer match) swaps the table for the spinner.
    useEffect(() => {
        if (!active) return;
        let live = true;
        const key = JSON.stringify([type, dateFrom, dateTo]);
        setPending(key === loadedKey.current ? 'revalidate' : 'list');
        setError(null);
        api.workouts({ type: type || undefined, dateFrom, dateTo, limit: PAGE_SIZE, offset: 0 })
            .then((res) => {
                if (!live) return;
                setItems(res.items);
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
    }, [type, dateFrom, dateTo, revision, active]);

    function loadMore() {
        setPending('more');
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
            .finally(() => setPending(null));
    }

    // Client-side text search over the loaded rows (matches type or date).
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return items;
        return items.filter(
            (w) => w.workout_type.toLowerCase().includes(q) || formatLocalDate(w.local_date).includes(q)
        );
    }, [items, search]);

    const summary = useMemo(() => totalWorkouts(filtered), [filtered]);

    // The list is newest-first, so only the oldest loaded day can continue on the next page.
    const partialDate = items.length < total && items.length > 0 ? items[items.length - 1].local_date : null;
    const groups = useMemo(() => groupWorkoutDays(filtered, partialDate), [filtered, partialDate]);
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
                                        <th>Avg power</th>
                                        <th>W/kg</th>
                                        <th>Cadence</th>
                                        <th>Elev gain</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {groups.map((g) => (
                                        <Fragment key={g.date}>
                                            <tr className="group-row">
                                                <td colSpan={COLUMNS}>
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
                                                    <td data-label="Distance">{formatDistance(w.distance_m, unit)}</td>
                                                    <td data-label="Avg pace">
                                                        {formatPace(
                                                            avgPaceSecPerUnit(w.distance_m, w.duration_sec, unit),
                                                            unit
                                                        )}
                                                    </td>
                                                    <td data-label="Active kcal">{round(w.active_energy_kcal)}</td>
                                                    <td data-label="Avg HR">{round(w.avg_hr)}</td>
                                                    <td data-label="Max HR">{round(w.max_hr)}</td>
                                                    <PowerCells
                                                        power={w.average_watts}
                                                        wkg={w.watts_per_kg}
                                                        cadence={w.average_cadence}
                                                    />
                                                    <td data-label="Elev gain">
                                                        {formatElevation(w.elevation_gain_m, unit)}
                                                    </td>
                                                </tr>
                                            ))}
                                            {g.subtotals.map(({ type: subtotalType, totals }) => (
                                                <tr key={`${g.date}-${subtotalType}-total`} className="subtotal-row">
                                                    <td data-label="Subtotal">Total</td>
                                                    <td data-label="Type">
                                                        <span>
                                                            {subtotalType} × {totals.count}
                                                        </span>
                                                    </td>
                                                    <TotalCells totals={totals} unit={unit} />
                                                </tr>
                                            ))}
                                        </Fragment>
                                    ))}
                                    {!loading && filtered.length === 0 && (
                                        <tr>
                                            <td
                                                colSpan={COLUMNS}
                                                className="muted"
                                                style={{ textAlign: 'center', padding: 32 }}
                                            >
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
                                            <td data-label="Summary">Total</td>
                                            <td data-label="Workouts">
                                                {filtered.length} {filtered.length === 1 ? 'workout' : 'workouts'}
                                            </td>
                                            <TotalCells totals={summary} unit={unit} hints />
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

const COLUMNS = 12;

function formatMetric(value: number | null | undefined, digits: number, suffix = ''): string {
    if (value == null || !isFinite(value)) return '—';
    return `${round(value, digits)}${suffix}`;
}

/** Power, W/kg and cadence cells; empty ones hide on phones so walks don't list three blanks. */
function PowerCells({
    power,
    wkg,
    cadence,
    hints = false,
}: {
    power: number | null | undefined;
    wkg: number | null | undefined;
    cadence: number | null | undefined;
    hints?: boolean;
}) {
    const empty = (value: number | null | undefined) => (value == null ? 'metric-empty' : undefined);
    const tip = (text: string) => (hints ? { 'data-tip': text, tabIndex: 0 } : {});
    return (
        <>
            <td
                data-label="Avg power"
                className={empty(power)}
                {...tip('Duration-weighted average of available workout power')}
            >
                {formatMetric(power, 0, ' W')}
            </td>
            <td data-label="W/kg" className={empty(wkg)} {...tip('Duration-weighted average of stored W/kg')}>
                {formatMetric(wkg, 2)}
            </td>
            <td data-label="Cadence" className={empty(cadence)}>
                {formatMetric(cadence, 0, ' rpm')}
            </td>
        </>
    );
}

/** Columns 3 to 12 of a subtotal or footer row. */
function TotalCells({ totals, unit, hints = false }: { totals: WorkoutTotals; unit: Unit; hints?: boolean }) {
    const tip = (text: string) => (hints ? { 'data-tip': text, tabIndex: 0 } : {});
    return (
        <>
            <td data-label="Duration">{formatHms(totals.duration)}</td>
            <td data-label="Distance">{formatDistance(totals.distance, unit)}</td>
            <td data-label="Avg pace" {...tip('Total duration / distance for rides with both values')}>
                {formatPace(avgPaceSecPerUnit(totals.paceDistance, totals.paceDuration, unit), unit)}
            </td>
            <td data-label="Active kcal">{round(totals.calories)}</td>
            <td data-label="Avg HR" {...tip('Duration-weighted average of available workout heart rates')}>
                {round(totals.avgHr)}
            </td>
            <td data-label="Max HR">{round(totals.maxHr)}</td>
            <PowerCells power={totals.avgPower} wkg={totals.avgWkg} cadence={totals.avgCadence} hints={hints} />
            <td data-label="Elev gain">{formatElevation(totals.elevation, unit)}</td>
        </>
    );
}
