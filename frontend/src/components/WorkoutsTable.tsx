import { Fragment } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { WorkoutSummary } from '../lib/api';
import { DEFAULT_ORDER, type SortKey, type WorkoutSort } from '../lib/workoutSort';
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

/** Workouts list: day groups with subtotals when sorted by date, otherwise a flat list. */
export function WorkoutsTable({
    rows,
    groups,
    summary,
    unit,
    sort,
    onSort,
    emptyMessage,
    onOpen,
}: {
    rows: WorkoutSummary[];
    groups: WorkoutDay[] | null;
    summary: WorkoutTotals;
    unit: Unit;
    sort: WorkoutSort;
    onSort: (sort: WorkoutSort) => void;
    emptyMessage: string | null;
    onOpen: (uuid: string) => void;
}) {
    return (
        <table className="stack-table">
            <thead>
                <tr>
                    <SortHeader label={groups ? 'Time' : 'Date'} sortKey="date" sort={sort} onSort={onSort} />
                    <th>Type</th>
                    <SortHeader label="Duration" sortKey="duration" sort={sort} onSort={onSort} />
                    <SortHeader label="Distance" sortKey="distance" sort={sort} onSort={onSort} />
                    <SortHeader label="Avg pace" sortKey="pace" sort={sort} onSort={onSort} />
                    <SortHeader label="Active kcal" sortKey="kcal" sort={sort} onSort={onSort} />
                    <SortHeader label="Avg HR" sortKey="hr" sort={sort} onSort={onSort} />
                    <SortHeader label="Max HR" sortKey="maxhr" sort={sort} onSort={onSort} />
                    <SortHeader label="Avg power" sortKey="power" sort={sort} onSort={onSort} />
                    <SortHeader label="Avg W/kg" sortKey="wkg" sort={sort} onSort={onSort} />
                    <SortHeader label="Cadence" sortKey="cadence" sort={sort} onSort={onSort} />
                    <SortHeader label="Elev gain" sortKey="elev" sort={sort} onSort={onSort} />
                </tr>
            </thead>
            <tbody>
                {groups
                    ? groups.map((g) => (
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
                                  <WorkoutRow key={w.uuid} workout={w} unit={unit} onOpen={() => onOpen(w.uuid)} />
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
                      ))
                    : rows.map((w) => (
                          <WorkoutRow key={w.uuid} workout={w} unit={unit} showDate onOpen={() => onOpen(w.uuid)} />
                      ))}
                {rows.length === 0 && emptyMessage && (
                    <tr>
                        <td colSpan={COLUMNS} className="muted" style={{ textAlign: 'center', padding: 32 }}>
                            {emptyMessage}
                        </td>
                    </tr>
                )}
            </tbody>
            {rows.length > 0 && (
                <tfoot>
                    <tr className="summary-row">
                        <td data-label="Summary">Total</td>
                        <td data-label="Workouts">
                            {rows.length} {rows.length === 1 ? 'workout' : 'workouts'}
                        </td>
                        <TotalCells totals={summary} unit={unit} hints />
                    </tr>
                </tfoot>
            )}
        </table>
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
            <td data-label="Avg W/kg" className={empty(wkg)} {...tip('Duration-weighted average of stored W/kg')}>
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

function WorkoutRow({
    workout: w,
    unit,
    showDate = false,
    onOpen,
}: {
    workout: WorkoutSummary;
    unit: Unit;
    showDate?: boolean;
    onOpen: () => void;
}) {
    return (
        <tr onClick={onOpen}>
            <td data-label={showDate ? 'Date' : 'Time'}>
                {showDate
                    ? `${formatLocalDate(w.local_date)} ${formatLocalTime(w.start_utc)}`
                    : formatLocalTime(w.start_utc)}
            </td>
            <td data-label="Type">
                <span className="chip">{w.workout_type}</span>
            </td>
            <td data-label="Duration">{formatHms(w.duration_sec)}</td>
            <td data-label="Distance">{formatDistance(w.distance_m, unit)}</td>
            <td data-label="Avg pace">{formatPace(avgPaceSecPerUnit(w.distance_m, w.duration_sec, unit), unit)}</td>
            <td data-label="Active kcal">{round(w.active_energy_kcal)}</td>
            <td data-label="Avg HR">{round(w.avg_hr)}</td>
            <td data-label="Max HR">{round(w.max_hr)}</td>
            <PowerCells power={w.average_watts} wkg={w.watts_per_kg} cadence={w.average_cadence} />
            <td data-label="Elev gain">{formatElevation(w.elevation_gain_m, unit)}</td>
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
