import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Workouts } from './Workouts';
import { api } from '../lib/api';
import type { WorkoutSummary } from '../lib/api';
import { currentPacificWeek } from '../lib/format';
import { Tooltip } from '../components/Tooltip';

afterEach(() => {
    localStorage.removeItem('fittrack_unit');
    localStorage.removeItem('fittrack_workout_sort');
    localStorage.removeItem('fittrack_workout_view');
    document.cookie = 'fittrack_workout_view=; Max-Age=0; Path=/';
});
beforeEach(() => {
    vi.spyOn(api, 'weight').mockResolvedValue({ weight_kg: 84.2 });
    vi.spyOn(api, 'saveWorkoutTable').mockImplementation(async (preference) => preference);
    // Most tests check every column; the column-view tests start from the default.
    localStorage.setItem('fittrack_workout_view', 'all');
});

function getFooter() {
    const row = document.querySelector<HTMLTableRowElement>('tr.summary-row');
    if (!row) throw new Error('No totals footer');
    return row;
}

const findFooter = () => waitFor(getFooter);

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
        expect(explanation).toHaveAccessibleDescription('Showing a single day. Clear the day filter to use ranges.');
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

        await waitFor(() => {
            expect(screen.getByRole('searchbox', { name: 'Search workouts' })).toBeInTheDocument();
            expect(screen.getByText('Error: Could not load workouts')).toBeInTheDocument();
        });
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
            await findFooter();
            expect(screen.getAllByText('1,000.00 mi')).toHaveLength(2);
            expect(screen.getAllByText('1,396')).toHaveLength(2);
        });

        it('switches row and total distance, pace and elevation without refetching', async () => {
            vi.spyOn(api, 'saveUnit').mockResolvedValue({ unit: 'km' });
            const fetch = setup([workout({ elevation_gain_m: 100 })]);
            renderAt('/workouts');
            await findFooter();
            const units = screen.getByRole('group', { name: 'Distance units' });
            expect(screen.getByRole('heading', { name: 'Workouts' }).closest('.page-head')).toContainElement(units);
            expect(screen.getAllByText('1.00 mi')).toHaveLength(2);
            expect(screen.getAllByText('10:00/mi')).toHaveLength(2);
            expect(screen.getAllByText('328 ft')).toHaveLength(2);
            const requests = fetch.mock.calls.length;
            await act(async () => fireEvent.click(within(units).getByRole('button', { name: 'km' })));
            expect(screen.getAllByText('1.61 km')).toHaveLength(2);
            expect(screen.getAllByText('6:13/km')).toHaveLength(2);
            expect(screen.getAllByText('100 m')).toHaveLength(2);
            expect(within(units).getByRole('button', { name: 'km' })).toHaveAttribute('aria-pressed', 'true');
            expect(fetch).toHaveBeenCalledTimes(requests);
            await act(async () => fireEvent.click(within(units).getByRole('button', { name: 'mi' })));
            expect(screen.getAllByText('1.00 mi')).toHaveLength(2);
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
            const row = await findFooter();
            const cells = within(row)
                .getAllByRole('cell')
                .map((cell) => cell.textContent);
            expect(cells).toEqual([
                'Total',
                '2 workouts',
                '40m',
                '6.00 mi',
                '6:40/mi',
                '400',
                '130',
                '160',
                '—',
                '—',
                '—',
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
            await findFooter();
            fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Walking' } });
            const row = getFooter();
            expect(within(row).getByText('1 workout')).toBeInTheDocument();
            expect(within(row).getByText('1m')).toBeInTheDocument();
            fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
            expect(document.querySelector('.summary-row')).toBeNull();
        });

        it('includes only loaded rows and updates when more are loaded', async () => {
            const request = setup([workout()], 2);
            request
                .mockResolvedValueOnce({ items: [workout()], total: 2 })
                .mockResolvedValueOnce({ items: [workout({ uuid: 'two' })], total: 2 });
            renderAt('/workouts');
            let row = await findFooter();
            expect(within(row).getByText('1 workout')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
            await waitFor(() => {
                row = getFooter();
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
            const row = await findFooter();
            expect(
                within(row)
                    .getAllByRole('cell')
                    .map((cell) => cell.textContent)
            ).toEqual(['Total', '2 workouts', '10m', '1.00 mi', '—', '—', '—', '—', '—', '—', '—', '—']);
        });

        it('preserves zero totals and does not divide by zero', async () => {
            setup([workout({ duration_sec: 0, distance_m: 0, active_energy_kcal: 0, elevation_gain_m: 0 })]);
            renderAt('/workouts');
            const row = await findFooter();
            expect(
                within(row)
                    .getAllByRole('cell')
                    .map((cell) => cell.textContent)
            ).toEqual(['Total', '1 workout', '0s', '0.00 mi', '—', '0', '—', '140', '—', '—', '—', '0 ft']);
        });

        it('shows power, W/kg and cadence and averages them by duration in the footer', async () => {
            setup([
                workout({ average_watts: 200, watts_per_kg: 2.38, average_cadence: 90 }),
                workout({
                    uuid: 'two',
                    workout_type: 'Walking',
                    duration_sec: 1800,
                    average_watts: 100,
                    watts_per_kg: 1.19,
                    average_cadence: 80,
                }),
                workout({ uuid: 'three', workout_type: 'Running' }),
            ]);
            renderAt('/workouts');
            const footer = await findFooter();
            expect(footer.querySelector('[data-label="Avg power"]')).toHaveTextContent('125 W');
            expect(footer.querySelector('[data-label="Avg W/kg"]')).toHaveTextContent('1.49');
            expect(footer.querySelector('[data-label="Cadence"]')).toHaveTextContent('83 rpm');
            expect(screen.getByText('200 W')).toBeInTheDocument();
            expect(screen.getByText('2.38')).toBeInTheDocument();
            const running = screen.getByText('Running').closest('tr')!;
            expect(running.querySelector('[data-label="Avg power"]')).toHaveClass('metric-empty');
        });

        it('adds a daily subtotal only for types with 2 or more workouts that day', async () => {
            setup([
                workout({ average_watts: 200, average_cadence: 90 }),
                workout({ uuid: 'two', duration_sec: 1800, average_watts: 100, average_cadence: 80 }),
                workout({ uuid: 'three', workout_type: 'Walking' }),
                workout({ uuid: 'four', local_date: '2026-10-22', start_utc: '2026-10-22T18:00:00' }),
            ]);
            renderAt('/workouts');
            await findFooter();
            const subtotals = document.querySelectorAll('tr.subtotal-row');
            expect(subtotals).toHaveLength(1);
            expect(
                within(subtotals[0] as HTMLElement)
                    .getAllByRole('cell')
                    .map((cell) => cell.textContent)
            ).toEqual([
                'Total',
                'Indoor Cycling × 2',
                '40m',
                '2.00 mi',
                '20:00/mi',
                '200',
                '100',
                '140',
                '125 W',
                '—',
                '83 rpm',
                '—',
            ]);
            fireEvent.click(subtotals[0]);
            expect(screen.getByRole('heading', { name: 'Workouts' })).toBeInTheDocument();
        });

        it('skips subtotals for the oldest loaded day while it may continue on the next page, even when searching', async () => {
            setup([workout(), workout({ uuid: 'two' })], 3);
            renderAt('/workouts');
            await findFooter();
            expect(document.querySelector('tr.subtotal-row')).toBeNull();
            fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Cycling' } });
            expect(document.querySelector('tr.subtotal-row')).toBeNull();
        });
        it('does not show a totals row for an empty range', async () => {
            setup([]);
            renderAt('/workouts');
            await screen.findByText(/No workouts in this range/);
            expect(document.querySelector('.summary-row')).toBeNull();
        });
    });
});

describe('Workouts weight', () => {
    afterEach(() => vi.restoreAllMocks());

    it('loads the saved weight and saves a valid change on Enter only once', async () => {
        vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        const save = vi.spyOn(api, 'saveWeight').mockResolvedValue({ weight_kg: 85 });
        renderAt('/workouts');
        const input = await screen.findByRole('textbox', { name: 'Weight' });
        await waitFor(() => expect(input).toHaveValue('84.2'));
        fireEvent.change(input, { target: { value: '85' } });
        await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
        expect(save).toHaveBeenCalledWith(85);
        await act(async () => fireEvent.blur(input));
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid weight without saving', async () => {
        vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        const save = vi.spyOn(api, 'saveWeight');
        renderAt('/workouts');
        const input = await screen.findByRole('textbox', { name: 'Weight' });
        fireEvent.change(input, { target: { value: '0' } });
        fireEvent.blur(input);
        expect(await screen.findByRole('alert')).toHaveTextContent('Enter a weight between 0 and 400 kg.');
        expect(save).not.toHaveBeenCalled();
    });
});

describe('Workouts sorting', () => {
    afterEach(() => vi.restoreAllMocks());

    const ride = (uuid: string, date: string, distance: number): WorkoutSummary => ({
        uuid,
        workout_type: 'Indoor Cycling',
        local_date: date,
        start_utc: `${date}T18:00:00`,
        duration_sec: 1800,
        distance_m: distance,
        active_energy_kcal: 300,
        avg_hr: 130,
        max_hr: 150,
        elevation_gain_m: null,
        has_route: false,
    });

    it('sorts on the server from a column header, lists rows flat with dates and reverses on a second click', async () => {
        const workouts = vi
            .spyOn(api, 'workouts')
            .mockResolvedValue({ items: [ride('a', '2026-11-12', 20000), ride('b', '2026-11-13', 10000)], total: 3 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');
        await findFooter();
        expect(screen.getByRole('columnheader', { name: /Avg W\/kg/ })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Distance/ }));
        await waitFor(() =>
            expect(workouts).toHaveBeenLastCalledWith(
                expect.objectContaining({ sort: 'distance', order: 'desc', offset: 0 })
            )
        );
        await findFooter();
        expect(screen.getByRole('columnheader', { name: /Distance/ })).toHaveAttribute('aria-sort', 'descending');
        expect(document.querySelector('tr.group-row')).toBeNull();
        expect(screen.getByText(/^11\/12\/2026 \d{2}:\d{2}$/)).toBeInTheDocument();
        expect(JSON.parse(localStorage.getItem('fittrack_workout_sort')!)).toEqual({ key: 'distance', order: 'desc' });

        fireEvent.click(screen.getByRole('button', { name: /^Distance/ }));
        await waitFor(() =>
            expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'distance', order: 'asc' }))
        );
        await findFooter();
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        await waitFor(() =>
            expect(workouts).toHaveBeenLastCalledWith(
                expect.objectContaining({ sort: 'distance', order: 'asc', offset: 2 })
            )
        );
    });

    it('sorts loaded rows at once without a request, and restores day groups and subtotals by date', async () => {
        const sameDay = [
            ride('a', '2026-11-13', 20000),
            ride('b', '2026-11-13', 10000),
            ride('c', '2026-11-12', 15000),
        ];
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: sameDay, total: 3 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');
        await findFooter();
        expect(document.querySelectorAll('tr.subtotal-row')).toHaveLength(1);
        expect(document.querySelectorAll('tr.group-row')).toHaveLength(2);
        const requests = workouts.mock.calls.length;

        fireEvent.click(screen.getByRole('button', { name: /^Distance/ }));
        const distances = () =>
            [...document.querySelectorAll('tbody td[data-label="Distance"]')].map((cell) => cell.textContent);
        expect(distances()).toEqual(['12.43 mi', '9.32 mi', '6.21 mi']);
        expect(document.querySelector('tr.group-row')).toBeNull();
        expect(document.querySelector('tr.subtotal-row')).toBeNull();
        expect(screen.queryByRole('status', { name: 'Loading workouts' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /^Avg pace/ }));
        expect(distances()).toEqual(['12.43 mi', '9.32 mi', '6.21 mi']);
        fireEvent.click(screen.getByRole('button', { name: /^Date/ }));
        expect(document.querySelectorAll('tr.group-row')).toHaveLength(2);
        expect(document.querySelectorAll('tr.subtotal-row')).toHaveLength(1);
        expect(workouts).toHaveBeenCalledTimes(requests);
        expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull();
    });

    it('keeps the table on screen while a sort fetches rows that are not loaded yet', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValueOnce({
            items: [ride('a', '2026-11-13', 10000), ride('b', '2026-11-12', 20000)],
            total: 3,
        });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');
        await findFooter();
        let finish!: (value: { items: WorkoutSummary[]; total: number }) => void;
        workouts.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        fireEvent.click(screen.getByRole('button', { name: /^Distance/ }));
        expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'distance', offset: 0 }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(screen.queryByRole('status', { name: 'Loading workouts' })).toBeNull();
        expect(document.querySelectorAll('tbody td[data-label="Distance"]')[0]).toHaveTextContent('12.43 mi');
        await act(async () =>
            finish({ items: [ride('c', '2026-11-11', 30000), ride('b', '2026-11-12', 20000)], total: 3 })
        );
        expect(document.querySelectorAll('tbody td[data-label="Distance"]')[0]).toHaveTextContent('18.64 mi');
    });
    it('restores a saved sort and ignores an invalid one', async () => {
        localStorage.setItem('fittrack_workout_sort', JSON.stringify({ key: 'wkg', order: 'asc' }));
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        const { unmount } = renderAt('/workouts');
        await waitFor(() =>
            expect(workouts).toHaveBeenCalledWith(expect.objectContaining({ sort: 'wkg', order: 'asc' }))
        );
        unmount();
        localStorage.setItem('fittrack_workout_sort', JSON.stringify({ key: 'bogus', order: 'asc' }));
        renderAt('/workouts');
        await waitFor(() =>
            expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'date', order: 'desc' }))
        );
    });
});

