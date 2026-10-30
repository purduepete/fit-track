import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WorkoutDetail } from './WorkoutDetail';
import { api } from '../lib/api';
import type { WorkoutDetail as Detail } from '../lib/api';

vi.mock('../components/RouteMap', () => ({ RouteMap: () => <div>Route map</div> }));
// jsdom has no ResizeObserver, which ResponsiveContainer needs.
vi.mock('recharts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('recharts')>()),
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

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
        elevation_gain_m: null,
        has_route: true,
        source_name: 'Strava',
        device_name: 'Zwift',
        splits: [],
        route: [{ seq: 0, lat: 51.5, lon: -0.1, ts_utc: '2026-10-24T00:00:00', elevation_m: null }],
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
    // One route point with no altitude: no elevation chart and no gain.
    expect(screen.queryByRole('heading', { name: 'Elevation' })).not.toBeInTheDocument();
    expect(screen.getByText('Elevation gain').closest('.card')).toHaveTextContent('—');
});

it('shows elevation gain in feet and switches to meters with the km toggle', async () => {
    const split = (unit_system: string, split_index: number, elevation_gain_m: number | null) => ({
        split_index,
        unit_system,
        distance_m: unit_system === 'mi' ? 1609.344 : 1000,
        duration_sec: 300,
        pace_sec_per_unit: 300,
        avg_hr: null,
        elevation_gain_m,
        source: 'sample',
    });
    vi.spyOn(api, 'workout').mockResolvedValue({
        uuid: 'climb',
        workout_type: 'Indoor Cycling',
        local_date: '2026-10-23',
        start_utc: '2026-10-24T00:00:00',
        end_utc: '2026-10-24T00:10:00',
        duration_sec: 600,
        distance_m: 3218.688,
        active_energy_kcal: 125,
        avg_hr: null,
        max_hr: null,
        min_hr: null,
        elevation_gain_m: 100,
        has_route: true,
        source_name: 'Strava',
        device_name: 'Zwift',
        splits: [split('mi', 1, 60), split('mi', 2, 40), split('km', 1, 30)],
        route: [
            { seq: 0, lat: 51.5, lon: -0.1, ts_utc: '2026-10-24T00:00:00', elevation_m: 10 },
            { seq: 1, lat: 51.6, lon: -0.1, ts_utc: '2026-10-24T00:10:00', elevation_m: 110 },
        ],
        hr_series: [],
        route_total: 2,
        hr_total: 0,
        route_downsampled: false,
        hr_downsampled: false,
        prev_uuid: null,
        next_uuid: null,
    });
    render(
        <MemoryRouter initialEntries={['/workouts/climb']}>
            <Routes>
                <Route path="/workouts/:uuid" element={<WorkoutDetail onAuthError={() => {}} />} />
            </Routes>
        </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Elevation' })).toBeInTheDocument();
    expect(screen.getByText('Elevation gain').closest('.card')).toHaveTextContent('328 ft');
    expect(screen.getByRole('columnheader', { name: 'Elev' })).toBeInTheDocument();
    expect(screen.getByText('197 ft')).toBeInTheDocument();
    expect(screen.getByText(/Pace and elevation gain per mile/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'km' }));
    expect(screen.getByText('Elevation gain').closest('.card')).toHaveTextContent('100 m');
    expect(screen.getByText('30 m')).toBeInTheDocument();
});
