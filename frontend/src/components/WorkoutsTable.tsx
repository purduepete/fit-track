import { Fragment, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { WorkoutSummary } from '../lib/api';
import {
    DEFAULT_ORDER,
    SORT_LABELS,
    VIEW_COLUMNS,
    type MetricKey,
    type SortKey,
    type WorkoutSort,
    type WorkoutView,
} from '../lib/workoutSort';
import type { WorkoutDay, WorkoutTotals } from '../lib/workoutTotals';
import {
    avgPaceSecPerUnit,
    formatDistance,
    formatElevation,
    formatHms,
    formatLocalDate,
    formatLocalTime,
    formatPace,
    round,
    type Unit,
} from '../lib/format';

type BarKey = 'distance' | 'power' | 'wkg';
type Best = Record<string, Partial<Record<BarKey, number>>>;

interface Column {
    /** Value for a single workout; bar columns also return the raw number the bar is sized by. */
    row: (w: WorkoutSummary, unit: Unit) => { text: string; value?: number | null };
    total: (t: WorkoutTotals, unit: Unit) => string;
    bar?: BarKey;
    totalTip?: string;
}

function formatMetric(value: number | null | undefined, digits: number, suffix = ''): string {
    if (value == null || !isFinite(value)) return '—';
    return `${round(value, digits)}${suffix}`;
}

const COLUMNS: Record<MetricKey, Column> = {
    distance: {
        row: (w, unit) => ({ text: formatDistance(w.distance_m, unit), value: w.distance_m }),
        total: (t, unit) => formatDistance(t.distance, unit),
        bar: 'distance',
    },
    pace: {
        row: (w, unit) => ({ text: formatPace(avgPaceSecPerUnit(w.distance_m, w.duration_sec, unit), unit) }),
        total: (t, unit) => formatPace(avgPaceSecPerUnit(t.paceDistance, t.paceDuration, unit), unit),
        totalTip: 'Total duration / distance for rides with both values',
    },
    kcal: { row: (w) => ({ text: String(round(w.active_energy_kcal)) }), total: (t) => String(round(t.calories)) },
    hr: {
        row: (w) => ({ text: String(round(w.avg_hr)) }),
        total: (t) => String(round(t.avgHr)),
        totalTip: 'Duration-weighted average of available workout heart rates',
    },
    maxhr: { row: (w) => ({ text: String(round(w.max_hr)) }), total: (t) => String(round(t.maxHr)) },
    power: {
        row: (w) => ({ text: formatMetric(w.average_watts, 0, ' W'), value: w.average_watts }),
        total: (t) => formatMetric(t.avgPower, 0, ' W'),
        bar: 'power',
        totalTip: 'Duration-weighted average of available workout power',
    },
    wkg: {
        row: (w) => ({ text: formatMetric(w.watts_per_kg, 2), value: w.watts_per_kg }),
        total: (t) => formatMetric(t.avgWkg, 2),
        bar: 'wkg',
        totalTip: 'Duration-weighted average of stored W/kg',
    },
    cadence: {
        row: (w) => ({ text: formatMetric(w.average_cadence, 0, ' rpm'), value: w.average_cadence }),
        total: (t) => formatMetric(t.avgCadence, 0, ' rpm'),
    },
    elev: {
        row: (w, unit) => ({ text: formatElevation(w.elevation_gain_m, unit) }),
        total: (t, unit) => formatElevation(t.elevation, unit),
    },
};

// Power columns are blank for walks and other workouts without a power meter.
const HIDE_WHEN_EMPTY = new Set<MetricKey>(['power', 'wkg', 'cadence']);

const barValue = (w: WorkoutSummary, key: BarKey) =>
    key === 'distance' ? w.distance_m : key === 'power' ? w.average_watts : w.watts_per_kg;

/** Best visible value per workout type, so each bar compares like with like. */
function bestByType(rows: WorkoutSummary[]): Best {
    const best: Best = {};
    for (const w of rows) {
        const entry = (best[w.workout_type] ??= {});
        for (const key of ['distance', 'power', 'wkg'] as const) {
            const value = barValue(w, key);
            if (value != null && value > 0 && value > (entry[key] ?? 0)) entry[key] = value;
        }
    }
    return best;
}

/** Workouts list: day groups with subtotals when sorted by date, otherwise a flat list. */
export function WorkoutsTable({
    rows,
    groups,
    summary,
    unit,
    view,
    sort,
    onSort,
    emptyMessage,
    onOpen,
}: {
    rows: WorkoutSummary[];
    groups: WorkoutDay[] | null;
    summary: WorkoutTotals;
    unit: Unit;
    view: WorkoutView;
    sort: WorkoutSort;
    onSort: (sort: WorkoutSort) => void;
    emptyMessage: string | null;
    onOpen: (uuid: string) => void;
}) {
    const keys = VIEW_COLUMNS[view];
    const span = keys.length + 3;
    const best = bestByType(rows);
    const row = (w: WorkoutSummary, showDate: boolean) => (
        <WorkoutRow
            key={w.uuid}
            workout={w}
            unit={unit}
            keys={keys}
            best={best[w.workout_type] ?? {}}
            showDate={showDate}
            onOpen={() => onOpen(w.uuid)}
        />
    );
    return (
        <table className={`stack-table workouts-table view-${view}`}>
            <thead>
                <tr>
                    <SortHeader label={groups ? 'Time' : 'Date'} sortKey="date" sort={sort} onSort={onSort} />
                    <th>Type</th>
                    <SortHeader label="Duration" sortKey="duration" sort={sort} onSort={onSort} />
                    {keys.map((key) => (
                        <SortHeader key={key} label={SORT_LABELS[key]} sortKey={key} sort={sort} onSort={onSort} />
                    ))}
                </tr>
            </thead>
            <tbody>
                {groups
                    ? groups.map((g) => (
                          <Fragment key={g.date}>
                              <tr className="group-row">
                                  <td colSpan={span}>
                                      {formatLocalDate(g.date)}
                                      <span className="group-count">
                                          {g.rows.length} {g.rows.length === 1 ? 'workout' : 'workouts'}
                                      </span>
                                  </td>
                              </tr>
                              {g.rows.map((w) => row(w, false))}
                              {g.subtotals.map(({ type: subtotalType, totals }) => (
                                  <tr key={`${g.date}-${subtotalType}-total`} className="subtotal-row">
                                      <td data-label="Subtotal" className="lead-time">
                                          Total
                                      </td>
                                      <td data-label="Type" className="lead-type">
                                          <span>
                                              {subtotalType} × {totals.count}
                                          </span>
                                      </td>
                                      <TotalCells totals={totals} unit={unit} keys={keys} />
                                  </tr>
                              ))}
                          </Fragment>
                      ))
                    : rows.map((w) => row(w, true))}
                {rows.length === 0 && emptyMessage && (
                    <tr>
                        <td colSpan={span} className="muted" style={{ textAlign: 'center', padding: 32 }}>
                            {emptyMessage}
                        </td>
                    </tr>
                )}
            </tbody>
            {rows.length > 0 && (
                <tfoot>
                    <tr className="summary-row">
                        <td data-label="Summary" className="lead-time">
                            Total
                        </td>
                        <td data-label="Workouts" className="lead-type">
                            {rows.length} {rows.length === 1 ? 'workout' : 'workouts'}
                        </td>
                        <TotalCells totals={summary} unit={unit} keys={keys} hints />
                    </tr>
                </tfoot>
            )}
        </table>
    );
}

/** Duration plus the view's metric cells for a subtotal or footer row. */
function TotalCells({
    totals,
    unit,
    keys,
    hints = false,
}: {
    totals: WorkoutTotals;
    unit: Unit;
    keys: MetricKey[];
    hints?: boolean;
}) {
    return (
        <>
            <td data-label="Duration" className="lead-duration">
                {formatHms(totals.duration)}
            </td>
            {keys.map((key) => {
                const column = COLUMNS[key];
                const text = column.total(totals, unit);
                const tip = hints && column.totalTip ? { 'data-tip': column.totalTip, tabIndex: 0 } : {};
                return (
                    <td
                        key={key}
                        data-label={SORT_LABELS[key]}
                        className={HIDE_WHEN_EMPTY.has(key) && text === '—' ? 'metric-empty' : undefined}
                        {...tip}
                    >
                        {text}
                    </td>
                );
            })}
        </>
    );
}

function WorkoutRow({
    workout: w,
    unit,
    keys,
    best,
    showDate,
    onOpen,
}: {
    workout: WorkoutSummary;
    unit: Unit;
    keys: MetricKey[];
    best: Partial<Record<BarKey, number>>;
    showDate: boolean;
    onOpen: () => void;
}) {
    return (
        <tr onClick={onOpen}>
            <td data-label={showDate ? 'Date' : 'Time'} className="lead-time">
                {showDate
                    ? `${formatLocalDate(w.local_date)} ${formatLocalTime(w.start_utc)}`
                    : formatLocalTime(w.start_utc)}
            </td>
            <td data-label="Type" className="lead-type">
                <span className="chip">{w.workout_type}</span>
            </td>
            <td data-label="Duration" className="lead-duration">
                {formatHms(w.duration_sec)}
            </td>
            {keys.map((key) => {
                const column = COLUMNS[key];
                const { text, value } = column.row(w, unit);
                const max = column.bar ? best[column.bar] : undefined;
                let content: ReactNode = text;
                if (column.bar && max && value != null && value > 0) {
                    content = (
                        <span className="metric-bar">
                            <span>{text}</span>
                            <span className="metric-bar-track" aria-hidden="true">
                                <span style={{ width: `${Math.round((value / max) * 100)}%` }} />
                            </span>
                        </span>
                    );
                }
                return (
                    <td
                        key={key}
                        data-label={SORT_LABELS[key]}
                        className={HIDE_WHEN_EMPTY.has(key) && value == null ? 'metric-empty' : undefined}
                    >
                        {content}
                    </td>
                );
            })}
        </tr>
    );
}

/** Column header that sorts by its column; a second click reverses the direction. */
function SortHeader({
    label,
    sortKey,
    sort,
    onSort,
}: {
    label: string;
    sortKey: SortKey;
    sort: WorkoutSort;
    onSort: (sort: WorkoutSort) => void;
}) {
    const active = sort.key === sortKey;
    const Icon = !active ? ArrowUpDown : sort.order === 'asc' ? ArrowUp : ArrowDown;
    return (
        <th aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}>
            <button
                type="button"
                className={`sort-header${active ? ' is-active' : ''}`}
                onClick={() =>
                    onSort({
                        key: sortKey,
                        order: active ? (sort.order === 'asc' ? 'desc' : 'asc') : DEFAULT_ORDER[sortKey],
                    })
                }
            >
                {label}
                <Icon size={13} aria-hidden="true" />
            </button>
        </th>
    );
}
