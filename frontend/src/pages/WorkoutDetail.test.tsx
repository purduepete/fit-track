import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WorkoutDetail } from './WorkoutDetail';
import { api } from '../lib/api';
import type { WorkoutDetail as Detail } from '../lib/api';

vi.mock('../components/RouteMap', () => ({
    RouteMap: ({ route }: { route: unknown[] }) => <div data-route-count={route.length}>Route map</div>,
}));
// jsdom has no ResizeObserver, which ResponsiveContainer needs.
vi.mock('recharts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('recharts')>()),
    ResponsiveContainer: ({ children, height }: { children: React.ReactNode; height?: number | string }) => (
        <div data-chart-height={height}>{children}</div>
    ),
    LineChart: ({ data }: { data: unknown[] }) => <div data-chart-points={JSON.stringify(data)} />,
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
        point_exclusion_warning: 'Original distance samples are unavailable.',
        source_name: 'Strava',
        device_name: 'Zwift',
        splits: [],
        route: [
            {
                seq: 0,
                lat: 51.5,
                lon: -0.1,
                ts_utc: '2026-10-24T00:00:00',
                elevation_m: null,
            },
        ],
        elevation_series: [],
        hr_series: [],
        point_exclusions: [],
        data_points: [],
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
    const title = screen.getByRole('heading', { name: /Indoor Cycling/, level: 1 });
    const managePoints = screen.getByRole('button', { name: 'Manage points' });
    expect(title.closest('.workout-title-row')).toContainElement(managePoints);
    expect(managePoints).toHaveClass('icon-btn');
    expect(managePoints).toHaveAttribute('data-tip', 'Manage points');
    expect(managePoints.querySelector('svg')).toBeInTheDocument();
    expect(managePoints).toHaveTextContent('');
    expect(screen.queryByRole('heading', { name: 'Workout data points' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Original distance samples are unavailable.');
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
        elevation_series: [
            { ts_utc: '2026-10-24T00:00:00', elevation_m: 10 },
            { ts_utc: '2026-10-24T00:10:00', elevation_m: 110 },
        ],
        hr_series: [
            { ts_utc: '2026-10-24T00:00:00', bpm: 100 },
            { ts_utc: '2026-10-24T00:10:00', bpm: 120 },
        ],
        point_exclusions: [],
        data_points: [],
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
    expect(await screen.findByRole('heading', { name: 'Heart rate' })).toBeInTheDocument();
    const elevationCharts = screen.getByRole('heading', { name: 'Elevation' }).closest('.workout-chart-row');
    expect(elevationCharts).toHaveClass('workout-chart-row--paired');
    expect(screen.getByRole('heading', { name: 'Heart rate' }).closest('.workout-chart-row')).toBe(elevationCharts);
    for (const name of ['Elevation', 'Heart rate']) {
        expect(
            screen.getByRole('heading', { name }).closest('.section')?.querySelector('[data-chart-height]')
        ).toHaveAttribute('data-chart-height', '360');
    }
    expect(screen.getByText('Elevation gain').closest('.card')).toHaveTextContent('328 ft');
    expect(screen.getByRole('columnheader', { name: 'Elev' })).toBeInTheDocument();
    expect(screen.getByText('197 ft')).toBeInTheDocument();
    expect(screen.getByText(/Pace and elevation gain per mile/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'km' }));
    expect(screen.getByText('Elevation gain').closest('.card')).toHaveTextContent('100 m');
    expect(screen.getByText('30 m')).toBeInTheDocument();
});

it('refreshes the route, both charts, and summaries after excluding or restoring a whole point', async () => {
    const times = ['2026-10-24T00:00:00', '2026-10-24T00:05:00', '2026-10-24T00:10:00'];
    const original: Detail = {
        uuid: 'filtered',
        workout_type: 'Ride',
        local_date: '2026-10-23',
        start_utc: '2026-10-24T00:00:00',
        end_utc: '2026-10-24T00:10:00',
        duration_sec: 600,
        distance_m: 2000,
        active_energy_kcal: 125,
        avg_hr: 120,
        max_hr: 220,
        min_hr: 100,
        elevation_gain_m: 100,
        has_route: true,
        source_name: 'Strava',
        device_name: 'Zwift',
        splits: [],
        route: [
            { seq: 0, lat: 1, lon: 1, ts_utc: times[0], elevation_m: 10 },
            { seq: 1, lat: 2, lon: 2, ts_utc: times[1], elevation_m: 999 },
            { seq: 2, lat: 3, lon: 3, ts_utc: times[2], elevation_m: 20 },
        ],
        elevation_series: [
            { ts_utc: times[0], elevation_m: 10 },
            { ts_utc: times[1], elevation_m: 999 },
            { ts_utc: times[2], elevation_m: 20 },
        ],
        hr_series: [
            { ts_utc: times[0], bpm: 100 },
            { ts_utc: times[1], bpm: 220 },
            { ts_utc: times[2], bpm: 120 },
        ],
        point_exclusions: [],
        data_points: times.map((ts_utc, index) => ({
            ts_utc,
            route_count: 1,
            elevation_m: [index === 1 ? 999 : index === 0 ? 10 : 20],
            speed_mps: [],
            heart_rate_bpm: [index === 1 ? 220 : index === 0 ? 100 : 120],
            distance_m: index * 1000,
            distance_kind: 'cumulative',
            excluded: false,
        })),
        route_total: 3,
        hr_total: 3,
        route_downsampled: false,
        hr_downsampled: false,
        prev_uuid: null,
        next_uuid: null,
    };
    let detail = structuredClone(original);
    vi.spyOn(api, 'workout').mockImplementation(async () => structuredClone(detail));
    vi.spyOn(api, 'savePointExclusions').mockImplementation(async (_uuid, changes) => {
        if (changes.restore.length) {
            detail = structuredClone(original);
            return { status: 'saved' };
        }
        const ts_utc = changes.exclude[0].ts_utc;
        detail.route = detail.route.filter((point) => point.ts_utc !== ts_utc);
        detail.hr_series = detail.hr_series.filter((point) => point.ts_utc !== ts_utc);
        detail.elevation_series = detail.elevation_series.filter((point) => point.ts_utc !== ts_utc);
        detail.data_points.find((point) => point.ts_utc === ts_utc)!.excluded = true;
        detail.point_exclusions = [{ ts_utc, matched: true }];
        detail.avg_hr = 110;
        detail.max_hr = 120;
        detail.elevation_gain_m = 10;
        return { status: 'saved' };
    });
    render(
        <MemoryRouter initialEntries={['/workouts/filtered']}>
            <Routes>
                <Route path="/workouts/:uuid" element={<WorkoutDetail onAuthError={() => {}} />} />
            </Routes>
        </MemoryRouter>
    );

    function chartPoints(name: string) {
        const chart = screen.getByRole('heading', { name }).closest('.section')?.querySelector('[data-chart-points]');
        return JSON.parse(chart!.getAttribute('data-chart-points')!) as unknown[];
    }

    await screen.findByRole('heading', { name: 'Elevation' });
    expect(chartPoints('Elevation')).toHaveLength(3);
    expect(chartPoints('Heart rate')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    fireEvent.click((await screen.findAllByRole('checkbox', { name: /Use point/ }))[1]);
    expect(chartPoints('Elevation')).toHaveLength(3);
    expect(chartPoints('Heart rate')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(chartPoints('Elevation')).toHaveLength(2));
    expect(chartPoints('Heart rate')).toHaveLength(2);
    expect(screen.getByText('Route map')).toHaveAttribute('data-route-count', '2');
    expect(screen.getByText('Avg / Max HR').closest('.card')).toHaveTextContent('110 / 120');
    expect(screen.getByText('Elevation gain').closest('.card')).toHaveTextContent('33 ft');

    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    fireEvent.click((await screen.findAllByRole('checkbox', { name: /Use point/ }))[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(chartPoints('Elevation')).toHaveLength(3));
    expect(chartPoints('Heart rate')).toHaveLength(3);
    expect(screen.getByText('Route map')).toHaveAttribute('data-route-count', '3');
    expect(screen.getByText('Avg / Max HR').closest('.card')).toHaveTextContent('120 / 220');
    expect(screen.getByText('Elevation gain').closest('.card')).toHaveTextContent('328 ft');
});

it('opens a fresh point editor when navigating to another workout', async () => {
    const makeWorkout = (uuid: string, bpm: number): Detail => ({
        uuid,
        workout_type: uuid,
        local_date: '2026-10-23',
        start_utc: '2026-10-24T00:00:00',
        end_utc: '2026-10-24T00:10:00',
        duration_sec: 600,
        distance_m: null,
        active_energy_kcal: null,
        avg_hr: bpm,
        max_hr: bpm,
        min_hr: bpm,
        elevation_gain_m: null,
        has_route: false,
        source_name: null,
        device_name: null,
        splits: [],
        route: [],
        elevation_series: [],
        hr_series: [{ ts_utc: '2026-10-24T00:00:00', bpm }],
        data_points: [
            {
                ts_utc: '2026-10-24T00:00:00',
                route_count: 0,
                elevation_m: [],
                speed_mps: [],
                heart_rate_bpm: [bpm],
                distance_m: null,
                distance_kind: null,
                excluded: false,
            },
        ],
        point_exclusions: [],
        route_total: 0,
        hr_total: 1,
        route_downsampled: false,
        hr_downsampled: false,
        prev_uuid: uuid === 'second' ? 'first' : null,
        next_uuid: uuid === 'first' ? 'second' : null,
    });
    const workouts: Record<string, Detail> = { first: makeWorkout('first', 111), second: makeWorkout('second', 122) };
    vi.spyOn(api, 'workout').mockImplementation(async (uuid) => {
        const workout = workouts[uuid];
        if (!workout) throw new Error(`Unknown workout ${uuid}`);
        return structuredClone(workout);
    });
    const save = vi.spyOn(api, 'savePointExclusions').mockResolvedValue({ status: 'saved' });
    render(
        <MemoryRouter initialEntries={['/workouts/first']}>
            <Routes>
                <Route path="/workouts/:uuid" element={<WorkoutDetail onAuthError={() => {}} />} />
            </Routes>
        </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Manage points' }));
    expect(await screen.findByText('Heart rate 111 bpm')).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Cancel' });
    done.focus();
    fireEvent.keyDown(done, { key: 'ArrowRight' });
    expect(screen.queryByRole('heading', { name: /second/ })).not.toBeInTheDocument();
    fireEvent.click(done);
    fireEvent.click(screen.getByRole('button', { name: 'Newer workout' }));
    expect(await screen.findByRole('heading', { name: /second/ })).toBeInTheDocument();
    expect(screen.queryByText('Heart rate 111 bpm')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    expect(await screen.findByText('Heart rate 122 bpm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Use point/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
        expect(save).toHaveBeenCalledWith('second', {
            exclude: [{ ts_utc: '2026-10-24T00:00:00' }],
            restore: [],
        })
    );
});