describe('Workouts column views', () => {
    afterEach(() => vi.restoreAllMocks());

    const ride = (uuid: string, distance: number, watts: number | null, cadence: number): WorkoutSummary => ({
        uuid,
        workout_type: 'Indoor Cycling',
        local_date: '2026-11-13',
        start_utc: `2026-11-13T1${uuid === 'a' ? 7 : 8}:00:00`,
        duration_sec: 1800,
        distance_m: distance,
        active_energy_kcal: 300,
        avg_hr: 130,
        max_hr: 150,
        average_watts: watts,
        watts_per_kg: watts == null ? null : watts / 84.2,
        average_cadence: cadence,
        elevation_gain_m: null,
        has_route: false,
    });
    const headers = () => screen.getAllByRole('columnheader').map((cell) => cell.textContent);

    it('opens on Ride, switches views and sizes bars against the best visible workout', async () => {
        localStorage.removeItem('fittrack_workout_view');
        vi.spyOn(api, 'workouts').mockResolvedValue({
            items: [ride('a', 20000, 200, 80), ride('b', 10000, null, 70)],
            total: 2,
        });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');
        await findFooter();
        expect(headers()).toEqual(['Time', 'Type', 'Duration', 'Distance', 'Avg pace', 'Active kcal', 'Avg HR']);
        const bars = [...document.querySelectorAll<HTMLElement>('td[data-label="Distance"] .metric-bar-track > span')];
        expect(bars.map((bar) => bar.style.width)).toEqual(['50%', '100%']);

        fireEvent.click(screen.getByRole('button', { name: 'Power' }));
        expect(headers()).toEqual(['Time', 'Type', 'Duration', 'Avg power', 'Avg W/kg', 'Cadence', 'Elev gain']);
        expect(document.querySelectorAll('td[data-label="Avg power"] .metric-bar')).toHaveLength(1);
        expect(localStorage.getItem('fittrack_workout_view')).toBe('power');
        await waitFor(() =>
            expect(api.saveWorkoutTable).toHaveBeenLastCalledWith({ view: 'power', sort: 'date', order: 'desc' })
        );
    });

    it('names a sort column the view hides and offers a return to date order', async () => {
        vi.spyOn(api, 'workouts').mockResolvedValue({
            items: [ride('a', 20000, 200, 70), ride('b', 10000, 150, 80)],
            total: 2,
        });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');
        await findFooter();
        fireEvent.click(screen.getByRole('button', { name: /^Cadence/ }));
        expect(screen.queryByText(/Sorted by/)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Ride' }));
        expect(screen.getByText(/Sorted by/)).toHaveTextContent('Sorted by Cadence (high to low)');
        const distances = () =>
            [...document.querySelectorAll('tbody td[data-label="Distance"]')].map((cell) => cell.textContent);
        expect(distances()).toEqual(['6.21 mi', '12.43 mi']);

        fireEvent.click(screen.getByRole('button', { name: 'Sort by date' }));
        expect(screen.queryByText(/Sorted by/)).toBeNull();
        expect(document.querySelectorAll('tr.group-row')).toHaveLength(1);
    });

    it('falls back to the server cookie when local storage has no view', async () => {
        localStorage.removeItem('fittrack_workout_view');
        document.cookie = 'fittrack_workout_view=power; Path=/';
        vi.spyOn(api, 'workouts').mockResolvedValue({ items: [ride('a', 20000, 200, 80)], total: 1 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        renderAt('/workouts');
        await findFooter();
        expect(screen.getByRole('button', { name: 'Power' })).toHaveAttribute('aria-pressed', 'true');
    });
});
