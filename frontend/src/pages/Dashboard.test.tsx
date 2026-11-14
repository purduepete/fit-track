import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { Tooltip } from '../components/Tooltip';
import { api } from '../lib/api';
import { DashboardProvider } from '../lib/dashboard';
import { SHOW_TOOLTIPS } from '../siteSettings';
import { addWeeklyStepTotals } from '../lib/steps';
import { currentPacificWeek } from '../lib/format';
import { Dashboard } from './Dashboard';

vi.mock('recharts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('recharts')>()),
    ResponsiveContainer: () => null,
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

it('shows full weekly step totals on Sunday and an in-progress total on the latest recorded day', () => {
    const points = [
        ...[1, 2, 3, 4, 5, 6, 7].map((value, index) => ({
            local_date: `2026-11-${String(index + 2).padStart(2, '0')}`,
            value,
        })),
        { local_date: '2026-11-09', value: 8 },
        { local_date: '2026-11-10', value: 9 },
    ];

    const result = addWeeklyStepTotals(points);

    expect(result.filter((point) => point.weeklyTotal != null)).toEqual([
        { local_date: '2026-11-08', value: 7, weeklyTotal: 28 },
        { local_date: '2026-11-10', value: 9, weeklyTotal: 17 },
    ]);
});

it('shows the available total on 10/18 when the chart begins partway through that week', () => {
    const points = [
        ...[6000, 7000, 8000, 9000, 10000, 11000].map((value, index) => ({
            local_date: `2026-10-${index + 13}`,
            value,
        })),
        { local_date: '2026-10-19', value: 12000 },
    ];

    expect(addWeeklyStepTotals(points).filter((point) => point.weeklyTotal !== null)).toEqual([
        { local_date: '2026-10-18', value: 11000, weeklyTotal: 51000 },
        { local_date: '2026-10-19', value: 12000, weeklyTotal: 12000 },
    ]);
});

it('uses the last recorded day with missing Sunday data and preserves zero totals', () => {
    const points = [
        { local_date: '2026-11-06', value: 1000 },
        { local_date: '2026-11-07', value: 2000 },
        { local_date: '2026-11-08', value: null },
        { local_date: '2026-11-09', value: 0 },
        { local_date: '2026-11-10', value: null },
        { local_date: '2026-11-16', value: null },
    ];

    expect(addWeeklyStepTotals(points).filter((point) => point.weeklyTotal !== null)).toEqual([
        { local_date: '2026-11-07', value: 2000, weeklyTotal: 3000 },
        { local_date: '2026-11-09', value: 0, weeklyTotal: 0 },
    ]);
    expect(addWeeklyStepTotals([])).toEqual([]);
});

it('shows the sleep and cardio scale tooltips while control hints are disabled', async () => {
    expect(SHOW_TOOLTIPS).toBe(false);
    vi.spyOn(api, 'dashboard').mockResolvedValue({
        last_ingest_utc: null,
        workouts_7d: 2,
        minutes_7d: 95,
        active_kcal_7d: 430,
        latest_resting_hr: 61,
        latest_vo2max: 42,
        vo2max_band: {
            category: 'Good',
            category_index: 3,
            range_low: 40,
            range_high: 45,
            next_category: 'Excellent',
            next_at: 45,
            age: 40,
            sex: 'male',
        },
        latest_sleep_hours: 7.5,
        sleep_band: { category: 'Good', category_index: 2, target_low: 7, target_high: 9 },
        latest_steps: null,
        latest_steps_date: null,
        weekly_minutes: [],
        resting_hr_trend: [],
        vo2max_trend: [],
        sleep_trend: [],
        steps_trend: [],
        steps_avg7_trend: [],
        workout_days: [],
    });
    render(
        <MemoryRouter>
            <DashboardProvider onAuthError={() => {}}>
                <Tooltip />
                <Dashboard />
            </DashboardProvider>
        </MemoryRouter>
    );

    const sleep = within(await screen.findByRole('group', { name: 'Sleep rating: Good' })).getByRole('img', {
        name: 'Fair',
    });
    fireEvent.pointerOver(sleep);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Fair');

    const cardio = within(screen.getByRole('group', { name: 'VO2 max category: Good' })).getByRole('img', {
        name: 'Excellent',
    });
    fireEvent.focusIn(cardio);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Excellent');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(api.dashboard).toHaveBeenCalledWith(currentPacificWeek());
    expect(screen.getByText('Active days (week)')).toBeInTheDocument();
    expect(screen.getByText('1h 35m')).toBeInTheDocument();
});
