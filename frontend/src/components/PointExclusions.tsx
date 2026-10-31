import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, SlidersHorizontal, X } from 'lucide-react';
import { api, ApiError, clearToken } from '../lib/api';
import type { PointExclusionChanges, WorkoutDetail, WorkoutPoint } from '../lib/api';
import { formatDistance, formatElevation, formatLocalDateTime, formatLocalTime, round } from '../lib/format';
import type { Unit } from '../lib/format';
import { LoadingSpinner } from './LoadingSpinner';
import { useApiResource } from '../lib/useApiResource';
import { SHOW_TOOLTIPS } from '../siteSettings';

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
    const [pointsVersion, setPointsVersion] = useState(0);
    const {
        data: loaded,
        error: loadError,
        loading,
        refresh: load,
    } = useApiResource(
        async () => ({ workout, version: pointsVersion, full: await api.workout(workout.uuid, true) }),
        [workout, onAuthError, pointsVersion],
        onAuthError
    );
    const full = loaded?.workout === workout && loaded.version === pointsVersion ? loaded.full : null;
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const [saving, setSaving] = useState(false);
    const busy = saving ? 'saving' : loading || (!full && !loadError) ? 'loading' : null;
    const [error, setError] = useState('');
    const [changes, setChanges] = useState<Record<string, boolean>>({});
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    const dirty = Object.keys(changes).length > 0;

    useEffect(() => {
        if (!open || !dialog.current) return;
        const modal = dialog.current;
        const opener = trigger.current;
        const overflow = document.body.style.overflow;
        modal.showModal();
        closeButton.current?.focus();
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
            if (busy !== 'saving' && !dirty) setOpen(false);
        };
        document.addEventListener('keydown', dismiss);
        return () => document.removeEventListener('keydown', dismiss);
    }, [open, busy, dirty]);

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

    function changePoint(timestamp: string, savedExcluded: boolean, excluded: boolean) {
        setChanges((current) => {
            const next = { ...current };
            if (savedExcluded === excluded) delete next[timestamp];
            else next[timestamp] = excluded;
            return next;
        });
    }

    async function save() {
        if (!dirty || busy !== null) return;
        const request: PointExclusionChanges = { exclude: [], restore: [] };
        for (const [ts_utc, excluded] of Object.entries(changes)) {
            request[excluded ? 'exclude' : 'restore'].push({ ts_utc });
        }
        setSaving(true);
        setError('');
        try {
            await api.savePointExclusions(workout.uuid, request);
            setChanges({});
            setPointsVersion((version) => version + 1);
            setOpen(false);
            onChange();
        } catch (cause) {
            reportError(cause);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="point-editor">
            <button
                ref={trigger}
                type="button"
                className="icon-btn"
                aria-label="Manage points"
                aria-haspopup="dialog"
                aria-controls="point-editor-dialog"
                data-tip="Manage points"
                onClick={() => {
                    setChanges({});
                    setError('');
                    setOpen(true);
                }}
            >
                <SlidersHorizontal size={18} aria-hidden="true" />
            </button>
            {loadError && !open && (
                <p className="error" role="alert">
                    {loadError}
                </p>
            )}
            <dialog
                ref={dialog}
                id="point-editor-dialog"
                className="point-editor-dialog"
                aria-labelledby="point-editor-dialog-heading"
                aria-describedby="point-editor-description"
                onCancel={(event) => {
                    if (busy === 'saving' || dirty) event.preventDefault();
                    else setOpen(false);
                }}
                onClose={() => setOpen(false)}
                onClick={(event) => {
                    if (event.target !== event.currentTarget || busy === 'saving' || dirty) return;
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
                                ref={closeButton}
                                type="button"
                                className="icon-btn point-editor-close"
                                aria-label="Close workout data points"
                                disabled={busy === 'saving'}
                                onClick={() => {
                                    setChanges({});
                                    setOpen(false);
                                }}
                            >
                                <X size={18} aria-hidden="true" />
                            </button>
                        </div>
                        <p id="point-editor-description" className="muted point-editor-note">
                            Unchecked points exclude all measurements at that time from the route, charts, and splits.
                            Heart rate, distance, and elevation gain recalculate from included points; elevation gain
                            uses raw ascent. Duration and calories stay unchanged. Save applies changes across devices.
                        </p>
                        <div className="point-editor-content" aria-busy={busy !== null}>
                            {busy === 'loading' && (
                                <div className="loading-region point-editor-loading">
                                    <LoadingSpinner label="Loading workout points" />
                                </div>
                            )}
                            {busy === 'saving' && <p role="status">Saving changes...</p>}
                            {(error || loadError) && (
                                <p className="error" role="alert">
                                    {error || loadError}
                                </p>
                            )}
                            {!busy && !full && (
                                <button type="button" className="nav-btn" onClick={() => void load()}>
                                    Try again
                                </button>
                            )}
                            {full && (
                                <div className="data-enter">
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
                                                                    checked={changes[marker.ts_utc] === false}
                                                                    disabled={busy !== null}
                                                                    onChange={(event) =>
                                                                        changePoint(
                                                                            marker.ts_utc,
                                                                            true,
                                                                            !event.target.checked
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
                                                                        checked={
                                                                            !(changes[point.ts_utc] ?? point.excluded)
                                                                        }
                                                                        disabled={busy !== null}
                                                                        onChange={(event) =>
                                                                            changePoint(
                                                                                point.ts_utc,
                                                                                point.excluded,
                                                                                !event.target.checked
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
                                                    <div
                                                        className="point-editor-page-buttons"
                                                        role="group"
                                                        aria-label="Point pages"
                                                    >
                                                        <button
                                                            type="button"
                                                            className="nav-btn"
                                                            aria-label="First page"
                                                            data-tip={SHOW_TOOLTIPS ? 'First page' : undefined}
                                                            disabled={busy !== null || currentPage === 0}
                                                            onClick={() => setPage(0)}
                                                        >
                                                            <ChevronFirst size={16} aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="nav-btn"
                                                            aria-label="Previous page"
                                                            data-tip={SHOW_TOOLTIPS ? 'Previous page' : undefined}
                                                            disabled={busy !== null || currentPage === 0}
                                                            onClick={() => setPage(currentPage - 1)}
                                                        >
                                                            <ChevronLeft size={16} aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="nav-btn"
                                                            aria-label="Next page"
                                                            data-tip={SHOW_TOOLTIPS ? 'Next page' : undefined}
                                                            disabled={busy !== null || currentPage === pageCount - 1}
                                                            onClick={() => setPage(currentPage + 1)}
                                                        >
                                                            <ChevronRight size={16} aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="nav-btn"
                                                            aria-label="Last page"
                                                            data-tip={SHOW_TOOLTIPS ? 'Last page' : undefined}
                                                            disabled={busy !== null || currentPage === pageCount - 1}
                                                            onClick={() => setPage(pageCount - 1)}
                                                        >
                                                            <ChevronLast size={16} aria-hidden="true" />
                                                        </button>
                                                    </div>
                                                    <span>
                                                        Page {currentPage + 1} of {pageCount}
                                                    </span>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <p className="muted">No matching points.</p>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="point-editor-actions">
                            <button
                                type="button"
                                className="nav-btn"
                                disabled={busy !== null || !dirty}
                                onClick={() => void save()}
                            >
                                Save
                            </button>
                        </div>
                    </>
                )}
            </dialog>
        </div>
    );
}
