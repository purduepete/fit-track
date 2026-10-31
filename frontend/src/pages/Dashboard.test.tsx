import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { Tooltip } from '../components/Tooltip';
import { api } from '../lib/api';
import { DashboardProvider } from '../lib/dashboard';
import { SHOW_TOOLTIPS } from '../siteSettings';
import { Dashboard } from './Dashboard';

vi.mock('recharts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('recharts')>()),
    ResponsiveContainer: () => null,
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
});
