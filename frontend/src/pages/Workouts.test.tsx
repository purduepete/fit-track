import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Workouts } from './Workouts';
import { api } from '../lib/api';
import type { WorkoutSummary } from '../lib/api';
import { currentPacificWeek } from '../lib/format';
import { Tooltip } from '../components/Tooltip';

function renderAt(entry: string) {
    return render(
        <MemoryRouter initialEntries={[entry]}>
            <Tooltip />
            <Routes>
                <Route path="/workouts" element={<Workouts onAuthError={() => {}} />} />
            </Routes>
        </MemoryRouter>
    );
}

describe('Workouts ?date= deep-link', () => {
    afterEach(() => vi.restoreAllMocks());

    it('filters to a single day and shows the active-filter chip', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);

        renderAt('/workouts?date=2026-07-16');

        await waitFor(() =>
            expect(workouts).toHaveBeenCalledWith(
                expect.objectContaining({ dateFrom: '2026-07-16', dateTo: '2026-07-16', offset: 0 })
            )
        );
        expect(screen.getByText(/Showing workouts on/i)).toBeInTheDocument();
        // The range dropdown is overridden by the exact-day filter.
        expect(screen.getByLabelText('Date range')).toBeDisabled();
        const explanation = screen.getByRole('group', { name: 'Date range disabled reason' });
        fireEvent.focusIn(explanation);
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(explanation).toHaveAccessibleDescription('Showing a single day — clear the day filter to use ranges');
        expect(document.querySelector('[title]')).toBeNull();
    });

    it('ignores a malformed date param and uses the default current week', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);

        renderAt('/workouts?date=not-a-date');

        await waitFor(() => expect(workouts).toHaveBeenCalled());
        expect(workouts).toHaveBeenCalledWith(expect.objectContaining(currentPacificWeek()));
        expect(screen.queryByText(/Showing workouts on/i)).not.toBeInTheDocument();
    });

    it('clears the day filter when Clear is clicked', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);

        renderAt('/workouts?date=2026-07-16');
        await waitFor(() => expect(screen.getByText(/Showing workouts on/i)).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /clear/i }));

        await waitFor(() => expect(screen.queryByText(/Showing workouts on/i)).not.toBeInTheDocument());
        expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining(currentPacificWeek()));
    });
});

describe('Workouts current week', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('shows a spinner until the initial list request finishes', async () => {
        let finish!: (value: { items: WorkoutSummary[]; total: number }) => void;
        vi.spyOn(api, 'workouts').mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');

        expect(screen.queryByRole('status', { name: 'Loading workouts' })).not.toBeInTheDocument();
        expect(await screen.findByRole('status', { name: 'Loading workouts' })).toHaveClass('loading-spinner');
        expect(screen.queryByRole('searchbox', { name: 'Search workouts' })).not.toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.queryByText(/No workouts in this range/)).not.toBeInTheDocument();

        await act(async () => finish({ items: [], total: 0 }));
        expect(screen.queryByRole('status', { name: 'Loading workouts' })).not.toBeInTheDocument();
        expect(screen.getByText(/No workouts in this range/)).toBeInTheDocument();
    });

    it('skips the spinner when a list request fails quickly and shows the error', async () => {
        vi.spyOn(api, 'workouts').mockRejectedValue(new Error('Could not load workouts'));
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');

        expect(await screen.findByText('Error: Could not load workouts')).toBeInTheDocument();
        expect(screen.queryByRole('status', { name: 'Loading workouts' })).not.toBeInTheDocument();
    });

    it('shows a compact spinner while loading more workouts', async () => {
        let finish!: (value: { items: WorkoutSummary[]; total: number }) => void;
        vi.spyOn(api, 'workouts')
            .mockResolvedValueOnce({ items: [], total: 1 })
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    finish = resolve;
                })
            );
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');

        fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
        expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
        const button = await screen.findByRole('button', { name: 'Loading workouts' });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-busy', 'true');
        expect(within(button).getByRole('status', { name: 'Loading workouts' })).toHaveClass('loading-spinner--small');
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

        await act(async () => finish({ items: [], total: 0 }));
        expect(screen.queryByRole('status', { name: 'Loading workouts' })).not.toBeInTheDocument();
    });

    it('defaults to the Pacific week, lists it first and keeps both bounds when loading more', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-26T06:59:59Z'));
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 30 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        const { container } = renderAt('/workouts');
        const bounds = { dateFrom: '2026-10-19', dateTo: '2026-10-25' };
        await waitFor(() => expect(workouts).toHaveBeenCalledWith(expect.objectContaining(bounds)));
        const range = screen.getByRole('combobox', { name: 'Date range' });
        expect(range).toHaveTextContent('Current week');
        expect(container.querySelector('select, datalist')).toBeNull();
        fireEvent.click(range);
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
            'Current week',
            'Last 7 days',
            'Last 30 days',
            'Last 90 days',
            'Last year',
            'This year',
            'All time',
        ]);
        fireEvent.keyDown(range, { key: 'Escape' });
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        await waitFor(() => expect(workouts).toHaveBeenCalledTimes(2));
        expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining(bounds));
    });

    it('removes the upper bound for other presets and restores the week with keyboard selection', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');
        await waitFor(() => expect(workouts).toHaveBeenCalled());
        const range = screen.getByLabelText('Date range');
        fireEvent.click(range);
        fireEvent.click(screen.getByRole('option', { name: 'All time' }));
        await waitFor(() =>
            expect(workouts).toHaveBeenLastCalledWith(
                expect.objectContaining({ dateFrom: undefined, dateTo: undefined })
            )
        );
        fireEvent.keyDown(range, { key: 'Enter' });
        fireEvent.keyDown(range, { key: 'Home' });
        fireEvent.keyDown(range, { key: 'Enter' });
        await waitFor(() => expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining(currentPacificWeek())));
    });
});

