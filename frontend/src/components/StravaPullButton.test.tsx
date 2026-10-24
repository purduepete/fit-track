import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StravaPullButton } from './StravaPullButton';
import { api, ApiError } from '../lib/api';

const { triggerRefresh } = vi.hoisted(() => ({ triggerRefresh: vi.fn() }));
vi.mock('../lib/refresh', () => ({ useRefreshBar: () => ({ triggerRefresh }) }));

describe('Strava pull', () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        triggerRefresh.mockReset();
    });

    it('blocks duplicate clicks and refreshes the active page after import', async () => {
        let complete!: (value: { workouts: number }) => void;
        const pull = vi.spyOn(api, 'pullStrava').mockReturnValue(new Promise((resolve) => (complete = resolve)));
        render(<StravaPullButton onAuthError={vi.fn()} />);
        const button = screen.getByRole('button', { name: 'Pull Strava data' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(button).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent('Pulling Strava data');
        expect(pull).toHaveBeenCalledTimes(1);
        complete({ workouts: 1 });
        await waitFor(() => expect(button).not.toBeDisabled());
        expect(screen.getByRole('status')).toHaveTextContent('Imported 1 Strava ride.');
        expect(triggerRefresh).toHaveBeenCalledOnce();
    });

    it('reports an unchanged pull', async () => {
        vi.spyOn(api, 'pullStrava').mockResolvedValue({ workouts: 0 });
        render(<StravaPullButton onAuthError={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Pull Strava data' }));
        expect(await screen.findByText('Strava is up to date.')).toBeTruthy();
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
