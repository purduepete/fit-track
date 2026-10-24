import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Workouts } from './Workouts';
import { api } from '../lib/api';
import type { WorkoutSummary } from '../lib/api';

function renderAt(entry: string) {
    return render(
        <MemoryRouter initialEntries={[entry]}>
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
    });

    it('ignores a malformed date param (no date_to sent)', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);

        renderAt('/workouts?date=not-a-date');

        await waitFor(() => expect(workouts).toHaveBeenCalled());
        expect(workouts).toHaveBeenCalledWith(expect.objectContaining({ dateTo: undefined }));
        expect(screen.queryByText(/Showing workouts on/i)).not.toBeInTheDocument();
    });

    it('clears the day filter when Clear is clicked', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);

        renderAt('/workouts?date=2026-07-16');
        await waitFor(() => expect(screen.getByText(/Showing workouts on/i)).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /clear/i }));

        await waitFor(() => expect(screen.queryByText(/Showing workouts on/i)).not.toBeInTheDocument());
        // After clearing, the most recent call must not carry a date_to bound.
        expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining({ dateTo: undefined }));
    });
});

describe('Workouts type dropdown', () => {
    afterEach(() => vi.restoreAllMocks());

    it('refetches with the picked type', async () => {
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue(['Outdoor Walk', 'Running']);

        renderAt('/workouts');
        await waitFor(() => expect(workouts).toHaveBeenCalled());

        fireEvent.click(screen.getByLabelText('Workout type'));
        fireEvent.click(await screen.findByRole('option', { name: 'Running' }));

        await waitFor(() =>
            expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'Running', offset: 0 }))
        );
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
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
            has_route: false,
            ...overrides,
        });

        function setup(items: WorkoutSummary[], total = items.length) {
            vi.spyOn(api, 'workoutTypes').mockResolvedValue(['Indoor Cycling', 'Walking']);
            return vi.spyOn(api, 'workouts').mockResolvedValue({ items, total });
        }

        it('sums totals and calculates overall pace, duration-weighted HR and highest HR', async () => {
            setup([
                workout(),
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
            expect(cells).toEqual(['Visible totals', '2 workouts', '40m', '6.00 mi', '6:40/mi', '400', '130', '160']);
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
            ).toEqual(['Visible totals', '2 workouts', '10m', '1.00 mi', '—', '—', '—', '—']);
        });

        it('preserves zero totals and does not divide by zero', async () => {
            setup([workout({ duration_sec: 0, distance_m: 0, active_energy_kcal: 0 })]);
            renderAt('/workouts');
            const row = (await screen.findByText('Visible totals')).closest('tr')!;
            expect(
                within(row)
                    .getAllByRole('cell')
                    .map((cell) => cell.textContent)
            ).toEqual(['Visible totals', '1 workout', '0s', '0.00 mi', '—', '0', '—', '140']);
        });

        it('does not show a totals row for an empty range', async () => {
            setup([]);
            renderAt('/workouts');
            await screen.findByText(/No workouts in this range/);
            expect(screen.queryByText('Visible totals')).not.toBeInTheDocument();
        });
    });
});
