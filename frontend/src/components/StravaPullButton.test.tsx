import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StravaPullButton } from './StravaPullButton';
import { api, ApiError } from '../lib/api';

const { triggerRefresh } = vi.hoisted(() => ({ triggerRefresh: vi.fn() }));
vi.mock('../lib/refresh', () => ({ useRefreshBar: () => ({ triggerRefresh }) }));
vi.mock('../lib/dashboard', () => ({ useDashboard: () => ({ refresh: vi.fn() }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/' }) }));

describe('Strava pull', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
        triggerRefresh.mockReset();
    });

    it('blocks duplicate clicks and refreshes the active page after import', async () => {
        let complete!: (value: { workouts: number }) => void;
        const pull = vi.spyOn(api, 'pullStrava').mockReturnValue(new Promise((resolve) => (complete = resolve)));
        render(<StravaPullButton onAuthError={vi.fn()} />);
        const button = screen.getByRole('button', { name: 'Pull Strava data' });
        expect(button).toHaveTextContent('');
        expect(button).not.toHaveAttribute('title');
        expect(screen.queryByRole('tooltip')).toBeNull();
        fireEvent.click(button);
        fireEvent.click(button);
        expect(button).toBeDisabled();
        expect(button).toHaveClass('is-busy');
        expect(button).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('status')).toHaveTextContent('Pulling Strava data');
        expect(pull).toHaveBeenCalledTimes(1);
        complete({ workouts: 1 });
        await waitFor(() => expect(button).not.toBeDisabled());
        expect(button).not.toHaveClass('is-busy');
        expect(button).toHaveAttribute('aria-busy', 'false');
        expect(screen.getByRole('status')).toHaveTextContent('Imported 1 Strava ride.');
        expect(triggerRefresh).toHaveBeenCalledOnce();
    });

    it('reports an unchanged pull', async () => {
        vi.spyOn(api, 'pullStrava').mockResolvedValue({ workouts: 0 });
        render(<StravaPullButton onAuthError={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Pull Strava data' }));
        expect(await screen.findByText('Strava is up to date.')).toBeTruthy();
    });

    for (const workouts of [0, 2]) {
        it(`dismisses a successful ${workouts}-ride result after 5 seconds`, async () => {
            vi.useFakeTimers();
            vi.spyOn(api, 'pullStrava').mockResolvedValue({ workouts });
            render(<StravaPullButton onAuthError={vi.fn()} />);
            await act(async () => fireEvent.click(screen.getByRole('button')));
            expect(screen.getByRole('status')).toHaveTextContent(
                workouts ? 'Imported 2 Strava rides.' : 'Strava is up to date.'
            );
            act(() => vi.advanceTimersByTime(4999));
            expect(screen.getByRole('status')).toBeTruthy();
            act(() => vi.advanceTimersByTime(1));
            expect(screen.queryByRole('status')).toBeNull();
        });
    }

    it('cancels an old dismissal timer when another pull starts and keeps errors visible', async () => {
        vi.useFakeTimers();
        let reject!: (error: Error) => void;
        vi.spyOn(api, 'pullStrava')
            .mockResolvedValueOnce({ workouts: 0 })
            .mockReturnValueOnce(
                new Promise((_, rejectPull) => {
                    reject = rejectPull;
                })
            );
        render(<StravaPullButton onAuthError={vi.fn()} />);
        await act(async () => fireEvent.click(screen.getByRole('button')));
        act(() => vi.advanceTimersByTime(4000));
        fireEvent.click(screen.getByRole('button'));
        act(() => vi.advanceTimersByTime(10000));
        expect(screen.getByRole('status')).toHaveTextContent('Pulling Strava data...');
        await act(async () => reject(new Error('Strava unavailable')));
        act(() => vi.advanceTimersByTime(10000));
        expect(screen.getByRole('alert')).toHaveTextContent('Strava unavailable');
    });

    it('shows server errors and allows retry', async () => {
        vi.spyOn(api, 'pullStrava').mockRejectedValue(new ApiError(409, 'A Strava pull is already running.'));
        render(<StravaPullButton onAuthError={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Pull Strava data' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('already running');
        expect(screen.getByRole('button')).not.toBeDisabled();
        expect(triggerRefresh).not.toHaveBeenCalled();
    });

    it('returns to sign-in for an expired Access session', async () => {
        vi.spyOn(api, 'pullStrava').mockRejectedValue(new ApiError(401, 'Unauthorized'));
        const onAuthError = vi.fn();
        render(<StravaPullButton onAuthError={onAuthError} />);
        fireEvent.click(screen.getByRole('button'));
        await waitFor(() => expect(onAuthError).toHaveBeenCalledOnce());
    });
});
