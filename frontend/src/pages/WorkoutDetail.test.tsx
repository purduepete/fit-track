import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WorkoutDetail } from './WorkoutDetail';
import { api } from '../lib/api';
import type { WorkoutDetail as Detail } from '../lib/api';

vi.mock('../components/RouteMap', () => ({ RouteMap: () => <div>Route map</div> }));

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem('fittrack:full-res');
});

it('automatically loads sampled data and shows the map without resolution controls', async () => {
    localStorage.setItem('fittrack:full-res', '1');
    const detail: Detail = {
        uuid: 'strava:123',
        workout_type: 'Indoor Cycling',
        local_date: '2026-10-23',
        start_utc: '2026-10-24T00:00:00',
        end_utc: '2026-10-24T00:10:00',
        duration_sec: 600,
        distance_m: 2000,
        active_energy_kcal: 125,
        avg_hr: null,
        max_hr: null,
        min_hr: null,
        has_route: true,
        source_name: 'Strava',
        device_name: 'Zwift',
        splits: [],
        route: [{ seq: 0, lat: 51.5, lon: -0.1, ts_utc: '2026-10-24T00:00:00' }],
        hr_series: [],
        route_total: 2865,
        hr_total: 2865,
        route_downsampled: true,
        hr_downsampled: true,
        prev_uuid: null,
        next_uuid: null,
    };
    const workout = vi.spyOn(api, 'workout').mockResolvedValue(detail);
    render(
        <MemoryRouter initialEntries={['/workouts/strava:123']}>
            <Routes>
                <Route path="/workouts/:uuid" element={<WorkoutDetail onAuthError={() => {}} />} />
            </Routes>
        </MemoryRouter>
    );
    expect(await screen.findByText('Route map')).toBeInTheDocument();
    expect(workout).toHaveBeenCalledWith('strava:123');
    expect(screen.queryByText(/resolution|simplified view|route points/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Virtual Zwift route' })).toBeInTheDocument();
});
