import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import type { PointExclusion, WorkoutDetail } from '../lib/api';
import { formatLocalTime } from '../lib/format';
import { PointExclusions } from './PointExclusions';

function workout(): WorkoutDetail {
    const start = Date.parse('2026-10-24T00:00:00Z');
    const times = Array.from({ length: 85 }, (_, index) => new Date(start + index * 1000).toISOString().slice(0, 19));
    return {
        uuid: 'ride',
        workout_type: 'Indoor Cycling',
        local_date: '2026-10-23',
        start_utc: times[0],
        end_utc: times[84],
        duration_sec: 84,
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
        route_total: 85,
        hr_total: 85,
        route_downsampled: false,
        hr_downsampled: false,
        prev_uuid: null,
        next_uuid: null,
    };
}

afterEach(() => vi.restoreAllMocks());

it('keeps edits across arrow pagination and saves only the final changes together', async () => {
    const data = workout();
    const missing: PointExclusion = { ts_utc: '2026-10-24T00:03:00' };
    data.point_exclusions.push({ ...missing, matched: false });
    const load = vi.spyOn(api, 'workout').mockImplementation(async () => structuredClone(data));
    const save = vi.spyOn(api, 'savePointExclusions').mockResolvedValue({ status: 'saved' });
    const exclude = vi.spyOn(api, 'excludePoint');
    const restore = vi.spyOn(api, 'restorePoint');
    const onChange = vi.fn();
    render(<PointExclusions workout={data} unit="mi" onChange={onChange} onAuthError={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    expect(screen.getByRole('dialog', { name: 'Workout data points' })).toBeVisible();
    expect(await screen.findByText('85 points. Times are local.')).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith('ride', true);
    expect(screen.getByRole('heading', { name: 'Missing source points' })).toBeInTheDocument();
    expect(screen.getAllByText('Route position')).toHaveLength(40);
    expect(screen.getByText('Heart rate 120 bpm')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const firstOnSecondPage = within(screen.getByRole('table')).getAllByRole('checkbox')[0];
    expect(firstOnSecondPage).toBeChecked();
    fireEvent.click(firstOnSecondPage);
    expect(firstOnSecondPage).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeDisabled();
    fireEvent.click(within(screen.getByRole('table')).getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    const reverted = within(screen.getByRole('table')).getAllByRole('checkbox')[0];
    expect(reverted).not.toBeChecked();
    fireEvent.click(reverted);
    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('table')).getAllByRole('checkbox')[0]);

    fireEvent.click(screen.getByRole('checkbox', { name: /Use missing point/ }));
    expect(screen.getByRole('checkbox', { name: /Use missing point/ })).toBeChecked();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find time or value' }), {
        target: { value: formatLocalTime(data.data_points[0].ts_utc, true) },
    });
    expect(screen.getByText('1 point found. Times are local.')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: /Use point/ });
    expect(checkbox).not.toBeChecked();
    expect(save).not.toHaveBeenCalled();
    expect(exclude).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('ride', {
        exclude: [{ ts_utc: data.data_points[80].ts_utc }, { ts_utc: data.data_points[0].ts_utc }],
        restore: [missing],
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Manage points' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
});

it('protects unsaved changes from dismissal and discards them with Cancel', async () => {
    vi.spyOn(api, 'workout').mockResolvedValue(workout());
    const save = vi.spyOn(api, 'savePointExclusions').mockResolvedValue({ status: 'saved' });
    render(<PointExclusions workout={workout()} unit="mi" onChange={vi.fn()} onAuthError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    const first = (await screen.findAllByRole('checkbox'))[0];
    fireEvent.click(first);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    fireEvent.click(screen.getByRole('dialog'), { clientX: -1 });
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(first).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    expect((await screen.findAllByRole('checkbox'))[0]).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage points' })).toHaveFocus();
});

it('shows load errors and retains unsaved edits after a failed save for retry', async () => {
    const data = workout();
    vi.spyOn(api, 'workout').mockRejectedValueOnce(new Error('Could not load points')).mockResolvedValue(data);
    const save = vi
        .spyOn(api, 'savePointExclusions')
        .mockRejectedValueOnce(new ApiError(403, 'Editing is not permitted'))
        .mockResolvedValue({ status: 'saved' });
    const onChange = vi.fn();
    render(<PointExclusions workout={data} unit="km" onChange={onChange} onAuthError={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load points');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click((await screen.findAllByRole('checkbox', { name: /Use point/ }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Editing is not permitted');
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
});

it('prevents editing and dismissal while a save is pending', async () => {
    vi.spyOn(api, 'workout').mockResolvedValue(workout());
    let finish!: (value: { status: string }) => void;
    vi.spyOn(api, 'savePointExclusions').mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        })
    );
    render(<PointExclusions workout={workout()} unit="mi" onChange={vi.fn()} onAuthError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage points' }));
    fireEvent.click((await screen.findAllByRole('checkbox'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.getByRole('dialog')).toBeVisible();
    await act(async () => finish({ status: 'saved' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
