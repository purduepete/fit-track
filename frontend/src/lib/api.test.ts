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

describe('point exclusions', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('saves draft changes in one protected request', async () => {
        const spy = mockFetchOnce({ status: 'saved' });
        const changes = {
            exclude: [{ ts_utc: '2026-10-24T00:00:00' }],
            restore: [{ ts_utc: '2026-10-24T00:01:00' }],
        };
        await expect(api.savePointExclusions('strava:123', changes)).resolves.toEqual({ status: 'saved' });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(
            '/api/workouts/strava%3A123/point-exclusions/batch',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-FitTrack-Edit': '1' }),
                body: JSON.stringify(changes),
            })
        );
    });

    it('sends an exclusion request with edit protection', async () => {
        const spy = mockFetchOnce({});
        await api.excludePoint('strava:123', '2026-10-24T00:00:00');
        expect(spy).toHaveBeenCalledWith(
            '/api/workouts/strava%3A123/point-exclusions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-FitTrack-Edit': '1' }),
                body: JSON.stringify({ ts_utc: '2026-10-24T00:00:00' }),
            })
        );
    });

    it('restores by marker without sending the response-only matched flag', async () => {
        const spy = mockFetchOnce({ status: 'restored' });
        const point = { ts_utc: '2026-10-24T00:00:00' };
        const status = { ...point, matched: false };
        await api.restorePoint('strava:123', status);
        expect(spy).toHaveBeenCalledWith(
            '/api/workouts/strava%3A123/point-exclusions/restore',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'X-FitTrack-Edit': '1' }),
                body: JSON.stringify(point),
            })
        );
    });
});
