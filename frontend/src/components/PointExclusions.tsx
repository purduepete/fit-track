import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, clearToken } from '../lib/api';
import type { WorkoutDetail, WorkoutPoint } from '../lib/api';
import { formatDistance, formatElevation, formatLocalDateTime, formatLocalTime, round } from '../lib/format';
import type { Unit } from '../lib/format';

const PAGE_SIZE = 40;

function pointTime(timestamp: string): string {
    return `${formatLocalDateTime(timestamp).slice(0, 10)} ${formatLocalTime(timestamp, true)}`;
}

function pointValues(point: WorkoutPoint, unit: Unit): string[] {
    const values: string[] = [];
    if (point.route_count)
        values.push(point.route_count === 1 ? 'Route position' : `${point.route_count} route positions`);
    if (point.elevation_m.length) {
        values.push(`Elevation ${point.elevation_m.map((value) => formatElevation(value, unit)).join(', ')}`);
    }
    if (point.heart_rate_bpm.length) {
        values.push(`Heart rate ${point.heart_rate_bpm.map((value) => round(value)).join(', ')} bpm`);
    }
    if (point.distance_m != null) {
        const prefix = point.distance_kind === 'increment' ? '+' : '';
        values.push(`Distance ${prefix}${formatDistance(point.distance_m, unit, 3)}`);
    }
    if (point.speed_mps.length) {
        const factor = unit === 'mi' ? 2.236936 : 3.6;
        const suffix = unit === 'mi' ? 'mph' : 'km/h';
        values.push(`Speed ${point.speed_mps.map((value) => round(value * factor, 1)).join(', ')} ${suffix}`);
    }
    return values.length ? values : ['Time sample'];
}

