import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function mockFetchOnce(body: unknown) {
    const spy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(body),
    });
    vi.stubGlobal('fetch', spy);
    return spy;
}

describe('api.workouts query building', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('sends date_to when dateTo is provided (exact-day filter)', async () => {
        const spy = mockFetchOnce({ items: [], total: 0 });
        await api.workouts({ dateFrom: '2026-07-16', dateTo: '2026-07-16' });
        const url = spy.mock.calls[0][0] as string;
        expect(url).toContain('date_from=2026-07-16');
        expect(url).toContain('date_to=2026-07-16');
    });

    describe('Strava pull request', () => {
        afterEach(() => vi.unstubAllGlobals());

        it('uses POST with the required same-origin header', async () => {
            const spy = mockFetchOnce({ workouts: 1 });
            await expect(api.pullStrava()).resolves.toEqual({ workouts: 1 });
            expect(spy).toHaveBeenCalledWith(
                '/api/strava/pull',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({ 'X-FitTrack-Sync': '1' }),
                })
            );
        });

        it('preserves a safe server error for the button', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: false,
                    status: 502,
                    statusText: 'Bad Gateway',
                    json: () => Promise.resolve({ detail: 'Strava rate limit reached.' }),
                })
            );
            await expect(api.pullStrava()).rejects.toThrow('Strava rate limit reached.');
        });
    });

    it('omits date_to when not provided', async () => {
        const spy = mockFetchOnce({ items: [], total: 0 });
        await api.workouts({ dateFrom: '2026-06-01' });
        const url = spy.mock.calls[0][0] as string;
        expect(url).toContain('date_from=2026-06-01');
        expect(url).not.toContain('date_to');
    });
});