describe('Workouts type dropdown', () => {
    afterEach(() => vi.restoreAllMocks());

    it('refetches with the picked type', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue(['Outdoor Walk', 'Running']);

        renderAt('/workouts');
        await waitFor(() => expect(workouts).toHaveBeenCalledOnce());
        await screen.findByText(/No workouts in this range/);
        let finish!: (value: { items: WorkoutSummary[]; total: number }) => void;
        workouts.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            })
        );

        fireEvent.click(screen.getByLabelText('Workout type'));
        fireEvent.click(await screen.findByRole('option', { name: 'Running' }));

        await waitFor(() =>
            expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'Running', offset: 0 }))
        );
        expect(await screen.findByRole('status', { name: 'Loading workouts' })).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Workout type')).toBeInTheDocument();
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
        await act(async () => finish({ items: [], total: 0 }));
        expect(screen.queryByRole('status', { name: 'Loading workouts' })).not.toBeInTheDocument();
        expect(screen.getByRole('table').closest('.data-enter')).toBeInTheDocument();
    });

    describe('Visible workout totals', () => {
        afterEach(() => vi.restoreAllMocks());

        const workout = (overrides: Partial<WorkoutSummary> = {}): WorkoutSummary => ({
            uuid: 'one',
            workout_type: 'Indoor Cycling',
            local_date: '2026-10-23',
            start_utc: '2026-10-23T18:00:00',
            duration_sec: 600,
            distance_m: 1609.344,
            active_energy_kcal: 100,
            avg_hr: 100,
            max_hr: 140,
            elevation_gain_m: null,
            has_route: false,
            ...overrides,
        });

        function setup(items: WorkoutSummary[], total = items.length) {
            vi.spyOn(api, 'workoutTypes').mockResolvedValue(['Indoor Cycling', 'Walking']);
            return vi.spyOn(api, 'workouts').mockResolvedValue({ items, total });
        }

        it('warns when adjusted workout distance or splits cannot be calculated', async () => {
            setup([workout({ point_exclusion_warning: 'Original distance samples are unavailable.' })]);
            renderAt('/workouts');
            expect(await screen.findByRole('alert')).toHaveTextContent(
                'Adjusted distance or splits are unavailable for some workouts.'
            );
        });

        it('groups thousands in row and total distances and calories', async () => {
            setup([workout({ distance_m: 1609344, active_energy_kcal: 1396 })]);
            renderAt('/workouts');
            await screen.findByText('Visible totals');
            expect(screen.getAllByText('1,000.00 mi')).toHaveLength(2);
            expect(screen.getAllByText('1,396')).toHaveLength(2);
        });

        it('sums totals and calculates overall pace, duration-weighted HR and highest HR', async () => {
            setup([
                workout({ elevation_gain_m: 100 }),
                workout({
                    uuid: 'two',
                    duration_sec: 1800,
                    distance_m: 8046.72,
                    active_energy_kcal: 300,
                    avg_hr: 140,
                    max_hr: 160,
                }),
            ]);
            renderAt('/workouts');
            const row = (await screen.findByText('Visible totals')).closest('tr')!;
            const cells = within(row)
                .getAllByRole('cell')
                .map((cell) => cell.textContent);
            expect(cells).toEqual([
                'Visible totals',
                '2 workouts',
                '40m',
                '6.00 mi',
                '6:40/mi',
                '400',
                '130',
                '160',
                '328 ft',
            ]);
            const pace = row.querySelector<HTMLElement>('[data-label="Avg pace"]')!;
            const hr = row.querySelector<HTMLElement>('[data-label="Avg HR"]')!;
            expect(pace).toHaveAttribute('tabindex', '0');
            expect(hr).toHaveAttribute('tabindex', '0');
            fireEvent.focusIn(pace);
            fireEvent.pointerOver(pace);
            expect(screen.queryByRole('tooltip')).toBeNull();
            expect(pace).toHaveAccessibleDescription('Total duration / distance for rides with both values');
            expect(document.querySelector('.app-tooltip')).toBeNull();
            const paceHint = screen.getByText('Total duration / distance for rides with both values');
            expect(paceHint).toHaveClass('visually-hidden');
            expect(paceHint).not.toHaveAttribute('role');
            fireEvent.focusIn(hr);
            expect(screen.queryByRole('tooltip')).toBeNull();
            expect(hr).toHaveAccessibleDescription('Duration-weighted average of available workout heart rates');
            expect(document.querySelector('[title]')).toBeNull();
        });

        it('follows the visible search results and hides when nothing matches', async () => {
            setup([workout(), workout({ uuid: 'two', workout_type: 'Walking', duration_sec: 60 })]);
            renderAt('/workouts');
            await screen.findByText('Visible totals');
            fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Walking' } });
            const row = screen.getByText('Visible totals').closest('tr')!;
            expect(within(row).getByText('1 workout')).toBeInTheDocument();
            expect(within(row).getByText('1m')).toBeInTheDocument();
            fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
            expect(screen.queryByText('Visible totals')).not.toBeInTheDocument();
        });

        it('includes only loaded rows and updates when more are loaded', async () => {
            const request = setup([workout()], 2);
            request
                .mockResolvedValueOnce({ items: [workout()], total: 2 })
                .mockResolvedValueOnce({ items: [workout({ uuid: 'two' })], total: 2 });
            renderAt('/workouts');
            let row = (await screen.findByText('Visible totals')).closest('tr')!;
            expect(within(row).getByText('1 workout')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
            await waitFor(() => {
                row = screen.getByText('Visible totals').closest('tr')!;
                expect(within(row).getByText('2 workouts')).toBeInTheDocument();
            });
            expect(within(row).getByText('20m')).toBeInTheDocument();
        });

        it('preserves missing measurements and excludes incomplete pairs from averages', async () => {
            setup([
                workout({ duration_sec: null, avg_hr: 170, max_hr: null, active_energy_kcal: null }),
                workout({ uuid: 'two', distance_m: null, avg_hr: null, max_hr: null, active_energy_kcal: null }),
            ]);
            renderAt('/workouts');
            const row = (await screen.findByText('Visible totals')).closest('tr')!;
            expect(
                within(row)
                    .getAllByRole('cell')
                    .map((cell) => cell.textContent)
            ).toEqual(['Visible totals', '2 workouts', '10m', '1.00 mi', '—', '—', '—', '—', '—']);
        });

        it('preserves zero totals and does not divide by zero', async () => {
            setup([workout({ duration_sec: 0, distance_m: 0, active_energy_kcal: 0, elevation_gain_m: 0 })]);
            renderAt('/workouts');
            const row = (await screen.findByText('Visible totals')).closest('tr')!;
            expect(
                within(row)
                    .getAllByRole('cell')
                    .map((cell) => cell.textContent)
            ).toEqual(['Visible totals', '1 workout', '0s', '0.00 mi', '—', '0', '—', '140', '0 ft']);
        });

        it('does not show a totals row for an empty range', async () => {
            setup([]);
            renderAt('/workouts');
            await screen.findByText(/No workouts in this range/);
            expect(screen.queryByText('Visible totals')).not.toBeInTheDocument();
        });
    });
});
