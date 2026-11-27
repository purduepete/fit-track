import { useEffect, useState } from 'react';
import {
    Bar,
    BarChart,
    Cell,
    CartesianGrid,
    ComposedChart,
    Line,
    LineChart,
    LabelList,
    ReferenceArea,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import type { SleepBand, Vo2MaxBand } from '../lib/api';
import { useDashboard } from '../lib/dashboard';
import { StatCard } from '../components/StatCard';
import {
    ActivityIcon,
    ClockIcon,
    FlameIcon,
    FootprintsIcon,
    GaugeIcon,
    HeartIcon,
    MoonIcon,
} from '../components/Icons';
import { round, formatLocalDate, formatHoursMinutes, formatMinutesHms, formatSteps } from '../lib/format';
import { barCursor, tooltipProps } from '../lib/chart';
import { usePageRefresh } from '../lib/refresh';
import { PageLoading } from '../components/LoadingSpinner';
import { useFirstLoad } from '../lib/firstLoad';
import { addWeeklyStepTotals } from '../lib/steps';

// Red -> green scale, indexed by VO2 max category (0=Very Poor .. 5=Superior).
const VO2_COLORS = ['#dc2626', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#16a34a'];
const VO2_TIERS = ['Very Poor', 'Poor', 'Fair', 'Good', 'Excellent', 'Superior'];

// Red -> green scale, indexed by sleep rating (0=Low .. 3=Excellent).
const SLEEP_COLORS = ['#dc2626', '#f59e0b', '#84cc16', '#22c55e'];
const SLEEP_TIERS = ['Low', 'Fair', 'Good', 'Excellent'];

const CHART_BAR_COLOR = 'var(--chart-bar)';
const STEPS_AVG_COLOR = 'var(--chart-average)';
const WORKOUT_BAR_COLOR = 'var(--chart-workout)';
const GOAL_COLOR = 'var(--chart-goal)';
const CHART_ALT_COLOR = 'var(--chart-alt)';

function SleepQuality({ band, hours }: { band: SleepBand; hours: number }) {
    const color = SLEEP_COLORS[band.category_index] ?? CHART_BAR_COLOR;
    return (
        <div className="card">
            <h2>Sleep quality</h2>
            <div className="vo2-panel">
                <span className="vo2-category" style={{ color }}>
                    {band.category}
                </span>
                <p className="muted vo2-context">
                    {formatHoursMinutes(hours)} asleep last night, rated <strong>{band.category}</strong> against a{' '}
                    {band.target_low}–{band.target_high} h target.
                </p>
                <div
                    className="vo2-scale"
                    style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}
                    role="group"
                    aria-label={`Sleep rating: ${band.category}`}
                >
                    {SLEEP_TIERS.map((tier, i) => (
                        <div
                            key={tier}
                            className={'vo2-seg' + (i === band.category_index ? ' current' : '')}
                            style={{ background: SLEEP_COLORS[i] }}
                            data-tip={tier}
                            data-chart-tip="true"
                            tabIndex={0}
                            role="img"
                            aria-label={tier}
                        >
                            {i === band.category_index && <span className="vo2-marker" />}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function CardioFitness({ band, value }: { band: Vo2MaxBand; value: number }) {
    const color = VO2_COLORS[band.category_index] ?? CHART_BAR_COLOR;
    const toNext = band.next_at !== null && band.next_category ? round(band.next_at - value, 1) : null;
    const sexLabel = band.sex === 'female' ? 'F' : 'M';
    return (
        <div className="card">
            <h2>Cardio fitness</h2>
            <div className="vo2-panel">
                <span className="vo2-category" style={{ color }}>
                    {band.category}
                </span>
                <p className="muted vo2-context">
                    Your {round(value, 1)} mL/kg/min ranks as <strong>{band.category}</strong> for a {band.age}-year-old{' '}
                    {sexLabel === 'F' ? 'female' : 'male'}.
                </p>
                <div className="vo2-scale" role="group" aria-label={`VO2 max category: ${band.category}`}>
                    {VO2_TIERS.map((tier, i) => (
                        <div
                            key={tier}
                            className={'vo2-seg' + (i === band.category_index ? ' current' : '')}
                            style={{ background: VO2_COLORS[i] }}
                            data-tip={tier}
                            data-chart-tip="true"
                            tabIndex={0}
                            role="img"
                            aria-label={tier}
                        >
                            {i === band.category_index && <span className="vo2-marker" />}
                        </div>
                    ))}
                </div>
                {toNext !== null && (
                    <p className="muted vo2-next">
                        {toNext} more to reach <strong>{band.next_category}</strong>.
                    </p>
                )}
            </div>
        </div>
    );
}

export function Dashboard({ active = true }: { active?: boolean }) {
    const { data, error, loading, refresh } = useDashboard();
    const [compactCharts, setCompactCharts] = useState(() => window.matchMedia('(max-width: 700px)').matches);
    useEffect(() => {
        const media = window.matchMedia('(max-width: 700px)');
        const update = () => setCompactCharts(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    useFirstLoad(Boolean(data), Boolean(error), active);
    usePageRefresh(refresh, loading, active);
    const navigate = useNavigate();

    // Navigate to the Workouts page scoped to a clicked bar's day. The click is
    // handled on the chart (not the <Bar>) because the Tooltip cursor overlay sits
    // on top of the bars and would otherwise swallow Bar clicks. Recharts gives us
    // the active day via `activeLabel` / `activePayload[].payload`. Only workout
    // days (workout != null) link.
    function handleChartClick(state: {
        activeLabel?: string;
        activePayload?: Array<{ payload?: { local_date?: string; workout?: number | null } }>;
    }) {
        const row = state?.activePayload?.[0]?.payload;
        const day = row?.local_date ?? state?.activeLabel;
        if (day && row?.workout != null) {
            navigate(`/workouts?date=${day}`);
        }
    }

    if (error) return <p className="error">{error}</p>;
    if (!data) return <PageLoading />;

    const vo2Value =
        typeof data.latest_vo2max === 'number' ? (
            <>
                {round(data.latest_vo2max, 1)}
                {data.vo2max_band && (
                    <span
                        className="vo2-badge"
                        style={{ background: VO2_COLORS[data.vo2max_band.category_index] ?? CHART_BAR_COLOR }}
                    >
                        {data.vo2max_band.category}
                    </span>
                )}
            </>
        ) : (
            round(data.latest_vo2max, 1)
        );

    const sleepValue =
        typeof data.latest_sleep_hours === 'number' ? (
            <>
                {formatHoursMinutes(data.latest_sleep_hours)}
                {data.sleep_band && (
                    <span
                        className="vo2-badge"
                        style={{ background: SLEEP_COLORS[data.sleep_band.category_index] ?? CHART_BAR_COLOR }}
                    >
                        {data.sleep_band.category}
                    </span>
                )}
            </>
        ) : (
            '—'
        );

    // Build ONE shared data array for the ComposedChart: the daily steps value,
    // the 7-day block average, and a `workout` y (= that day's steps) only on days
    // with a logged workout. All series must share this single array: giving the
    // Scatter its own `data` prop hijacks the category axis and hides the bars/line.
    const stepsAvgByDate = new Map(data.steps_avg7_trend.map((p) => [p.local_date, p.value]));
    const workoutDaySet = new Set(data.workout_days);
    const stepsChartData = addWeeklyStepTotals(data.steps_trend).map((p) => ({
        local_date: p.local_date,
        value: p.value,
        avg: stepsAvgByDate.get(p.local_date) ?? null,
        workout: workoutDaySet.has(p.local_date) && p.value != null ? p.value : null,
        weeklyTotal: p.weeklyTotal,
    }));
    const hasStepData = data.steps_trend.some((p) => p.value != null);

    return (
        <div className="data-enter">
            <div aria-busy={loading}>
                <div className="page-head">
                    <h1 className="page-title">Dashboard</h1>
                </div>
                <div className="grid-cards">
                    <StatCard icon={<ActivityIcon />} label="Active days (week)" value={data.workouts_7d} />
                    <StatCard
                        icon={<ClockIcon />}
                        label="Time (week)"
                        value={formatHoursMinutes(data.minutes_7d / 60)}
                    />
                    <StatCard
                        icon={<FlameIcon />}
                        label="Active energy (week)"
                        value={round(data.active_kcal_7d)}
                        unit="kcal"
                    />
                    <StatCard
                        icon={<HeartIcon />}
                        label="Resting HR"
                        value={round(data.latest_resting_hr)}
                        unit="bpm"
                    />
                    <StatCard icon={<GaugeIcon />} label="VO₂ max" value={vo2Value} unit="mL/kg/min" />
                    <StatCard icon={<MoonIcon />} label="Sleep (last night)" value={sleepValue} />
                </div>

                <section
                    className="dash-section dash-steps"
                    aria-labelledby="daily-steps-heading"
                    aria-describedby={hasStepData ? 'steps-chart-description' : undefined}
                >
                    <h2 className="section-title">Activity</h2>
                    <div className="card">
                        <h2 id="daily-steps-heading">Daily steps</h2>
                        {hasStepData ? (
                            <>
                                <p id="steps-chart-description" className="visually-hidden">
                                    Daily steps for the last 30 days, with weekly totals above Sundays. The orange line
                                    shows the 7-day block average and the dashed green line marks 10,000 steps. Green
                                    bars mark workout days and can be selected to open that day&apos;s workouts.
                                </p>
                                <div className="steps-headline">
                                    <FootprintsIcon size={20} />
                                    <span className="steps-value">{formatSteps(data.latest_steps)}</span>
                                </div>
                                <ResponsiveContainer width="100%" height={240}>
                                    <ComposedChart
                                        data={stepsChartData}
                                        margin={{ top: 18, right: 5, left: 0, bottom: 0 }}
                                        onClick={handleChartClick}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                                        <XAxis
                                            dataKey="local_date"
                                            tickFormatter={formatLocalDate}
                                            tick={{ fontSize: 11 }}
                                            interval="preserveStartEnd"
                                            minTickGap={16}
                                        />
                                        <YAxis
                                            domain={[0, (max: number) => Math.max(max, 10000) * 1.08]}
                                            tickFormatter={(v) => formatSteps(v as number)}
                                            tick={{ fontSize: 11 }}
                                            width={compactCharts ? 36 : 48}
                                            tickSize={compactCharts ? 0 : 6}
                                        />
                                        <Tooltip
                                            {...tooltipProps}
                                            cursor={barCursor}
                                            labelFormatter={formatLocalDate}
                                            formatter={(v, name) => {
                                                if (name === 'avg')
                                                    return [formatSteps(v as number), '7-day block avg'];
                                                return [formatSteps(v as number), 'Steps'];
                                            }}
                                        />
                                        <ReferenceLine
                                            y={10000}
                                            stroke={GOAL_COLOR}
                                            strokeDasharray="4 4"
                                            ifOverflow="extendDomain"
                                        />
                                        <Bar dataKey="value" radius={[2, 2, 0, 0]}>
                                            <LabelList
                                                dataKey="weeklyTotal"
                                                position="top"
                                                formatter={(value: unknown) =>
                                                    typeof value === 'number' ? formatSteps(value) : ''
                                                }
                                                fill="var(--text-dim)"
                                                fontSize={10}
                                            />
                                            {stepsChartData.map((d) => (
                                                <Cell
                                                    key={d.local_date}
                                                    fill={d.workout != null ? WORKOUT_BAR_COLOR : CHART_BAR_COLOR}
                                                    cursor={d.workout != null ? 'pointer' : 'default'}
                                                />
                                            ))}
                                        </Bar>
                                        <Line
                                            type="stepAfter"
                                            dataKey="avg"
                                            stroke={STEPS_AVG_COLOR}
                                            strokeWidth={2}
                                            dot={false}
                                            connectNulls={false}
                                            isAnimationActive={false}
                                        />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            </>
                        ) : (
                            <p className="muted">Enable “Steps” in Health Auto Export to track daily steps here.</p>
                        )}
                    </div>
                </section>

                <section className="dash-section dash-weekly">
                    <h2 className="section-title">This week</h2>
                    <div className="card">
                        <h2>Workout minutes by day</h2>
                        <ResponsiveContainer width="100%" height={240}>
                            <BarChart data={data.weekly_minutes} margin={{ top: 18, right: 5, left: 0, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                                <XAxis dataKey="local_date" tickFormatter={formatLocalDate} tick={{ fontSize: 11 }} />
                                <YAxis
                                    tick={{ fontSize: 11 }}
                                    width={compactCharts ? 36 : 48}
                                    tickSize={compactCharts ? 0 : 6}
                                />
                                <Tooltip
                                    {...tooltipProps}
                                    cursor={barCursor}
                                    labelFormatter={formatLocalDate}
                                    formatter={(v) => [formatMinutesHms(v as number), 'Duration']}
                                />
                                <Bar dataKey="value" fill={CHART_BAR_COLOR} radius={[2, 2, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </section>

                <section className="dash-section dash-heart">
                    <h2 className="section-title">Heart &amp; fitness</h2>
                    <div className="two-col">
                        <div className="card">
                            <h2>Resting heart rate trend</h2>
                            <ResponsiveContainer width="100%" height={240}>
                                <LineChart
                                    data={data.resting_hr_trend}
                                    margin={{ top: 18, right: 5, left: 0, bottom: 0 }}
                                >
                                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                                    <XAxis
                                        dataKey="local_date"
                                        tickFormatter={formatLocalDate}
                                        tick={{ fontSize: 11 }}
                                    />
                                    <YAxis
                                        domain={['auto', 'auto']}
                                        tick={{ fontSize: 11 }}
                                        width={compactCharts ? 36 : 48}
                                        tickSize={compactCharts ? 0 : 6}
                                    />
                                    <Tooltip
                                        {...tooltipProps}
                                        labelFormatter={formatLocalDate}
                                        formatter={(value) => [`${round(Number(value))} bpm`, 'Resting HR']}
                                    />
                                    <Line
                                        type="monotone"
                                        dataKey="value"
                                        stroke={CHART_ALT_COLOR}
                                        strokeWidth={2}
                                        dot={false}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                        <div className="card">
                            <h2>VO₂ max trend</h2>
                            {data.vo2max_trend.length > 0 ? (
                                <ResponsiveContainer width="100%" height={240}>
                                    <LineChart
                                        data={data.vo2max_trend}
                                        margin={{ top: 18, right: 5, left: 0, bottom: 0 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                                        <XAxis
                                            dataKey="local_date"
                                            tickFormatter={formatLocalDate}
                                            tick={{ fontSize: 11 }}
                                        />
                                        <YAxis
                                            domain={['auto', 'auto']}
                                            tick={{ fontSize: 11 }}
                                            width={compactCharts ? 36 : 48}
                                            tickSize={compactCharts ? 0 : 6}
                                        />
                                        <Tooltip
                                            {...tooltipProps}
                                            labelFormatter={formatLocalDate}
                                            formatter={(value) => [`${round(Number(value), 1)} mL/kg/min`, 'VO₂ max']}
                                        />
                                        <Line
                                            type="monotone"
                                            dataKey="value"
                                            stroke={CHART_BAR_COLOR}
                                            strokeWidth={2}
                                            dot={false}
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            ) : (
                                <p className="muted">No VO₂ max readings yet.</p>
                            )}
                        </div>
                    </div>
                </section>

                <section className="dash-section dash-sleep">
                    <h2 className="section-title">Sleep &amp; fitness</h2>
                    <div className="two-col">
                        <div className="card">
                            <h2>Sleep hours</h2>
                            <p className="muted chart-caption">
                                Asleep hours per night; shaded band is the 7–9 h target.
                            </p>
                            {data.sleep_trend.length > 0 ? (
                                <ResponsiveContainer width="100%" height={240}>
                                    <BarChart
                                        data={data.sleep_trend}
                                        margin={{ top: 5, right: 5, left: compactCharts ? 0 : 5, bottom: 5 }}
                                    >
                                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                                        <XAxis
                                            dataKey="local_date"
                                            tickFormatter={formatLocalDate}
                                            tick={{ fontSize: 11 }}
                                        />
                                        <YAxis
                                            domain={[0, 'auto']}
                                            tick={{ fontSize: 11 }}
                                            unit="h"
                                            width={compactCharts ? 36 : 60}
                                            tickSize={compactCharts ? 0 : 6}
                                        />
                                        <Tooltip
                                            {...tooltipProps}
                                            cursor={barCursor}
                                            labelFormatter={formatLocalDate}
                                            formatter={(v) => [formatHoursMinutes(v as number), 'Asleep']}
                                        />
                                        <ReferenceArea
                                            y1={7}
                                            y2={9}
                                            fill={GOAL_COLOR}
                                            fillOpacity={0.12}
                                            ifOverflow="extendDomain"
                                        />
                                        <Bar dataKey="value" fill={CHART_ALT_COLOR} radius={[2, 2, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            ) : (
                                <p className="muted">
                                    Enable “Sleep Analysis” in Health Auto Export to track nightly sleep hours here.
                                </p>
                            )}
                        </div>
                        <div className="ratings-stack">
                            {data.vo2max_band && typeof data.latest_vo2max === 'number' ? (
                                <CardioFitness band={data.vo2max_band} value={data.latest_vo2max} />
                            ) : (
                                <div className="card">
                                    <h2>Cardio fitness</h2>
                                    <p className="muted">
                                        Set your birth date and sex in the app config to interpret VO₂ max against
                                        age/sex norms.
                                    </p>
                                </div>
                            )}
                            {data.sleep_band && typeof data.latest_sleep_hours === 'number' ? (
                                <SleepQuality band={data.sleep_band} hours={data.latest_sleep_hours} />
                            ) : (
                                <div className="card">
                                    <h2>Sleep quality</h2>
                                    <p className="muted">
                                        Once sleep data arrives, its rating against the 7–9 h target appears here.
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