export function PointExclusions({
    workout,
    unit,
    onChange,
    onAuthError,
}: {
    workout: WorkoutDetail;
    unit: Unit;
    onChange: () => void;
    onAuthError: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [full, setFull] = useState<WorkoutDetail | null>(null);
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const [busy, setBusy] = useState<'loading' | 'saving' | null>(null);
    const [error, setError] = useState('');
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open || !dialog.current) return;
        const modal = dialog.current;
        const opener = trigger.current;
        const overflow = document.body.style.overflow;
        modal.showModal();
        document.body.style.overflow = 'hidden';
        return () => {
            modal.close();
            document.body.style.overflow = overflow;
            opener?.focus();
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const dismiss = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            if (busy !== 'saving') setOpen(false);
        };
        document.addEventListener('keydown', dismiss);
        return () => document.removeEventListener('keydown', dismiss);
    }, [open, busy]);

    const filtered = useMemo(() => {
        const search = query.trim().toLowerCase();
        const points = full?.data_points ?? [];
        if (!search) return points;
        return points.filter((point) =>
            `${pointTime(point.ts_utc)} ${pointValues(point, unit).join(' ')}`.toLowerCase().includes(search)
        );
    }, [full, query, unit]);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const currentPage = Math.min(page, pageCount - 1);
    const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    function reportError(cause: unknown) {
        if (cause instanceof ApiError && cause.status === 401) {
            clearToken();
            onAuthError();
        }
        setError(cause instanceof Error ? cause.message : 'Could not load or update workout points.');
    }

    async function load() {
        setBusy('loading');
        setError('');
        try {
            setFull(await api.workout(workout.uuid, true));
        } catch (cause) {
            setFull(null);
            reportError(cause);
        } finally {
            setBusy(null);
        }
    }

    async function update(action: () => Promise<unknown>) {
        setBusy('saving');
        setError('');
        try {
            await action();
            onChange();
            setFull(await api.workout(workout.uuid, true));
        } catch (cause) {
            setFull(null);
            reportError(cause);
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="section point-editor" aria-labelledby="point-editor-heading">
            <div className="point-editor-heading">
                <h2 id="point-editor-heading">Workout data points</h2>
                <button
                    ref={trigger}
                    type="button"
                    className="nav-btn"
                    aria-haspopup="dialog"
                    aria-controls="point-editor-dialog"
                    onClick={() => {
                        setOpen(true);
                        void load();
                    }}
                >
                    Manage points
                </button>
            </div>
            <dialog
                ref={dialog}
                id="point-editor-dialog"
                className="point-editor-dialog"
                aria-labelledby="point-editor-dialog-heading"
                aria-describedby="point-editor-description"
                onCancel={(event) => {
                    if (busy === 'saving') event.preventDefault();
                    else setOpen(false);
                }}
                onClose={() => setOpen(false)}
                onClick={(event) => {
                    if (event.target !== event.currentTarget || busy === 'saving') return;
                    const box = event.currentTarget.getBoundingClientRect();
                    if (
                        event.clientX < box.left ||
                        event.clientX > box.right ||
                        event.clientY < box.top ||
                        event.clientY > box.bottom
                    )
                        setOpen(false);
                }}
            >
                {open && (
                    <>
                        <div className="point-editor-heading">
                            <h2 id="point-editor-dialog-heading">Workout data points</h2>
                            <button
                                type="button"
                                className="nav-btn"
                                disabled={busy === 'saving'}
                                onClick={() => setOpen(false)}
                            >
                                Done
                            </button>
                        </div>
                        <p id="point-editor-description" className="muted point-editor-note">
                            Unchecked points exclude all measurements at that time from the route, charts, and splits.
                            Heart rate, distance, and elevation gain recalculate from included points; elevation gain
                            uses raw ascent. Duration and calories stay unchanged. Saves sync across devices.
                        </p>
                        <div className="point-editor-content" aria-busy={busy !== null}>
                            {busy && (
                                <p role="status">
                                    {busy === 'loading' ? 'Loading workout points...' : 'Saving change...'}
                                </p>
                            )}
                            {error && (
                                <p className="error" role="alert">
                                    {error}
                                </p>
                            )}
                            {!busy && !full && (
                                <button type="button" className="nav-btn" onClick={() => void load()}>
                                    Try again
                                </button>
                            )}
                            {full && (
                                <>
                                    {full.point_exclusions.some((marker) => !marker.matched) && (
                                        <div className="excluded-list">
                                            <h3>Missing source points</h3>
                                            <p className="muted">Check a missing point to clear its saved exclusion.</p>
                                            <ul>
                                                {full.point_exclusions
                                                    .filter((marker) => !marker.matched)
                                                    .map((marker) => (
                                                        <li key={marker.ts_utc}>
                                                            <span>{pointTime(marker.ts_utc)}</span>
                                                            <label className="point-editor-toggle">
                                                                <input
                                                                    type="checkbox"
                                                                    className="point-editor-checkbox"
                                                                    aria-label={`Use missing point ${pointTime(marker.ts_utc)}`}
                                                                    checked={false}
                                                                    disabled={busy !== null}
                                                                    onChange={() =>
                                                                        void update(() =>
                                                                            api.restorePoint(workout.uuid, marker)
                                                                        )
                                                                    }
                                                                />
                                                            </label>
                                                        </li>
                                                    ))}
                                            </ul>
                                        </div>
                                    )}
                                    <div className="point-editor-controls">
                                        <label>
                                            <span>Find time or value</span>
                                            <input
                                                type="search"
                                                value={query}
                                                placeholder="HH:mm:ss or value"
                                                disabled={busy !== null}
                                                onChange={(event) => {
                                                    setQuery(event.target.value);
                                                    setPage(0);
                                                }}
                                            />
                                        </label>
                                    </div>
                                    <p className="muted point-editor-count">
                                        {filtered.length} {filtered.length === 1 ? 'point' : 'points'}
                                        {query.trim() ? ' found' : ''}. Times are local.
                                    </p>
                                    {visible.length > 0 ? (
                                        <>
                                            <table className="point-editor-table">
                                                <thead>
                                                    <tr>
                                                        <th>Time</th>
                                                        <th>Measurements</th>
                                                        <th>Use</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {visible.map((point) => (
                                                        <tr key={point.ts_utc}>
                                                            <td>{pointTime(point.ts_utc)}</td>
                                                            <td>
                                                                <div className="point-editor-values">
                                                                    {pointValues(point, unit).map((value, index) => (
                                                                        <span key={index}>{value}</span>
                                                                    ))}
                                                                </div>
                                                            </td>
                                                            <td>
                                                                <label className="point-editor-toggle">
                                                                    <input
                                                                        type="checkbox"
                                                                        className="point-editor-checkbox"
                                                                        aria-label={`Use point ${pointTime(point.ts_utc)}`}
                                                                        checked={!point.excluded}
                                                                        disabled={busy !== null}
                                                                        onChange={() =>
                                                                            void update(() =>
                                                                                point.excluded
                                                                                    ? api.restorePoint(workout.uuid, {
                                                                                          ts_utc: point.ts_utc,
                                                                                      })
                                                                                    : api.excludePoint(
                                                                                          workout.uuid,
                                                                                          point.ts_utc
                                                                                      )
                                                                            )
                                                                        }
                                                                    />
                                                                </label>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            {pageCount > 1 && (
                                                <div className="point-editor-pagination">
                                                    <button
                                                        type="button"
                                                        className="nav-btn"
                                                        disabled={busy !== null || currentPage === 0}
                                                        onClick={() => setPage(currentPage - 1)}
                                                    >
                                                        Previous
                                                    </button>
                                                    <span>
                                                        Page {currentPage + 1} of {pageCount}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="nav-btn"
                                                        disabled={busy !== null || currentPage === pageCount - 1}
                                                        onClick={() => setPage(currentPage + 1)}
                                                    >
                                                        Next
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <p className="muted">No matching points.</p>
                                    )}
                                </>
                            )}
                        </div>
                    </>
                )}
            </dialog>
        </section>
    );
}
