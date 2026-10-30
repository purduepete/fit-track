import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import type { PointExclusion, WorkoutDetail } from '../lib/api';
import { formatLocalTime } from '../lib/format';
import { PointExclusions } from './PointExclusions';

function workout(): WorkoutDetail {
    const start = Date.parse('2026-10-24T00:00:00Z');
    const times = Array.from({ length: 45 }, (_, index) => new Date(start + index * 1000).toISOString().slice(0, 19));
    return {
        uuid: 'ride',
        workout_type: 'Indoor Cycling',
        local_date: '2026-10-23',
        start_utc: times[0],
        end_utc: times[44],
        duration_sec: 44,
        distance_m: 2000,
        active_energy_kcal: 125,
        avg_hr: 120,
        max_hr: 140,
        min_hr: 100,
        elevation_gain_m: 20,
        has_route: true,
        source_name: 'Strava',
        device_name: 'Zwift',
        splits: [],
        route: times.map((ts_utc, seq) => ({ seq, lat: 51.5, lon: -0.1, ts_utc, elevation_m: 100 + seq })),
        elevation_series: times.map((ts_utc, index) => ({ ts_utc, elevation_m: 100 + index })),
        hr_series: times.map((ts_utc, index) => ({ ts_utc, bpm: 120 + index })),
        data_points: times.map((ts_utc, index) => ({
            ts_utc,
            route_count: 1,
            elevation_m: [100 + index],
            speed_mps: [],
            heart_rate_bpm: [120 + index],
            distance_m: index * 100,
            distance_kind: 'cumulative',
            excluded: false,
        })),
        point_exclusions: [],
        route_total: 45,
        hr_total: 45,
        route_downsampled: false,
        hr_downsampled: false,
        prev_uuid: null,
        next_uuid: null,
    };
}

afterEach(() => vi.restoreAllMocks());

it('edits full-resolution whole points and restores matched and missing markers', async () => {
    const data = workout();
    const missing: PointExclusion = { ts_utc: '2026-10-24T00:03:00' };
    data.point_exclusions.push({ ...missing, matched: false });
    const load = vi.spyOn(api, 'workout').mockImplementation(async () => structuredClone(data));
    const exclude = vi.spyOn(api, 'excludePoint').mockImplementation(async (_uuid, ts_utc) => {
        data.data_points.find((item) => item.ts_utc === ts_utc)!.excluded = true;
        const marker = { ts_utc };
        data.point_exclusions.push({ ...marker, matched: true });
        return marker;
    });
    const restore = vi.spyOn(api, 'restorePoint').mockImplementation(async (_uuid, marker) => {
        data.point_exclusions = data.point_exclusions.filter((item) => item.ts_utc !== marker.ts_utc);
        const point = data.data_points.find((item) => item.ts_utc === marker.ts_utc);
        if (point) point.excluded = false;
        return { status: 'restored' };
    });
    const onChange = vi.fn();
    render(<PointExclusions workout={data} unit="mi" onChange={onChange} onAuthError={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    expect(screen.getByRole('dialog', { name: 'Workout data points' })).toBeVisible();
    expect(await screen.findByText('45 points. Times are local.')).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith('ride', true);
    expect(screen.getByRole('heading', { name: 'Missing source points' })).toBeInTheDocument();
    expect(screen.getAllByText('Route position')).toHaveLength(40);
    expect(screen.getByText('Heart rate 120 bpm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const firstOnSecondPage = within(screen.getByRole('table')).getAllByRole('checkbox')[0];
    expect(firstOnSecondPage).toBeChecked();
    fireEvent.click(firstOnSecondPage);
    await waitFor(() => expect(exclude).toHaveBeenCalledWith('ride', data.data_points[40].ts_utc));
    await waitFor(() => expect(firstOnSecondPage).not.toBeChecked());

    fireEvent.click(screen.getByRole('checkbox', { name: /Use missing point/ }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('ride', expect.objectContaining(missing)));
    await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Missing source points' })).not.toBeInTheDocument()
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find time or value' }), {
        target: { value: formatLocalTime(data.data_points[40].ts_utc, true) },
    });
    expect(screen.getByText('1 point found. Times are local.')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /Use point/ });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(onChange).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage points' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Use point/ })).toBeChecked());
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Use point/ })).toBeChecked());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage points' })).toHaveFocus();
});

it('shows load and save failures and permits a retry', async () => {
    const data = workout();
    vi.spyOn(api, 'workout').mockRejectedValueOnce(new Error('Could not load points')).mockResolvedValue(data);
    vi.spyOn(api, 'excludePoint').mockRejectedValue(new ApiError(403, 'Editing is not permitted'));
    const onChange = vi.fn();
    render(<PointExclusions workout={data} unit="km" onChange={onChange} onAuthError={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load points');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click((await screen.findAllByRole('checkbox', { name: /Use point/ }))[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Editing is not permitted');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
});
